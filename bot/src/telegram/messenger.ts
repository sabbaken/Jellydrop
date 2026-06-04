import { GrammyError, type Api } from "grammy";
import type { Job } from "../db.js";
import type { JobUpdateOptions, QueueHooks } from "../queue.js";
import { jobKeyboard, renderJobMessage } from "./render.js";

const TERMINAL_STATUSES: readonly Job["status"][] = ["done", "failed", "canceled"];

interface MessageState {
  /** Most recent job snapshot waiting to be rendered. */
  latest: { job: Job; deepLink: string | null } | null;
  /** Bypass the throttle on the next flush (status transitions, finals). */
  forced: boolean;
  /** An update arrived while an edit was in flight — flush again after. */
  dirty: boolean;
  inflight: boolean;
  lastEditAt: number;
  /** Telegram asked us to back off (429) — no edits before this timestamp. */
  backoffUntil: number;
  /** Last text+keyboard signature actually sent — skip no-op edits. */
  lastSignature: string | null;
  timer: NodeJS.Timeout | null;
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} [telegram] ${message}`);
}

/**
 * Edits per-job status messages in place, throttled to
 * PROGRESS_EDIT_INTERVAL_MS per job (spec §7.3): progress updates are
 * coalesced, status transitions go out immediately (`force`), and Telegram
 * 429s push the next edit out by `retry_after`.
 */
export class StatusMessenger implements QueueHooks {
  private readonly states = new Map<number, MessageState>();

  constructor(
    private readonly api: Api,
    private readonly intervalMs: number,
  ) {}

  onJobUpdate(job: Job, options: JobUpdateOptions = {}): void {
    // The status message was never sent (or failed to send) — nothing to edit.
    if (job.tgStatusMsgId === null) return;

    let state = this.states.get(job.id);
    if (!state) {
      state = {
        latest: null,
        forced: false,
        dirty: false,
        inflight: false,
        lastEditAt: 0,
        backoffUntil: 0,
        lastSignature: null,
        timer: null,
      };
      this.states.set(job.id, state);
    }

    state.latest = {
      job,
      deepLink: options.deepLink ?? state.latest?.deepLink ?? null,
    };
    if (options.force) state.forced = true;
    this.maybeFlush(job.id);
  }

  /** Cancel pending timers (graceful shutdown). */
  stop(): void {
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.states.clear();
  }

  private maybeFlush(jobId: number): void {
    const state = this.states.get(jobId);
    if (!state?.latest) return;

    if (state.inflight) {
      state.dirty = true;
      return;
    }

    const now = Date.now();

    // A 429 backoff is never bypassed, not even by forced updates.
    const backoffMs = state.backoffUntil - now;
    if (backoffMs > 0) {
      this.schedule(jobId, backoffMs);
      return;
    }

    const waitMs = state.lastEditAt + this.intervalMs - now;
    if (!state.forced && waitMs > 0) {
      this.schedule(jobId, waitMs);
      return;
    }

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    void this.send(jobId);
  }

  private schedule(jobId: number, delayMs: number): void {
    const state = this.states.get(jobId);
    if (!state || state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      this.maybeFlush(jobId);
    }, delayMs);
  }

  private async send(jobId: number): Promise<void> {
    const state = this.states.get(jobId);
    if (!state?.latest) return;

    const { job, deepLink } = state.latest;
    const text = renderJobMessage(job, deepLink);
    const keyboard = jobKeyboard(job);
    const signature = `${text} ${keyboard ? "cancel" : ""}`;

    state.forced = false;
    state.dirty = false;

    if (signature === state.lastSignature) {
      this.finalize(jobId, job);
      return;
    }

    state.inflight = true;
    try {
      await this.api.editMessageText(job.tgChatId, job.tgStatusMsgId!, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true },
      });
      state.lastSignature = signature;
      state.lastEditAt = Date.now();
    } catch (err) {
      this.handleEditError(jobId, state, err);
    } finally {
      state.inflight = false;
    }

    if (!this.states.has(jobId)) return;
    if (state.dirty || state.forced) {
      this.maybeFlush(jobId);
    } else {
      this.finalize(jobId, job);
    }
  }

  private finalize(jobId: number, job: Job): void {
    // Terminal states get one last edit; afterwards the state can be dropped.
    if (TERMINAL_STATUSES.includes(job.status)) {
      const state = this.states.get(jobId);
      if (state?.timer) clearTimeout(state.timer);
      this.states.delete(jobId);
    }
  }

  private handleEditError(jobId: number, state: MessageState, err: unknown): void {
    if (err instanceof GrammyError) {
      // Someone else already put this exact text there — treat as success.
      if (err.description.includes("message is not modified")) {
        state.lastEditAt = Date.now();
        return;
      }
      // Flood limit: retry after the interval Telegram asks for (spec §7.3).
      if (err.error_code === 429) {
        const retryAfterMs = (err.parameters.retry_after ?? 5) * 1000;
        log(`429 for job ${jobId}, retrying in ${retryAfterMs}ms`);
        state.backoffUntil = Date.now() + retryAfterMs;
        state.forced = true;
        return;
      }
      // Message deleted by the user etc. — give up on this message.
      log(`dropping status message for job ${jobId}: ${err.description}`);
      if (state.timer) clearTimeout(state.timer);
      this.states.delete(jobId);
      return;
    }
    // Network hiccup: leave state in place, the next update retries.
    log(`edit failed for job ${jobId}: ${String(err)}`);
  }
}
