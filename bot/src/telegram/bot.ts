import { Bot } from "grammy";
import type { Config } from "../config.js";

/**
 * Bare grammY bot with the auth middleware first in the chain (spec §10.1):
 * updates from anyone but ALLOWED_TELEGRAM_USER_ID are silently dropped.
 * Handlers/callbacks are registered by the bootstrap once the queue exists
 * (the StatusMessenger needs `bot.api` before the queue can be built).
 */
export function createBot(config: Config): Bot {
  const bot = new Bot(config.telegramBotToken);

  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.allowedTelegramUserId) return;
    await next();
  });

  bot.catch((err) => {
    console.error(`${new Date().toISOString()} [telegram] handler error: ${String(err.error)}`);
  });

  return bot;
}

/** Best effort: populate the Telegram command menu. */
export async function setCommandMenu(bot: Bot, config: Config): Promise<void> {
  const commands = [
    { command: "queue", description: "Список активных задач" },
    { command: "cancel", description: "Отменить задачу: /cancel <id>" },
    ...(config.enableAudioMode
      ? [{ command: "audio", description: "Скачать только аудио: /audio <ссылка>" }]
      : []),
    { command: "start", description: "Справка" },
  ];
  try {
    await bot.api.setMyCommands(commands);
  } catch (err) {
    console.warn(`[telegram] setMyCommands failed: ${String(err)}`);
  }
}
