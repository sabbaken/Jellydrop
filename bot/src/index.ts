import fs from "node:fs";
import { startAutoCleanup } from "./cleanup.js";
import { loadConfig } from "./config.js";
import { JobStore } from "./db.js";
import { refreshLibrary } from "./jellyfin.js";
import { DownloadQueue } from "./queue.js";
import { createBot, setCommandMenu } from "./telegram/bot.js";
import { registerCallbacks } from "./telegram/callbacks.js";
import { registerHandlers, type BotDeps } from "./telegram/handlers.js";
import { StatusMessenger } from "./telegram/messenger.js";

function log(message: string): void {
  console.log(`${new Date().toISOString()} [bot] ${message}`);
}

async function main(): Promise<void> {
  // config — fail fast with a readable message on missing env (spec §12)
  const config = loadConfig();

  fs.mkdirSync(config.stagingDir, { recursive: true });
  fs.mkdirSync(config.libraryDir, { recursive: true });

  // db (migrations were applied by `prisma migrate deploy` before start)
  const store = await JobStore.open(config.dbPath);

  // recover — fix jobs stuck in transient states before the workers start (spec §5)
  const recovery = await store.recoverStaleJobs();
  if (recovery.requeued > 0 || recovery.completed > 0) {
    log(
      `recovery: re-queued ${recovery.requeued}, completed ${recovery.completed} interrupted job(s)`,
    );
  }

  // queue + telegram wiring
  const bot = createBot(config);
  const messenger = new StatusMessenger(bot.api, config.progressEditIntervalMs);
  const queue = new DownloadQueue(store, config, messenger);
  const deps: BotDeps = { store, queue, config };
  registerHandlers(bot, deps);
  registerCallbacks(bot, deps);

  // a job was interrupted after its file reached the library — re-trigger the
  // refresh that never happened (spec §14)
  if (recovery.needsLibraryRefresh) {
    void refreshLibrary(config).then((ok) => {
      if (!ok) log("post-recovery Jellyfin refresh failed — will happen with the next job");
    });
  }

  if (config.enableAutoCleanup) startAutoCleanup(config);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, shutting down`);
    // Stop claiming + SIGTERM yt-dlp; interrupted jobs resume after restart.
    queue.shutdown();
    messenger.stop();
    void (async () => {
      try {
        await bot.stop();
      } catch (err) {
        log(`bot.stop() failed: ${String(err)}`);
      }
      await store.close().catch(() => {});
      process.exit(0);
    })();
    // Belt and braces: never hang the container past Docker's grace period.
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // resume anything queued/recovered, then start long polling (spec §1)
  queue.notify();
  void setCommandMenu(bot, config);
  await bot.start({
    allowed_updates: ["message", "callback_query"],
    onStart: (me) => log(`@${me.username} started (long polling)`),
  });
}

main().catch((err) => {
  console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
