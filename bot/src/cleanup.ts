import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

const SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;

function log(message: string): void {
  console.log(`${new Date().toISOString()} [cleanup] ${message}`);
}

/** Delete library files older than CLEANUP_AFTER_DAYS (spec §13, optional). */
export function sweepLibrary(config: Config): void {
  const cutoffMs = Date.now() - config.cleanupAfterDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(config.libraryDir, { withFileTypes: true, recursive: true });
  } catch (err) {
    log(`cannot read library dir: ${String(err)}`);
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoffMs) {
        fs.unlinkSync(filePath);
        removed += 1;
      }
    } catch {
      // raced with a move or already gone — ignore
    }
  }

  if (removed > 0) log(`removed ${removed} file(s) older than ${config.cleanupAfterDays} days`);
}

/** Run a sweep now and then twice a day. The timer never blocks shutdown. */
export function startAutoCleanup(config: Config): void {
  sweepLibrary(config);
  const timer = setInterval(() => sweepLibrary(config), SWEEP_INTERVAL_MS);
  timer.unref();
}
