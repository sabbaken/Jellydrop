import { randomUUID } from "node:crypto";
import type { Bot, Context } from "grammy";
import type { Config } from "../config.js";
import type { JobMode, JobStore } from "../db.js";
import type { DownloadQueue } from "../queue.js";
import { extractUrls } from "../util/links.js";
import { jobKeyboard, renderHelp, renderJobMessage, renderQueueList } from "./render.js";

export interface BotDeps {
  store: JobStore;
  queue: DownloadQueue;
  config: Config;
}

const CANCEL_REPLIES: Record<string, string> = {
  canceled: "Отменено.",
  too_late: "Уже не отменить — задача завершена.",
  not_found: "Задача не найдена.",
};

/**
 * One job + one status message per link (spec §10.2). All links from one
 * message share a batch_id; URLs already in the active queue are skipped.
 */
async function enqueueLinks(
  ctx: Context,
  urls: string[],
  mode: JobMode,
  { store, queue }: BotDeps,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const fresh: string[] = [];
  let skipped = 0;
  for (const url of urls) {
    if (await store.findActiveByUrl(url)) skipped += 1;
    else fresh.push(url);
  }

  const notes: string[] = [];
  if (fresh.length > 1) notes.push(`Добавлено ${fresh.length} в очередь.`);
  if (skipped > 0) notes.push(`Пропущено (уже в очереди): ${skipped}.`);
  if (notes.length > 0) await ctx.reply(notes.join(" "));
  if (fresh.length === 0) return;

  const batchId = randomUUID();
  for (const url of fresh) {
    const job = await store.createJob({ url, mode, batchId, chatId });
    try {
      const message = await ctx.reply(renderJobMessage(job), {
        parse_mode: "HTML",
        reply_markup: jobKeyboard(job),
        link_preview_options: { is_disabled: true },
      });
      await store.updateJob(job.id, { tgStatusMsgId: message.message_id });
    } catch (err) {
      // The job still runs; there is just no live status message to edit.
      console.warn(`[telegram] failed to send status message for job ${job.id}: ${String(err)}`);
    }
  }
  queue.notify();
}

export function registerHandlers(bot: Bot, deps: BotDeps): void {
  const { store, queue, config } = deps;

  bot.command("start", (ctx) =>
    ctx.reply(renderHelp(config.enableAudioMode), { parse_mode: "HTML" }),
  );

  bot.command("queue", async (ctx) => {
    const jobs = await store.listActive();
    await ctx.reply(renderQueueList(jobs), { parse_mode: "HTML" });
  });

  bot.command("cancel", async (ctx) => {
    const jobId = Number.parseInt(ctx.match.trim(), 10);
    if (!Number.isSafeInteger(jobId) || jobId <= 0) {
      await ctx.reply("Использование: /cancel <id> (id виден в /queue)");
      return;
    }
    const result = await queue.cancel(jobId);
    await ctx.reply(CANCEL_REPLIES[result] ?? result);
  });

  if (config.enableAudioMode) {
    bot.command("audio", async (ctx) => {
      const urls = extractUrls(ctx.match, ctx.message?.entities);
      if (urls.length === 0) {
        await ctx.reply("Использование: /audio <ссылка> — скачать только аудио.");
        return;
      }
      await enqueueLinks(ctx, urls, "audio", deps);
    });
  }

  // Any other message: extract all links and enqueue them (spec §10.2).
  bot.on("message", async (ctx) => {
    const text = ctx.message.text ?? ctx.message.caption;
    if (text === undefined) return; // stickers, photos without caption, ...

    const entities = ctx.message.entities ?? ctx.message.caption_entities;
    const urls = extractUrls(text, entities);
    if (urls.length === 0) {
      await ctx.reply("Не нашёл ссылок. Пришли ссылку на видео — или /start для справки.");
      return;
    }
    await enqueueLinks(ctx, urls, "video", deps);
  });
}
