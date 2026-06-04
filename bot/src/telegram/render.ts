import { InlineKeyboard } from "grammy";
import { CANCELABLE_STATUSES, type Job, type JobStatus } from "../db.js";
import { escapeHtml, progressBar, truncate } from "../util/format.js";

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "⏳ в очереди",
  downloading: "⬇️ скачивание",
  processing: "⚙️ обработка",
  moving: "📦 перенос в библиотеку",
  scanning: "🔄 обновление библиотеки",
  done: "✅ готово",
  failed: "❌ ошибка",
  canceled: "🚫 отменено",
};

/** `Youtube · Some title` — the first line of every status message. */
function headerLine(job: Job): string {
  const title = truncate(job.title ?? job.url, 120);
  const name = job.title ? `<b>${escapeHtml(title)}</b>` : escapeHtml(title);
  return job.source ? `${escapeHtml(job.source)} · ${name}` : name;
}

/** `⬇️ скачивание  [▓▓▓▓░░░░ 52%]  3.1MB/s  ETA 00:41` (spec §10.3). */
function statusLine(job: Job): string {
  const parts: string[] = [STATUS_LABEL[job.status]];

  if (job.status === "downloading") {
    parts.push(`[${progressBar(job.progress)} ${Math.floor(job.progress)}%]`);
    if (job.speed) parts.push(escapeHtml(job.speed));
    if (job.eta) parts.push(`ETA ${escapeHtml(job.eta)}`);
  }
  if (job.mode === "audio") parts.push("🎵 аудио");

  return parts.join("  ");
}

/**
 * Full text of the per-job status message. It is edited in place on every
 * state change, so all states render through this one function.
 */
export function renderJobMessage(job: Job, deepLink?: string | null): string {
  const lines = [headerLine(job), statusLine(job)];

  if (job.status === "failed" && job.error) {
    lines.push(`<i>${escapeHtml(truncate(job.error, 400))}</i>`);
  }
  if (job.status === "done") {
    const title = escapeHtml(truncate(job.title ?? job.url, 120));
    lines.push(
      deepLink
        ? `В библиотеке: <a href="${escapeHtml(deepLink)}">${title}</a>`
        : `В библиотеке: ${title}`,
    );
  }

  return lines.join("\n");
}

/** `Отмена` button while the job can still be canceled; nothing afterwards. */
export function jobKeyboard(job: Job): InlineKeyboard | undefined {
  if (!CANCELABLE_STATUSES.includes(job.status)) return undefined;
  return new InlineKeyboard().text("Отмена", `cancel:${job.id}`);
}

/** Aggregated `/queue` view: one line per active job. */
export function renderQueueList(jobs: Job[]): string {
  if (jobs.length === 0) return "Очередь пуста.";

  const lines = jobs.map((job) => {
    const title = escapeHtml(truncate(job.title ?? job.url, 60));
    const status = STATUS_LABEL[job.status];
    const percent =
      job.status === "downloading" ? ` ${Math.floor(job.progress)}%` : "";
    return `#${job.id} · ${title}\n    ${status}${percent}`;
  });

  return `<b>Очередь (${jobs.length}):</b>\n${lines.join("\n")}`;
}

export function renderHelp(audioModeEnabled: boolean): string {
  const lines = [
    "Пришли ссылку на видео (можно несколько в одном сообщении) — я скачаю его в максимальном качестве и добавлю в Jellyfin.",
    "",
    "Команды:",
    "/queue — список активных задач",
    "/cancel &lt;id&gt; — отменить задачу по id",
  ];
  if (audioModeEnabled) {
    lines.push("/audio &lt;ссылка&gt; — скачать только аудио (opus)");
  }
  return lines.join("\n");
}
