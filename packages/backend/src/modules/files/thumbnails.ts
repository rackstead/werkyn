import os from "node:os";
import { logger } from "../../utils/logger.js";
import { THUMBNAIL_LIMITS, thumbnailFormat } from "./thumbnail-checks.js";
import type { DecodeDetails } from "./thumbnail-decode.js";
import { ThumbnailWorkerPool, type WorkerDetails, type WorkerResult } from "./thumbnail-workers.js";

export { THUMBNAIL_HEAD_BYTES, THUMBNAIL_LIMITS, THUMBNAIL_SOURCE_MAX_BYTES } from "./thumbnail-checks.js";

/**
 * Drive thumbnails as the server sees them: which uploads may wait for a
 * decode, how many decode at once, and how long an upload waits. The
 * decoding itself, with every check on the stored bytes, runs in separate
 * worker processes with a hard memory limit (thumbnail-workers.ts,
 * thumbnail-decode.ts), so this process never loads sharp. Thumbnails are
 * optional, so every refusal or failure only leaves one out. See
 * docs/remediation/r19.md.
 */

/** Concurrent transforms in one process. */
export interface ThumbnailAdmissionLimits {
  /** Transforms decoding at once. */
  maxActive: number;
  /** Uploads waiting for a turn; any more get no thumbnail at once. */
  maxQueued: number;
  /** How long an upload waits for a turn before going without. */
  queueTimeoutMs: number;
}

/**
 * At most half the CPUs and two transforms, each in its own worker process
 * on one libvips thread, so thumbnails never take more than two CPUs.
 */
export function defaultAdmissionLimits(
  cpus = os.availableParallelism(),
): ThumbnailAdmissionLimits {
  return {
    maxActive: Math.max(1, Math.min(2, Math.floor(cpus / 2))),
    maxQueued: 8,
    queueTimeoutMs: 5_000,
  };
}

type Release = () => void;

interface Waiter {
  key: string;
  grant: (release: Release | null) => void;
}

/**
 * A semaphore with a bounded queue and a bounded wait, shared fairly between
 * keys (workspaces). A free turn goes to the oldest waiter among the keys
 * with the fewest active transforms, and when the queue is full a key holding
 * fewer turns takes the newest place of the key holding the most, so one
 * workspace cannot keep another's uploads from ever being admitted.
 */
export class TransformAdmission {
  private active = 0;
  private readonly activeByKey = new Map<string, number>();
  private readonly queue: Waiter[] = [];

  constructor(readonly limits: ThumbnailAdmissionLimits) {}

  /** A release function once admitted; null when refused or the wait times out. */
  acquire(key = ""): Promise<Release | null> {
    if (this.active < this.limits.maxActive) return Promise.resolve(this.admit(key));
    if (this.queue.length >= this.limits.maxQueued && !this.makeRoomFor(key)) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        key,
        grant: (release) => {
          clearTimeout(timer);
          resolve(release);
        },
      };
      const timer = setTimeout(() => {
        const index = this.queue.indexOf(waiter);
        if (index !== -1) this.queue.splice(index, 1);
        resolve(null);
      }, this.limits.queueTimeoutMs);
      this.queue.push(waiter);
    });
  }

  /** Active plus queued turns of `key`. */
  private held(key: string) {
    return (this.activeByKey.get(key) ?? 0) + this.queue.filter((w) => w.key === key).length;
  }

  /**
   * Refuse the newest waiter of the key holding the most turns, if that is
   * at least two more than `key` holds, so the swap never reverses.
   */
  private makeRoomFor(key: string): boolean {
    let busiest: string | undefined;
    for (const waiter of this.queue) {
      if (busiest === undefined || this.held(waiter.key) > this.held(busiest)) busiest = waiter.key;
    }
    if (busiest === undefined || busiest === key || this.held(busiest) < this.held(key) + 2) {
      return false;
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].key === busiest) {
        const [evicted] = this.queue.splice(i, 1);
        evicted.grant(null);
        return true;
      }
    }
    return false;
  }

  private admit(key: string): Release {
    this.active++;
    this.activeByKey.set(key, (this.activeByKey.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const left = (this.activeByKey.get(key) ?? 1) - 1;
      if (left > 0) this.activeByKey.set(key, left);
      else this.activeByKey.delete(key);
      let next: Waiter | undefined;
      for (const waiter of this.queue) {
        const active = this.activeByKey.get(waiter.key) ?? 0;
        if (!next || active < (this.activeByKey.get(next.key) ?? 0)) next = waiter;
      }
      if (next) {
        this.queue.splice(this.queue.indexOf(next), 1);
        next.grant(this.admit(next.key));
      }
    };
  }

  /** Current use, for tests and diagnostics. */
  get usage() {
    return { active: this.active, queued: this.queue.length };
  }
}

export const thumbnailAdmission = new TransformAdmission(defaultAdmissionLimits());

export type ThumbnailOutcome =
  | "created"
  | "busy"
  | "unsupported"
  | "over-budget"
  | "failed"
  | "timed-out"
  | "crashed";

/** Outcome counts since start, for tests and diagnostics. */
export const thumbnailOutcomes: Record<ThumbnailOutcome, number> = {
  created: 0, busy: 0, unsupported: 0, "over-budget": 0, failed: 0, "timed-out": 0, crashed: 0,
};

/**
 * The decoder workers, one per transform turn. Started at the first
 * thumbnail, or by the server at startup; stopped at shutdown.
 * WERKYN_TEST_THUMBNAIL_MEMORY_CHECKS=off (honoured only when NODE_ENV is
 * "test") makes them skip the container checks and memory estimate, to
 * show that the workers' own limit holds.
 */
export const thumbnailWorkers = new ThumbnailWorkerPool({
  size: thumbnailAdmission.limits.maxActive,
  dataLimitBytes: THUMBNAIL_LIMITS.workerDataBytes,
  memoryChecks: !(process.env.NODE_ENV === "test" && process.env.WERKYN_TEST_THUMBNAIL_MEMORY_CHECKS === "off"),
  recycleAboveBytes: THUMBNAIL_LIMITS.workerRecycleBytes,
});

/**
 * Workspaces whose uploads recently ended a decoder worker (a crash, out of
 * memory under its limit) wait before their next decode: 1 s after the
 * first, doubling up to 60 s, until one of their thumbnails succeeds. A
 * restarted worker costs about as much CPU as decoding an ordinary photo,
 * so this keeps one workspace from turning a stream of crashing uploads
 * into a stream of restarts, without holding back any other workspace.
 */
export class CrashBackoff {
  private readonly entries = new Map<string, { crashes: number; until: number }>();

  constructor(
    readonly initialMs = 1_000,
    readonly maxMs = 60_000,
    /** Workspaces remembered; the longest-unseen are forgotten first. */
    readonly maxEntries = 10_000,
  ) {}

  /** Milliseconds before `key` may decode again; 0 when it may now. */
  remaining(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    return entry ? Math.max(0, entry.until - now) : 0;
  }

  crashed(key: string, now = Date.now()): void {
    const crashes = (this.entries.get(key)?.crashes ?? 0) + 1;
    this.entries.delete(key);
    this.entries.set(key, { crashes, until: now + Math.min(this.maxMs, this.initialMs * 2 ** (crashes - 1)) });
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }

  succeeded(key: string): void {
    this.entries.delete(key);
  }
}

export const thumbnailCrashBackoff = new CrashBackoff();

/** A stored file to make a thumbnail of. */
export interface ThumbnailSource {
  /** Its size in bytes. */
  size: number;
  /**
   * At least its first THUMBNAIL_HEAD_BYTES bytes, or all of a shorter file.
   * `signal` aborts when the caller stops waiting.
   */
  head(signal: AbortSignal): Promise<Buffer>;
  /** Its path on the local filesystem; a decoder worker reads it from there. */
  path: string;
}

export interface ThumbnailOptions {
  /** Admission is shared fairly between workspaces; also logged. */
  workspaceId?: string;
  /** Logged with a skipped thumbnail. */
  fileId?: string;
  admission?: TransformAdmission;
  workers?: ThumbnailWorkerPool;
  crashBackoff?: CrashBackoff;
  deadlineMs?: number;
  headTimeoutMs?: number;
}

const TIMED_OUT = Symbol("timed out");

/**
 * A WebP thumbnail of `source`, or null. The file's first bytes are checked
 * against the allowlisted signatures before it waits for a turn, so other
 * content never takes one. It then waits (at most `queueTimeoutMs`) and a
 * worker reads, checks and decodes the whole file. The upload stops waiting
 * `transformDeadlineMs` after admission: the worker is then killed, and the
 * turn returns once it has exited, so the turn always covers a worker's
 * memory. A worker that crashes or runs out of memory costs only this
 * thumbnail, and holds back this workspace's next ones for a while
 * (CrashBackoff). Never throws.
 */
export async function createThumbnail(
  source: ThumbnailSource,
  {
    workspaceId,
    fileId,
    admission = thumbnailAdmission,
    workers = thumbnailWorkers,
    crashBackoff = thumbnailCrashBackoff,
    deadlineMs = THUMBNAIL_LIMITS.transformDeadlineMs,
    headTimeoutMs = THUMBNAIL_LIMITS.headTimeoutMs,
  }: ThumbnailOptions = {},
): Promise<Buffer | null> {
  const context = { workspaceId, fileId };
  // The head read happens before admission, so it has its own deadline: a
  // stalled read is abandoned and the upload goes on without a thumbnail.
  const stopHead = new AbortController();
  let headTimer: NodeJS.Timeout | undefined;
  try {
    const reading = source.head(stopHead.signal);
    reading.catch(() => {}); // settles after an abandonment
    const head = await Promise.race([
      reading,
      new Promise<typeof TIMED_OUT>((resolve) => {
        headTimer = setTimeout(resolve, headTimeoutMs, TIMED_OUT);
      }),
    ]);
    if (head === TIMED_OUT) {
      stopHead.abort();
      return skipped("timed-out", { ...context, reason: "reading the first bytes" });
    }
    if (!thumbnailFormat(head, source.size)) return skipped("unsupported", context);
  } catch (err) {
    return skipped("failed", { ...context, reason: errorReason(err) });
  } finally {
    clearTimeout(headTimer);
  }
  const key = workspaceId ?? "";
  const holdBackMs = crashBackoff.remaining(key);
  if (holdBackMs > 0) {
    return skipped("busy", { ...context, reason: `this workspace's uploads recently ended a decoder worker (${holdBackMs} ms left)` });
  }
  const release = await admission.acquire(workspaceId);
  if (!release) return skipped("busy", context);
  const stop = new AbortController();
  const work: Promise<WorkerResult> = workers.run(source.path, stop.signal)
    .catch((err) => ({ ok: false, outcome: "failed", details: { reason: errorReason(err) } }));
  let timer: NodeJS.Timeout | undefined;
  let releaseLater = false;
  try {
    const result = await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(resolve, deadlineMs, TIMED_OUT);
      }),
    ]);
    if (result === TIMED_OUT) {
      // The worker is killed; its turn returns once it has exited.
      stop.abort();
      releaseLater = true;
      work.then(release, release);
      return skipped("timed-out", context);
    }
    if (result.ok) {
      crashBackoff.succeeded(key);
      thumbnailOutcomes.created++;
      return result.thumbnail;
    }
    if (result.outcome === "crashed") crashBackoff.crashed(key);
    return skipped(result.outcome, { ...context, ...result.details });
  } finally {
    clearTimeout(timer);
    if (!releaseLater) release();
  }
}

function errorReason(err: unknown) {
  return err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : String(err);
}

function skipped(
  outcome: ThumbnailOutcome,
  details: DecodeDetails & WorkerDetails & { workspaceId?: string; fileId?: string },
): null {
  thumbnailOutcomes[outcome]++;
  // Not decoding a non-allowlisted format is the expected case; a crashed
  // worker means a decoder needed more than its limit or failed outright.
  if (outcome === "unsupported") logger.debug({ outcome, ...details }, "Thumbnail omitted");
  else if (outcome === "crashed") logger.warn({ outcome, ...details }, "Thumbnail omitted");
  else logger.info({ outcome, ...details }, "Thumbnail omitted");
  return null;
}
