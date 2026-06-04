# Jellydrop

Приватный Telegram-бот для домашнего сервера: присылаешь ссылку на видео — бот
скачивает его в максимальном качестве через `yt-dlp` и кладёт в библиотеку
[Jellyfin](https://jellyfin.org/) с метаданными (`.nfo`, обложка, главы,
субтитры). Реагирует только на один разрешённый Telegram-аккаунт, наружу не
торчит ни одного порта (long polling).

```
Telegram ──ссылка──▶ bot ──yt-dlp──▶ /media/staging ──atomic rename──▶ /media/library ──▶ Jellyfin
```

## Возможности

- **Очередь с прогрессом** — на каждую ссылку отдельное статус-сообщение,
  которое редактируется на месте: прогресс-бар, скорость, ETA, кнопка «Отмена»
- **Несколько ссылок одним сообщением** — каждая становится отдельной задачей,
  качаются максимум две одновременно
- **Максимальное качество** — `bv*+ba/b`, merge в mkv, встроенные метаданные,
  обложка, главы и субтитры + `.nfo` для карточки Jellyfin
- **Дедупликация** — повторная ссылка не качается, пока файл лежит в
  библиотеке; удалил файл — скачается заново
- **Авто-ретраи** — rate-limit / сеть / 5xx ретраятся с нарастающей задержкой
  (10м → 30м → 1ч → 2ч, до 5 попыток), докачка продолжается с места обрыва
- **Переживает рестарты** — прерванные загрузки возвращаются в очередь и
  докачиваются (`--continue`), статус-сообщения продолжают редактироваться
- **Атомарная доставка** — Jellyfin никогда не видит `.part` и недокачанные
  файлы: всё переносится одним `fs.rename` внутри одного тома
- Опционально: режим только-аудио (`/audio`), cookies для приватного контента,
  автоочистка старых файлов, deep-link на карточку Jellyfin

## Стек

Node.js 22 + TypeScript (ESM) · [grammY](https://grammy.dev/) ·
[Prisma 7](https://www.prisma.io/) + SQLite (better-sqlite3 driver adapter) ·
pnpm · Docker Compose · yt-dlp + ffmpeg

## Запуск (прод, Docker Compose)

1. Создай бота у [@BotFather](https://t.me/BotFather), включи privacy mode.
   Свой numeric id спроси у [@userinfobot](https://t.me/userinfobot).

2. Заполни `.env` (см. `.env.example`):

   ```env
   TELEGRAM_BOT_TOKEN=123456:ABC...
   ALLOWED_TELEGRAM_USER_ID=123456789
   JELLYFIN_API_KEY=          # можно добавить после настройки Jellyfin
   ```

3. Подними сервисы:

   ```sh
   docker compose up -d --build
   # или образ из CI вместо локальной сборки:
   docker compose pull bot && docker compose up -d
   ```

4. Настрой Jellyfin на `http://<сервер>:8096`: мастер первого запуска →
   библиотека типа **Home Videos and Photos** (или Movies с выключенными
   интернет-метаданными, чтобы не перетирать `.nfo`) с путём `/media/library` →
   Dashboard → API Keys → ключ в `JELLYFIN_API_KEY` → `docker compose up -d`.

Образ собирается CI (`.github/workflows/bot-image.yml`) в
`ghcr.io/sabbaken/jellydrop-bot` (amd64 + arm64) на каждый push в master.

## Разработка

Jellyfin в Docker, бот на хосте в watch-режиме (нужны `yt-dlp` и `ffmpeg`,
например `brew install yt-dlp ffmpeg`):

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d jellyfin
./dev.sh    # миграции + tsx watch; БД и файлы — в ./data
```

Прочее:

```sh
pnpm typecheck                  # prisma generate + tsc --noEmit
pnpm -C bot migrate:dev         # новая миграция после правки schema.prisma
```

## Команды бота

| Команда | Действие |
|---|---|
| просто ссылка(и) | скачать видео, по задаче на каждую ссылку |
| `/queue` | список активных и ожидающих задач |
| `/cancel <id>` | отменить задачу (или кнопка «Отмена» в статусе) |
| `/audio <ссылка>` | только аудио в opus (если `ENABLE_AUDIO_MODE=true`) |
| `/start` | справка |

## Конфигурация

Обязательные: `TELEGRAM_BOT_TOKEN` (алиас `TG_BOT_SECRET`),
`ALLOWED_TELEGRAM_USER_ID`. Остальные — со значениями по умолчанию, полный
список с комментариями в [.env.example](.env.example). Ключевые:

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `JELLYFIN_API_KEY` | — | без него пропускается только refresh библиотеки |
| `DOWNLOAD_CONCURRENCY` | `2` | одновременных загрузок |
| `MAX_FILESIZE` | — | лимит размера (синтаксис yt-dlp, напр. `2G`) |
| `COOKIES_FILE` | — | Netscape-cookies для приватного/возрастного контента |
| `ENABLE_AUDIO_MODE` | `false` | команда `/audio` |
| `ENABLE_AUTO_CLEANUP` | `false` | удалять файлы старше `CLEANUP_AFTER_DAYS` |
| `ENABLE_JELLYFIN_DEEPLINK` | `false` | ссылка на карточку в финальном сообщении |

## Устройство

```
bot/src/
├── index.ts          # bootstrap: config → db → recovery → queue → long polling
├── config.ts         # валидация env, понятные ошибки при старте
├── db.ts             # Prisma-стор: атомарные переходы статусов, recovery, retry
├── queue.ts          # пул воркеров, машина состояний, бэкофф-ретраи, cancel
├── downloader.ts     # yt-dlp: probe/download, прогресс, классификация ошибок
├── jellyfin.ts       # .nfo + Library/Refresh + deep-link
├── cleanup.ts        # опциональная автоочистка библиотеки
└── telegram/         # grammY: auth, handlers, callbacks, троттлинг статусов
```

Состояния задачи: `queued → downloading → processing → moving → scanning →
done` (+ `failed`/`canceled`; временные сбои возвращают в `queued` с
`retry_at`). БД — единственный источник правды; `STAGING_DIR` и `LIBRARY_DIR`
обязаны жить на одной файловой системе ради атомарного rename (compose это
гарантирует одним томом `media`).

Подробная спецификация — в [spec.md](spec.md).
