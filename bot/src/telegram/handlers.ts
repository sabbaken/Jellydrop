import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Bot, Context } from "grammy";
import type { Config } from "../config.js";
import type { Job, JobMode, JobStore } from "../db.js";
import type { DownloadQueue } from "../queue.js";
import { truncate } from "../util/format.js";
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
 * A previous download of this URL whose file still exists in the library —
 * no need to download again (deleted files fall through to a re-download).
 */
async function findInLibrary(store: JobStore, url: string, mode: JobMode): Promise<Job | undefined> {
  const done = await store.listDoneByUrl(url, mode);
  return done.find((job) => job.finalPath !== null && fs.existsSync(job.finalPath));
}

/**
 * One job + one status message per link (spec §10.2). All links from one
 * message share a batch_id; URLs already in the active queue are skipped,
 * URLs already downloaded and still present in the library are not re-fetched.
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
  const inLibrary: Job[] = [];
  let skippedActive = 0;
  for (const url of urls) {
    if (await store.findActiveByUrl(url, mode)) {
      skippedActive += 1;
      continue;
    }
    const existing = await findInLibrary(store, url, mode);
    if (existing) inLibrary.push(existing);
    else fresh.push(url);
  }

  const notes: string[] = [];
  if (fresh.length > 1) notes.push(`Добавлено ${fresh.length} в очередь.`);
  if (skippedActive > 0) notes.push(`Пропущено (уже в очереди): ${skippedActive}.`);
  for (const job of inLibrary) {
    notes.push(`Уже в библиотеке: ${truncate(job.title ?? job.url, 80)}`);
  }
  if (notes.length > 0) await ctx.reply(notes.join("\n"));
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
