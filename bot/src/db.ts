import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type JobStatus =
  | "queued"
  | "downloading"
  | "processing"
  | "moving"
  | "scanning"
  | "done"
  | "failed"
  | "canceled";

export type JobMode = "video" | "audio";

export interface Job {
  id: number;
  url: string;
  mode: JobMode;
  status: JobStatus;
  source: string | null;
  title: string | null;
  progress: number;
  speed: string | null;
  eta: string | null;
  staging_path: string | null;
  final_path: string | null;
  error: string | null;
  batch_id: string;
  tg_chat_id: number;
  tg_status_msg_id: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export const ACTIVE_STATUSES: readonly JobStatus[] = [
  "queued",
  "downloading",
  "processing",
  "moving",
  "scanning",
];

export const CANCELABLE_STATUSES: readonly JobStatus[] = [
  "queued",
  "downloading",
  "processing",
];

const MIGRATION = `
CREATE TABLE IF NOT EXISTS jobs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  url                TEXT    NOT NULL,
  mode               TEXT    NOT NULL DEFAULT 'video',
  status             TEXT    NOT NULL DEFAULT 'queued',
  source             TEXT,
  title              TEXT,
  progress           REAL    NOT NULL DEFAULT 0,
  speed              TEXT,
  eta                TEXT,
  staging_path       TEXT,
  final_path         TEXT,
  error              TEXT,
  batch_id           TEXT    NOT NULL,
  tg_chat_id         INTEGER NOT NULL,
  tg_status_msg_id   INTEGER,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  started_at         TEXT,
  finished_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_batch  ON jobs(batch_id);
`;

/** Columns allowed in updateJob() patches. */
const PATCHABLE = [
  "status",
  "source",
  "title",
  "progress",
  "speed",
  "eta",
  "staging_path",
  "final_path",
  "error",
  "tg_status_msg_id",
  "started_at",
  "finished_at",
] as const;

type PatchableColumn = (typeof PATCHABLE)[number];
export type JobPatch = Partial<Pick<Job, PatchableColumn>>;

export interface RecoveryReport {
  requeued: number;
  completed: number;
  /** True when a job was interrupted in moving/scanning — the library may need a refresh. */
  needsLibraryRefresh: boolean;
}

export class JobStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(MIGRATION);
  }

  close(): void {
    this.db.close();
  }

  createJob(input: { url: string; mode: JobMode; batchId: string; chatId: number }): Job {
    return this.db
      .prepare(
        `INSERT INTO jobs (url, mode, batch_id, tg_chat_id)
         VALUES (@url, @mode, @batchId, @chatId)
         RETURNING *`,
      )
      .get(input) as Job;
  }

  getJob(id: number): Job | undefined {
    return this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as Job | undefined;
  }

  updateJob(id: number, patch: JobPatch): void {
    const keys = (Object.keys(patch) as PatchableColumn[]).filter((k) =>
      PATCHABLE.includes(k),
    );
    if (keys.length === 0) return;
    const assignments = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE jobs SET ${assignments} WHERE id = @id`).run({ ...patch, id });
  }

  /**
   * Atomically claim the oldest queued job: queued -> downloading.
   * A single UPDATE statement, so two workers can never grab the same job.
   */
  claimNextQueued(): Job | undefined {
    return this.db
      .prepare(
        `UPDATE jobs
         SET status = 'downloading',
             started_at = datetime('now'),
             error = NULL
         WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1)
         RETURNING *`,
      )
      .get() as Job | undefined;
  }

  /**
   * Atomic guarded transition: applies only when the job is currently in one of
   * `from`. Returns the updated row, or undefined when the guard failed (e.g.
   * the job was canceled from under the worker).
   */
  transition(id: number, from: readonly JobStatus[], to: JobStatus, patch: JobPatch = {}): Job | undefined {
    const extraKeys = (Object.keys(patch) as PatchableColumn[]).filter(
      (k) => PATCHABLE.includes(k) && k !== "status",
    );
    const assignments = ["status = @to", ...extraKeys.map((k) => `${k} = @${k}`)].join(", ");
    const placeholders = from.map((_, i) => `@from${i}`).join(", ");
    const params: Record<string, unknown> = { ...patch, id, to };
    from.forEach((s, i) => (params[`from${i}`] = s));
    return this.db
      .prepare(
        `UPDATE jobs SET ${assignments}
         WHERE id = @id AND status IN (${placeholders})
         RETURNING *`,
      )
      .get(params) as Job | undefined;
  }

  listActive(): Job[] {
    return this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE status IN ('queued', 'downloading', 'processing', 'moving', 'scanning')
         ORDER BY id`,
      )
      .all() as Job[];
  }

  findActiveByUrl(url: string): Job | undefined {
    return this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE url = ? AND status IN ('queued', 'downloading', 'processing', 'moving', 'scanning')
         ORDER BY id LIMIT 1`,
      )
      .get(url) as Job | undefined;
  }

  /**
   * Startup recovery (spec §5): fix jobs stuck in transient states before the
   * workers start.
   *
   * - downloading/processing -> queued (yt-dlp --continue resumes the .part)
   * - moving   -> done when the file already landed in the library, else queued
   * - scanning -> done (the file is in the library; refresh is re-triggered)
   */
  recoverStaleJobs(): RecoveryReport {
    const report: RecoveryReport = { requeued: 0, completed: 0, needsLibraryRefresh: false };

    const run = this.db.transaction(() => {
      const stale = this.db
        .prepare(
          `SELECT * FROM jobs WHERE status IN ('downloading', 'processing', 'moving', 'scanning')`,
        )
        .all() as Job[];

      const requeue = this.db.prepare(
        `UPDATE jobs SET status = 'queued', speed = NULL, eta = NULL WHERE id = ?`,
      );
      const complete = this.db.prepare(
        `UPDATE jobs
         SET status = 'done', progress = 100, speed = NULL, eta = NULL,
             finished_at = datetime('now')
         WHERE id = ?`,
      );

      for (const job of stale) {
        if (job.status === "scanning") {
          complete.run(job.id);
          report.completed += 1;
          report.needsLibraryRefresh = true;
        } else if (job.status === "moving" && job.final_path && fs.existsSync(job.final_path)) {
          complete.run(job.id);
          report.completed += 1;
          report.needsLibraryRefresh = true;
        } else {
          requeue.run(job.id);
          report.requeued += 1;
        }
      }
    });
    run();

    return report;
  }
}
