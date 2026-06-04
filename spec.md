# Jellydrop

Telegram → yt-dlp → Jellyfin: спецификация проекта

Приватный Telegram-бот для домашнего сервера. Принимает ссылки на видео/аудио,
скачивает их в максимальном качестве через `yt-dlp`, складывает в библиотеку
Jellyfin с метаданными. Бот реагирует только на один разрешённый аккаунт.

Документ предназначен для реализации в Claude Code. Прозаические пояснения — на
русском; все идентификаторы, команды, схемы и код — на английском.

---

## 1. Зафиксированные решения

| Параметр | Значение |
|---|---|
| Backend | Node.js + TypeScript |
| Telegram-библиотека | grammY (TS-first, long polling) |
| Загрузчик | `yt-dlp` (запуск через `spawn`) + `ffmpeg` |
| База данных | SQLite через `better-sqlite3` (один файл на volume) |
| Очередь | внутрипроцессный пул воркеров, **конкурентность 2** |
| Раскладка файлов | **одна общая библиотека**, схема staging → final |
| Доступ к Telegram | **long polling** (никаких webhook / публичных портов) |
| Авторизация | один разрешённый `ALLOWED_TELEGRAM_USER_ID` |
| Оркестрация | Docker Compose: сервисы `bot` + `jellyfin` |

Опциональные фичи (по умолчанию выключены, см. §13): только-аудио, cookies,
автоочистка, deep-link на карточку Jellyfin.

pnpm for dependencies.

---

## 2. Поток работы (happy path)

1. Пользователь шлёт сообщение, содержащее одну или несколько ссылок.
2. Бот извлекает все URL из текста, на каждый создаёт `job` в БД (один общий
   `batch_id`) и отправляет **отдельное статус-сообщение на каждую задачу** с
   кнопкой `Отмена`.
3. Воркер-пул (макс. 2 одновременно) берёт задачи из очереди:
    - **probe**: `yt-dlp --dump-single-json --no-download` → получаем `title`,
      `extractor`, длительность, признак плейлиста. Невалидные/неподдерживаемые
      ссылки сразу падают в `failed` с понятным сообщением.
    - **download**: качаем в `STAGING_DIR` с прогрессом, который парсится и
      раз в `PROGRESS_EDIT_INTERVAL_MS` пишется в статус-сообщение (редактирование,
      не новое сообщение).
    - **finalize**: генерируем `.nfo` (nice-to-have), **атомарно переносим**
      медиафайл + сайдкары из `STAGING_DIR` в `LIBRARY_DIR` (`fs.rename`).
    - **scan**: дёргаем Jellyfin API на обновление библиотеки.
4. Статус-сообщение редактируется в финальное состояние (`done` / `failed` /
   `canceled`), кнопка `Отмена` убирается у завершённых.

---

## 3. Структура проекта

```
.
├── docker-compose.yml
├── .env.example
├── data/                      # монтируется в bot: sqlite + cookies (вне образа)
└── bot/
    ├── Dockerfile
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts           # bootstrap: config → db → recover → queue → bot.start()
        ├── config.ts          # парсинг и валидация env (падать при отсутствии обязательных)
        ├── db.ts              # better-sqlite3, миграции, типизированные запросы
        ├── queue.ts           # пул воркеров, конкурентность, машина состояний
        ├── downloader.ts      # probe + download через yt-dlp, парсинг прогресса, реестр процессов, cancel
        ├── jellyfin.ts        # генерация .nfo + Library refresh
        ├── telegram/
        │   ├── bot.ts         # grammY, auth-middleware
        │   ├── handlers.ts    # обработка сообщений (парсинг ссылок) и команд
        │   ├── callbacks.ts   # inline-кнопки (cancel)
        │   └── render.ts      # форматирование статус-сообщений + клавиатуры
        └── util/
            ├── links.ts       # извлечение URL из текста
            └── format.ts      # прогресс-бар, размеры, ETA
```

---

## 4. Модель данных (SQLite)

Один файл `DB_PATH`. Единственная таблица + индексы. `better-sqlite3`
синхронный — это нормально и удобно для одного пользователя.

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  url                TEXT    NOT NULL,
  mode               TEXT    NOT NULL DEFAULT 'video',     -- 'video' | 'audio'
  status             TEXT    NOT NULL DEFAULT 'queued',    -- см. машину состояний §6
  source             TEXT,                                  -- extractor_key, напр. 'Youtube'
  title              TEXT,                                  -- известен после probe
  progress           REAL    NOT NULL DEFAULT 0,            -- 0..100
  speed              TEXT,                                  -- транзиентно, для статуса
  eta                TEXT,                                  -- транзиентно, для статуса
  staging_path       TEXT,                                  -- путь к итоговому файлу в STAGING_DIR
  final_path         TEXT,                                  -- путь после переноса в LIBRARY_DIR
  error              TEXT,                                  -- текст ошибки при failed
  batch_id           TEXT    NOT NULL,                      -- группирует ссылки из одного сообщения
  tg_chat_id         INTEGER NOT NULL,
  tg_status_msg_id   INTEGER,                               -- id сообщения, которое редактируем
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  started_at         TEXT,
  finished_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_batch  ON jobs(batch_id);
```

Активные дочерние процессы `yt-dlp` (для отмены) живут в **in-memory** реестре
`Map<jobId, ChildProcess>`, не в БД. БД — источник правды по состоянию; реестр —
по живым процессам.

---

## 5. Очередь и пул воркеров

- Конкурентность из `DOWNLOAD_CONCURRENCY` (по умолчанию `2`).
- Можно реализовать руками (счётчик активных + выборка `WHERE status='queued'
  ORDER BY id LIMIT 1` в транзакции) или через `p-queue` с `concurrency`.
  Главное — БД остаётся источником правды.
- Воркер атомарно «забирает» задачу: `queued → downloading` в транзакции, чтобы
  две корутины не взяли одну и ту же.
- После завершения/ошибки/отмены воркер освобождает слот и берёт следующую.

### Восстановление после рестарта (resume)

При старте `index.ts` чинит «подвисшие» задачи **до** запуска воркеров:

- `downloading` / `processing` → сбросить в `queued`. `yt-dlp` при повторном
  запуске докачает по `.part` (флаг `--continue`).
- `tg_status_msg_id` остаётся валидным — продолжаем редактировать то же сообщение.
- Незавершённые файлы в `STAGING_DIR` не трогаем (нужны для докачки).

---

## 6. Машина состояний задачи

```
queued ─▶ downloading ─▶ processing ─▶ moving ─▶ scanning ─▶ done
   │            │
   │            └─▶ canceled         (по кнопке во время загрузки)
   └─▶ canceled                      (по кнопке пока в очереди)

любой шаг ─▶ failed                  (с заполнением jobs.error)
```

- `processing` — пост-обработка внутри yt-dlp (merge видео+аудио, embed
  метаданных/обложки). Отдельным кодом не управляется, но статус полезен в UI.
- `moving` — `fs.rename` staging → library.
- `scanning` — запрос на refresh библиотеки Jellyfin.

---

## 7. Скачивание (yt-dlp)

### 7.1 Probe (получение метаданных до загрузки)

```
yt-dlp --dump-single-json --no-download --no-warnings <URL>
```

Из JSON берём: `title`, `extractor_key` → `source`, `duration`, и проверяем
`_type`. Если `_type === 'playlist'` — по умолчанию (см. §13) обрабатывать как
**ошибку с пояснением** «это плейлист, пришли отдельные ссылки», либо включить
опциональную обработку плейлистов. Probe-JSON сохраняем в памяти задачи — он же
источник для `.nfo`, отдельный `--write-info-json` не нужен.

### 7.2 Download (видео, максимальное качество)

```
yt-dlp \
  -f "bv*+ba/b" \
  --merge-output-format mkv \
  --embed-metadata --embed-thumbnail --embed-chapters --embed-subs \
  --restrict-filenames \
  --no-playlist \
  --continue \
  --newline \
  --progress-template "DLPROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s" \
  -o "<STAGING_DIR>/%(title)s [%(id)s].%(ext)s" \
  <URL>
```

Пояснения:
- `bv*+ba/b` — лучшее видео + лучшее аудио, фолбэк на лучший единый файл.
- `mkv` — универсальный контейнер под любые кодеки (VP9/AV1 + Opus), Jellyfin
  играет нативно. Не использовать mp4 по умолчанию (ломается на части кодеков
  при merge).
- `ffmpeg` обязателен для merge и embed.
- Имя файла `%(title)s [%(id)s]` — `id` гарантирует уникальность.

### 7.3 Парсинг прогресса

- Запуск через `child_process.spawn` (не shell), аргументы массивом.
- Читать `stdout` построчно; строки с префиксом `DLPROG|` парсить на percent /
  speed / eta. Обновлять `jobs.progress/speed/eta` и (с троттлингом
  `PROGRESS_EDIT_INTERVAL_MS`, по умолчанию 3000 мс) редактировать статус-сообщение.
- Не редактировать сообщение чаще лимита Telegram — иначе `429`. Обновлять также
  по смене статуса, не только по таймеру.
- Код возврата `0` → успех; иначе `failed` с последними строками `stderr` в `error`.

### 7.4 Отмена

- `cancel(jobId)`:
    - если задача `queued` → пометить `canceled`, убрать из очереди.
    - если `downloading`/`processing` → взять процесс из in-memory реестра,
      послать `SIGTERM` (при необходимости `SIGKILL` по таймауту), пометить
      `canceled`, удалить частичные файлы (`.part`, итоговый) из `STAGING_DIR`.
    - в обоих случаях отредактировать статус-сообщение и убрать кнопку.

---

## 8. Перенос staging → final (критично)

- `STAGING_DIR` и `LIBRARY_DIR` **обязаны быть на одной файловой системе**
  (подкаталоги одного volume `/media`), иначе `fs.rename` не атомарен и
  превращается в copy+delete. В §11 volume смонтирован так, что это выполняется.
- Переносить **только после** полного завершения yt-dlp (включая merge/embed):
  итоговый медиафайл + сгенерированный `.nfo` + сайдкар-обложку (если есть).
- Это гарантирует, что Jellyfin никогда не увидит `.part` или промежуточный файл
  merge.

---

## 9. Метаданные и Jellyfin

### 9.1 Что доступно из yt-dlp

`--embed-metadata` пишет заголовок в контейнер (Jellyfin подхватит), а
`--embed-thumbnail` — обложку. Этого минимум достаточно. Остальное (теги,
канал, дата) Jellyfin из видео не читает.

### 9.2 Генерация `.nfo` (nice-to-have, включено)

Рядом с медиафайлом кладём `<basename>.nfo` в формате Jellyfin (`movie` nfo).
Маппинг из probe-JSON:

| Поле NFO | Источник из yt-dlp JSON |
|---|---|
| `<title>` | `title` |
| `<plot>` | `description` |
| `<studio>` | `uploader` / `channel` |
| `<premiered>` + `<year>` | `upload_date` (YYYYMMDD → YYYY-MM-DD) |
| `<tag>` (по одному на тег) | `tags` + `categories` |
| `<runtime>` (минуты) | `duration` |

Шаблон:

```xml
<?xml version="1.0" encoding="utf-8"?>
<movie>
  <title>{title}</title>
  <plot>{description}</plot>
  <studio>{uploader}</studio>
  <premiered>{YYYY-MM-DD}</premiered>
  <year>{YYYY}</year>
  <runtime>{minutes}</runtime>
  <tag>{tag1}</tag>
  <tag>{tag2}</tag>
</movie>
```

Все значения экранировать как XML. Если поле пустое — тег не выводить.

### 9.3 Обновление библиотеки

После переноса — глобальный refresh:

```
POST {JELLYFIN_URL}/Library/Refresh
Header: X-Emby-Token: {JELLYFIN_API_KEY}
```

API-ключ создаётся в Jellyfin: Dashboard → API Keys. Запрос идёт по внутренней
сети Compose (`http://jellyfin:8096`), наружу порт API не публикуется.

---

## 10. Telegram UX

### 10.1 Авторизация

Middleware первым в цепочке: если `ctx.from.id !== ALLOWED_TELEGRAM_USER_ID` —
**молча** игнорировать (без ответа). Свой id берётся у `@userinfobot`.
В `@BotFather` включить privacy mode.

### 10.2 Обработка ссылок

- Из любого текстового сообщения извлекать **все** URL (`util/links.ts`).
- На каждую ссылку — отдельный `job` с общим `batch_id` и отдельным
  статус-сообщением. Если ссылок несколько — первым опционально короткое
  «Добавлено N в очередь».
- Дубликат URL, уже находящийся в активной очереди — пропустить с пометкой
  (опционально).

### 10.3 Формат статус-сообщения (редактируется по месту)

```
<источник> · <title или URL>
<emoji статуса> <статус>  [▓▓▓▓░░░░ 52%]  3.1MB/s  ETA 00:41
```

Кнопка `Отмена` (inline) присутствует, пока задача в `queued`/`downloading`/
`processing`; после `done`/`failed`/`canceled` убирается. `done` — добавить
строку с названием в библиотеке (deep-link — опционально, §13).

### 10.4 Inline-кнопки (callbacks)

- `callback_data` формата `cancel:<jobId>`.
- Обработчик в `callbacks.ts` вызывает `cancel(jobId)` (§7.4), затем
  редактирует сообщение и отвечает `answerCallbackQuery`.

### 10.5 Команды

| Команда | Действие |
|---|---|
| `/queue` | агрегированный список активных и ожидающих задач (id, title, статус, %). Если пусто — «очередь пуста». |
| `/start` | короткая справка по использованию |
| `/cancel <id>` | альтернатива кнопке (отмена по id) |

---

## 11. Docker Compose

Ключевой момент — **один** volume `media`, чтобы staging и library лежали на
одной ФС (атомарный rename). Jellyfin монтирует его read-only.

```yaml
services:
  bot:
    build: ./bot
    env_file: .env
    volumes:
      - ./data:/data            # sqlite + cookies (опц.)
      - media:/media            # rw: /media/staging и /media/library
    depends_on:
      - jellyfin
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: "2.0"
          memory: 2g

  jellyfin:
    image: jellyfin/jellyfin
    volumes:
      - jellyfin-config:/config
      - jellyfin-cache:/cache
      - media:/media:ro         # библиотека Jellyfin указывает на /media/library
    ports:
      - "8096:8096"
    restart: unless-stopped

volumes:
  media:
  jellyfin-config:
  jellyfin-cache:
```

`STAGING_DIR=/media/staging`, `LIBRARY_DIR=/media/library`. Бот создаёт обе
папки при старте, если их нет. В Jellyfin завести одну библиотеку типа
**«Home Videos and Photos»** (или Movies с **выключенным** скачиванием
интернет-метаданных, чтобы не перетирать наши `.nfo`), путь — `/media/library`.

### Dockerfile (bot)

```dockerfile
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates curl python3 \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp как отдельный standalone-бинарник (легко обновлять через `yt-dlp -U`)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

CMD ["node", "dist/index.js"]
```

Примечание: `better-sqlite3` ставится с prebuilt-бинарём; если на целевой
архитектуре его нет, понадобятся `build-essential` + `python3` на этапе `npm ci`
(можно вынести в multi-stage builder).

Обновление yt-dlp (он часто ломается при изменениях YouTube): либо `yt-dlp -U`
по расписанию/при старте, либо пересборка образа.

---

## 12. Конфигурация (.env)

```
TELEGRAM_BOT_TOKEN=
ALLOWED_TELEGRAM_USER_ID=
JELLYFIN_URL=http://jellyfin:8096
JELLYFIN_API_KEY=

DOWNLOAD_CONCURRENCY=2
DB_PATH=/data/queue.db
STAGING_DIR=/media/staging
LIBRARY_DIR=/media/library
PROGRESS_EDIT_INTERVAL_MS=3000

# Опционально (см. §13)
COOKIES_FILE=/data/cookies.txt
MAX_FILESIZE=
ENABLE_AUDIO_MODE=false
ENABLE_AUTO_CLEANUP=false
CLEANUP_AFTER_DAYS=30
```

`config.ts` валидирует обязательные переменные и падает с понятной ошибкой при
их отсутствии.

---

## 13. Опциональные фичи (по умолчанию выключены)

- **Cookies** — если присутствует `COOKIES_FILE`, добавлять `--cookies <file>`
  ко всем вызовам yt-dlp (приватный/возрастной контент). Файл монтируется в
  `./data`, в образ не попадает.
- **Только-аудио** (`ENABLE_AUDIO_MODE`) — режим/кнопка: `-f "ba/b" -x
  --audio-format opus --embed-thumbnail`, складывать в подпапку/отдельную
  библиотеку при необходимости.
- **Автоочистка** (`ENABLE_AUTO_CLEANUP`) — периодически удалять из
  `LIBRARY_DIR` файлы старше `CLEANUP_AFTER_DAYS`.
- **Deep-link на карточку Jellyfin** — после scan запросить id добавленного
  элемента через Jellyfin API и вставить в финальное сообщение ссылку
  `{JELLYFIN_URL}/web/#/details?id=...`.
- **Лимит размера** (`MAX_FILESIZE`) — `--max-filesize`.
- **Обработка плейлистов** — по умолчанию плейлисты отклоняются с пояснением;
  при желании добавить флоу подтверждения/разворачивания в отдельные задачи.

---

## 14. Обработка ошибок и edge cases

- Неподдерживаемый/битый URL → `failed` с человекочитаемым сообщением.
- Несколько ссылок в сообщении → N задач (общий `batch_id`).
- Отмена во время загрузки → kill процесса + удаление частичных файлов.
- Отмена в очереди → задача снимается, слот не занимается.
- Рестарт бота на середине → resume (§5).
- Лимит Telegram на редактирование → троттлинг (§7.3).
- Нет места на диске → `failed`, очередь продолжает работать.
- Сообщение не от разрешённого пользователя → игнор без ответа.
- Jellyfin недоступен на этапе scan → задача всё равно `done` (файл на месте),
  но залогировать предупреждение; refresh повторить при следующем запуске.

---

## 15. Критерии приёмки

1. Отправка одной поддерживаемой ссылки → появляется статус-сообщение, прогресс
   обновляется в нём же, по завершении файл доступен в Jellyfin с корректным
   названием и обложкой.
2. Отправка сообщения с 3 ссылками → создаются 3 задачи; максимум 2 качаются
   одновременно, третья ждёт.
3. Кнопка `Отмена` снимает задачу как в очереди, так и во время загрузки;
   частичные файлы не попадают в библиотеку.
4. `/queue` показывает актуальный список активных и ожидающих задач.
5. Рестарт контейнера во время загрузки → задача докачивается, а не теряется.
6. Сообщение от чужого аккаунта игнорируется без ответа.
7. В `LIBRARY_DIR` никогда не появляются `.part`/промежуточные файлы.
8. Для задачи с метаданными создаётся валидный `.nfo`, и Jellyfin показывает
   теги/студию/дату в карточке.
