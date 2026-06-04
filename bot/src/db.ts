import fs from "node:fs";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client.js";
import type { JobModel } from "./generated/prisma/models.js";

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

/**
 * The domain view of a job row. Mirrors the Prisma model, with the BigInt
 * Telegram ids narrowed to number (they fit in 2^53) and status/mode typed
 * as unions — the rest of the app never touches Prisma types directly.
 */
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
  stagingPath: string | null;
  finalPath: string | null;
  error: string | null;
  batchId: string;
  tgChatId: number;
  tgStatusMsgId: number | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
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

export interface JobPatch {
  status?: JobStatus;
  source?: string | null;
  title?: string | null;
  progress?: number;
  speed?: string | null;
  eta?: string | null;
  stagingPath?: string | null;
  finalPath?: string | null;
  error?: string | null;
  tgStatusMsgId?: number | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

export interface RecoveryReport {
  requeued: number;
  completed: number;
  /** Jobs flipped to done by recovery — their status messages need a final edit. */
  completedJobIds: number[];
  /** True when a job was interrupted in moving/scanning — the library may need a refresh. */
  needsLibraryRefresh: boolean;
}

function toJob(row: JobModel): Job {
  return {
    ...row,
    mode: row.mode as JobMode,
    status: row.status as JobStatus,
    tgChatId: Number(row.tgChatId),
    tgStatusMsgId: row.tgStatusMsgId === null ? null : Number(row.tgStatusMsgId),
  };
}

/** JobPatch -> Prisma update data (BigInt conversion for Telegram ids). */
function toData(patch: JobPatch): Record<string, unknown> {
  const { tgStatusMsgId, ...rest } = patch;
  const data: Record<string, unknown> = { ...rest };
  if (tgStatusMsgId !== undefined) {
    data["tgStatusMsgId"] = tgStatusMsgId === null ? null : BigInt(tgStatusMsgId);
  }
  return data;
}

/**
 * Prisma-backed job store. The DB stays the single source of truth for job
 * state (spec §5); all guarded transitions are optimistic single-statement
 * updates, so concurrent workers/cancel can never double-apply one.
 */
export class JobStore {
  private constructor(private readonly prisma: PrismaClient) {}

  /**
   * Open (and tune) the SQLite database. Schema migrations are applied
   * separately via `prisma migrate deploy` before the app starts.
   */
  static async open(dbPath: string): Promise<JobStore> {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const adapter = new PrismaBetterSqlite3(
      { url: `file:${dbPath}`, timeout: 5000 }, // timeout == busy_timeout
      { timestampFormat: "iso8601" },
    );
    const prisma = new PrismaClient({ adapter });
    // WAL is persistent per database file; NORMAL is the recommended pairing.
    await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL;");
    await prisma.$queryRawUnsafe("PRAGMA synchronous = NORMAL;");
    return new JobStore(prisma);
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async createJob(input: {
    url: string;
    mode: JobMode;
    batchId: string;
    chatId: number;
  }): Promise<Job> {
    const row = await this.prisma.job.create({
      data: {
        url: input.url,
        mode: input.mode,
        batchId: input.batchId,
        tgChatId: BigInt(input.chatId),
      },
    });
    return toJob(row);
  }

  async getJob(id: number): Promise<Job | undefined> {
    const row = await this.prisma.job.findUnique({ where: { id } });
    return row ? toJob(row) : undefined;
  }

  async updateJob(id: number, patch: JobPatch): Promise<void> {
    const data = toData(patch);
    if (Object.keys(data).length === 0) return;
    // updateMany: no throw when the row is gone (update would raise P2025).
    await this.prisma.job.updateMany({ where: { id }, data });
  }

  /**
   * Atomically claim the oldest queued job: queued -> downloading. The
   * status guard on the update means two claimants can never win the same
   * job — the loser just retries with the next candidate.
   */
  async claimNextQueued(): Promise<Job | undefined> {
    for (;;) {
      const candidate = await this.prisma.job.findFirst({
        where: { status: "queued" },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      if (!candidate) return undefined;

      const { count } = await this.prisma.job.updateMany({
        where: { id: candidate.id, status: "queued" },
        data: { status: "downloading", startedAt: new Date(), error: null },
      });
      if (count === 1) return this.getJob(candidate.id);
      // Lost the race (canceled or claimed from under us) — try the next one.
    }
  }

  /**
   * Atomic guarded transition: applies only when the job is currently in one
   * of `from`. Returns the updated row, or undefined when the guard failed
   * (e.g. the job was canceled from under the worker).
   */
  async transition(
    id: number,
    from: readonly JobStatus[],
    to: JobStatus,
    patch: JobPatch = {},
  ): Promise<Job | undefined> {
    const { count } = await this.prisma.job.updateMany({
      where: { id, status: { in: [...from] } },
      data: { ...toData(patch), status: to },
    });
    return count === 1 ? this.getJob(id) : undefined;
  }

  async listActive(): Promise<Job[]> {
    const rows = await this.prisma.job.findMany({
      where: { status: { in: [...ACTIVE_STATUSES] } },
      orderBy: { id: "asc" },
    });
    return rows.map(toJob);
  }

  async findActiveByUrl(url: string): Promise<Job | undefined> {
    const row = await this.prisma.job.findFirst({
      where: { url, status: { in: [...ACTIVE_STATUSES] } },
      orderBy: { id: "asc" },
    });
    return row ? toJob(row) : undefined;
  }

  /**
   * Startup recovery (spec §5): fix jobs stuck in transient states before the
   * workers start.
   *
   * - downloading/processing -> queued (yt-dlp --continue resumes the .part)
   * - moving   -> done when the file already landed in the library, else queued
   * - scanning -> done (the file is in the library; refresh is re-triggered)
   */
  async recoverStaleJobs(): Promise<RecoveryReport> {
    const report: RecoveryReport = {
      requeued: 0,
      completed: 0,
      completedJobIds: [],
      needsLibraryRefresh: false,
    };

    await this.prisma.$transaction(async (tx) => {
      const stale = await tx.job.findMany({
        where: { status: { in: ["downloading", "processing", "moving", "scanning"] } },
      });

      for (const job of stale) {
        const finished =
          job.status === "scanning" ||
          (job.status === "moving" && job.finalPath !== null && fs.existsSync(job.finalPath));

        if (finished) {
          await tx.job.update({
            where: { id: job.id },
            data: {
              status: "done",
              progress: 100,
              speed: null,
              eta: null,
              finishedAt: new Date(),
            },
          });
          report.completed += 1;
          report.completedJobIds.push(job.id);
          report.needsLibraryRefresh = true;
        } else {
          await tx.job.update({
            where: { id: job.id },
            data: { status: "queued", speed: null, eta: null },
          });
          report.requeued += 1;
        }
      }
    });

    return report;
  }
}
