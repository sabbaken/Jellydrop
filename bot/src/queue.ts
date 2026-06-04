import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { ACTIVE_STATUSES, type Job, type JobPatch, type JobStore } from "./db.js";
import {
  CanceledError,
  DownloadError,
  PlaylistError,
  download,
  findOutputFiles,
  killAllProcesses,
  killJobProcess,
  probe,
} from "./downloader.js";
import { buildNfo, findItemDeepLink, refreshLibrary } from "./jellyfin.js";

export type CancelResult = "canceled" | "too_late" | "not_found";

export interface JobUpdateOptions {
  /** Bypass the edit throttle (status transitions, terminal states). */
  force?: boolean;
  /** Optional Jellyfin deep link to render in the final message. */
  deepLink?: string | null;
}

export interface QueueHooks {
  onJobUpdate(job: Job, options?: JobUpdateOptions): void;
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} [queue] ${message}`);
}

/**
 * In-process worker pool (spec §5). The DB is the source of truth: workers
 * atomically claim `queued` jobs, at most `downloadConcurrency` run at once.
 */
export class DownloadQueue {
  private readonly running = new Set<number>();
  private draining = false;
  private wakeRequested = false;
  private stopped = false;

  constructor(
    private readonly store: JobStore,
    private readonly config: Config,
    private readonly hooks: QueueHooks,
  ) {}

  /** Wake the pool: claim queued jobs until all slots are busy. */
  notify(): void {
    if (this.stopped) return;
    this.wakeRequested = true;
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => {
      void this.drain()
        .catch((err) => log(`unexpected drain error: ${String(err)}`))
        .finally(() => {
          this.draining = false;
          // Catch a notify() that raced with the tail of this drain.
          if (this.wakeRequested && !this.stopped) this.notify();
        });
    });
  }

  /** Single-flight claim loop — only one runs at a time (`draining` guard). */
  private async drain(): Promise<void> {
    while (this.wakeRequested && !this.stopped) {
      this.wakeRequested = false;
      while (!this.stopped && this.running.size < this.config.downloadConcurrency) {
        const job = await this.store.claimNextQueued();
        if (!job) break;
        this.running.add(job.id);
        void this.run(job)
          .catch((err) => log(`unexpected worker error for job ${job.id}: ${String(err)}`))
          .finally(() => {
            this.running.delete(job.id);
            this.notify();
          });
      }
    }
  }

  /** Graceful shutdown: stop claiming, SIGTERM live yt-dlp processes. Jobs stay
   * in `downloading` and are re-queued by startup recovery (spec §5). */
  shutdown(): void {
    this.stopped = true;
    killAllProcesses();
  }

  private jobDir(jobId: number): string {
    return path.join(this.config.stagingDir, `job-${jobId}`);
  }

  private async update(jobId: number, options?: JobUpdateOptions): Promise<void> {
    const job = await this.store.getJob(jobId);
    if (job) this.hooks.onJobUpdate(job, options);
  }

  private async run(job: Job): Promise<void> {
    const jobDir = this.jobDir(job.id);
    log(`job ${job.id}: started (${job.url})`);
    await this.update(job.id, { force: true });

    try {
      // --- probe ------------------------------------------------------------
      const info = await probe(job.id, job.url, this.config);
      if (info.isPlaylist) throw new PlaylistError();
      await this.store.updateJob(job.id, { title: info.title, source: info.source });
      await this.ensureNotCanceled(job.id);
      await this.update(job.id, { force: true });

      // --- download (+ in-yt-dlp post-processing) ---------------------------
      fs.mkdirSync(jobDir, { recursive: true });
      let progressWriteBusy = false;
      await download(job.id, job.url, job.mode, jobDir, this.config, {
        onProgress: (p) => {
          // Drop samples while a write is in flight — the next one catches up,
          // and the messenger throttles edits anyway.
          if (progressWriteBusy) return;
          progressWriteBusy = true;
          void (async () => {
            await this.store.updateJob(job.id, {
              ...(p.percent !== null ? { progress: p.percent } : {}),
              speed: p.speed,
              eta: p.eta,
            });
            await this.update(job.id);
          })()
            .catch((err) => log(`job ${job.id}: progress write failed: ${String(err)}`))
            .finally(() => {
              progressWriteBusy = false;
            });
        },
        onPostProcessing: () => {
          void this.store
            .transition(job.id, ["downloading"], "processing", {
              progress: 100,
              speed: null,
              eta: null,
            })
            .then((updated) => {
              if (updated) this.hooks.onJobUpdate(updated, { force: true });
            })
            .catch((err) => log(`job ${job.id}: processing transition failed: ${String(err)}`));
        },
      });

      // --- moving: atomic staging -> library (spec §8) -----------------------
      await this.transitionOrCancel(job.id, ["downloading", "processing"], "moving", {
        speed: null,
        eta: null,
      });
      await this.update(job.id, { force: true });

      const finalPath = await this.moveIntoLibrary(job, info.raw, jobDir);

      // --- scanning: Jellyfin library refresh (spec §9.3) --------------------
      await this.transitionOrCancel(job.id, ["moving"], "scanning");
      await this.update(job.id, { force: true });

      const refreshed = await refreshLibrary(this.config);
      if (!refreshed) {
        log(`job ${job.id}: Jellyfin refresh failed/skipped — file is in the library anyway`);
      }

      let deepLink: string | null = null;
      if (refreshed && this.config.enableJellyfinDeeplink) {
        const title = (await this.store.getJob(job.id))?.title;
        if (title) deepLink = await findItemDeepLink(this.config, title);
      }

      await this.store.transition(job.id, ["scanning"], "done", {
        progress: 100,
        speed: null,
        eta: null,
        finishedAt: new Date(),
      });
      await this.update(job.id, { force: true, deepLink });
      log(`job ${job.id}: done -> ${finalPath}`);
    } catch (err) {
      await this.handleRunError(job.id, jobDir, err);
    }
  }

  /** Throw CanceledError when the job was canceled from under the worker. */
  private async ensureNotCanceled(jobId: number): Promise<void> {
    if ((await this.store.getJob(jobId))?.status === "canceled") throw new CanceledError();
  }

  private async transitionOrCancel(
    jobId: number,
    from: readonly Job["status"][],
    to: Job["status"],
    patch: JobPatch = {},
  ): Promise<Job> {
    const updated = await this.store.transition(jobId, from, to, patch);
    if (!updated) throw new CanceledError();
    return updated;
  }

  /**
   * Write the .nfo next to the media file, then atomically rename media +
   * sidecars from the per-job staging dir into the library (spec §8). Only
   * fully finished files are moved — Jellyfin never sees partials.
   */
  private async moveIntoLibrary(
    job: Job,
    probeJson: Record<string, unknown>,
    jobDir: string,
  ): Promise<string> {
    const { media, sidecars } = findOutputFiles(jobDir);
    if (!media) {
      throw new DownloadError(
        "не удалось найти скачанный файл после завершения yt-dlp" +
          (this.config.maxFilesize ? ` (возможно, превышен MAX_FILESIZE=${this.config.maxFilesize})` : ""),
      );
    }

    const toMove = [media, ...sidecars];

    if (job.mode === "video") {
      const nfoPath = media.slice(0, media.length - path.extname(media).length) + ".nfo";
      try {
        fs.writeFileSync(nfoPath, buildNfo(probeJson), "utf8");
        toMove.push(nfoPath);
      } catch (err) {
        log(`job ${job.id}: failed to write .nfo (continuing): ${String(err)}`);
      }
    }

    const destDir =
      job.mode === "audio" ? path.join(this.config.libraryDir, "audio") : this.config.libraryDir;
    fs.mkdirSync(destDir, { recursive: true });

    let finalMediaPath = "";
    for (const src of toMove) {
      const dest = path.join(destDir, path.basename(src));
      moveFile(src, dest);
      if (src === media) finalMediaPath = dest;
    }

    await this.store.updateJob(job.id, { stagingPath: media, finalPath: finalMediaPath });
    fs.rmSync(jobDir, { recursive: true, force: true });
    return finalMediaPath;
  }

  private async handleRunError(jobId: number, jobDir: string, err: unknown): Promise<void> {
    const current = await this.store.getJob(jobId);

    // User-initiated cancel: cancel() already flipped the status and killed the
    // process; here we delete partial files and finalize the message (spec §7.4).
    if (current?.status === "canceled") {
      fs.rmSync(jobDir, { recursive: true, force: true });
      await this.store.updateJob(jobId, {
        speed: null,
        eta: null,
        finishedAt: current.finishedAt ?? new Date(),
      });
      await this.update(jobId, { force: true });
      log(`job ${jobId}: canceled, partial files removed`);
      return;
    }

    // Killed without a user cancel — graceful shutdown. Leave status/files
    // untouched: startup recovery re-queues and yt-dlp resumes the .part.
    if (err instanceof CanceledError) {
      log(`job ${jobId}: interrupted by shutdown, will resume after restart`);
      return;
    }

    const message =
      err instanceof PlaylistError
        ? "это плейлист — пришли отдельные ссылки на видео"
        : err instanceof DownloadError
          ? err.message
          : `internal error: ${err instanceof Error ? err.message : String(err)}`;

    const updated = await this.store.transition(jobId, ACTIVE_STATUSES, "failed", {
      error: message.slice(0, 1000),
      speed: null,
      eta: null,
      finishedAt: new Date(),
    });
    fs.rmSync(jobDir, { recursive: true, force: true });
    if (updated) this.hooks.onJobUpdate(updated, { force: true });
    log(`job ${jobId}: failed — ${message}`);
  }

  /**
   * Cancel a job (spec §7.4): queued jobs are removed from the queue; running
   * jobs get their yt-dlp process killed, the worker then deletes partials.
   */
  async cancel(jobId: number): Promise<CancelResult> {
    const job = await this.store.getJob(jobId);
    if (!job) return "not_found";

    if (job.status === "queued") {
      const updated = await this.store.transition(jobId, ["queued"], "canceled", {
        finishedAt: new Date(),
      });
      if (updated) {
        this.hooks.onJobUpdate(updated, { force: true });
        log(`job ${jobId}: canceled while queued`);
        return "canceled";
      }
      // Lost the race with a worker claim — fall through to the running branch.
    }

    const updated = await this.store.transition(jobId, ["downloading", "processing"], "canceled", {
      speed: null,
      eta: null,
      finishedAt: new Date(),
    });
    if (updated) {
      const killed = killJobProcess(jobId);
      // When no live process exists (e.g. between probe and download) the
      // worker hits a canceled guard at its next checkpoint and cleans up.
      log(`job ${jobId}: cancel requested (live process: ${killed})`);
      this.hooks.onJobUpdate(updated, { force: true });
      return "canceled";
    }

    return "too_late";
  }
}

/**
 * fs.rename, with a defensive copy+rename+unlink fallback for EXDEV. The
 * compose setup guarantees staging and library share one filesystem (spec §8),
 * so the fallback should never trigger in production — but if it does, the
 * copy goes to a dot-file first so Jellyfin never sees a partial.
 */
function moveFile(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    console.warn(
      `[queue] EXDEV on rename ${src} -> ${dest}; falling back to copy (staging and library should share one filesystem!)`,
    );
    const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.tmp-move`);
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
    fs.unlinkSync(src);
  }
}
