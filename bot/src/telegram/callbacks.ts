import type { Bot } from "grammy";
import type { BotDeps } from "./handlers.js";

const CANCEL_ANSWERS: Record<string, string> = {
  canceled: "Отменено",
  too_late: "Уже не отменить — задача завершена",
  not_found: "Задача не найдена",
};

/**
 * Inline-button callbacks (spec §10.4). The status message itself is edited
 * by the queue hook (StatusMessenger), here we only answer the query.
 */
export function registerCallbacks(bot: Bot, { queue }: BotDeps): void {
  bot.callbackQuery(/^cancel:(\d+)$/, async (ctx) => {
    const jobId = Number.parseInt(ctx.match[1]!, 10);
    const result = await queue.cancel(jobId);
    await ctx.answerCallbackQuery({ text: CANCEL_ANSWERS[result] ?? result });
  });

  // Unknown/stale callback data: just dismiss the spinner.
  bot.on("callback_query:data", (ctx) => ctx.answerCallbackQuery());
}
