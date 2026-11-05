import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../utils/logger.js";
import type { DecodeDetails, DecodeResult } from "./thumbnail-decode.js";
import type { WorkerMemory, WorkerMessage, WorkerRequest } from "./thumbnail-worker.js";

/**
 * A small pool of long-lived decoder processes for Drive thumbnails. Each
 * worker (thumbnail-worker.ts) runs sharp under a hard data limit, so an
 * image that needs more memory than its estimate said fails or ends that
 * worker, never the server. A worker that crashes or is killed at the
 * deadline is replaced; repeated failures are backed off. See
 * docs/remediation/r19.md.
 *
 * The limit is RLIMIT_DATA, which counts a process's heap, anonymous
 * mappings and thread stacks but not the address space V8 reserves, so
 * Node runs normally under it. Node cannot set it for a child, so on Linux
 * the worker starts as `/bin/sh -c 'ulimit -d <KiB>; exec node ...'`, which
 * needs no privilege (glibc and Alpine's busybox both have it). Without
 * /bin/sh or on another platform the workers run without a limit: a crash
 * still ends only the worker, and the pre-decode checks remain the bound.
 */

/** A decode result, or why the worker produced none. */
export type WorkerResult =
  | DecodeResult
  | { ok: false; outcome: "crashed" | "timed-out" | "failed"; details: DecodeDetails & WorkerDetails };

export interface WorkerDetails {
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
}

export interface ThumbnailWorkerPoolOptions {
  /** Worker processes; each decodes one file at a time. */
  size: number;
  /** RLIMIT_DATA of each worker, or null for none. */
  dataLimitBytes: number | null;
  /** Tests only: decode without the container checks and memory estimate. */
  memoryChecks?: boolean;
  /** A started worker that has not reported ready by then is killed. */
  startTimeoutMs?: number;
  /**
   * After a failure (a crash, or a start that never got ready) the worker
   * is restarted at once; after each further failure without a completed
   * decode in between, the delay doubles from `initial` up to `max`.
   */
  restartDelayMs?: { initial: number; max: number };
  /**
   * A worker whose data size is over this after a decode is replaced, so
   * memory the allocator keeps does not count against the next decode.
   */
  recycleAboveBytes?: number;
  /** How long close() and retiring wait for a worker to exit before killing it (250 ms). */
  closeGraceMs?: number;
  /** The worker entry point and Node options; derived from this module by default. */
  script?: string;
  execArgv?: string[];
}

const SHELL = "/bin/sh";
/** Exit status of the start wrapper when it cannot set the limit. */
const LIMIT_REFUSED = 125;
/** Environment the workers get: no secrets, nothing but what Node and libvips need. */
const WORKER_ENV_KEYS = ["PATH", "TMPDIR", "TZ", "LANG", "LC_ALL", "NODE_ENV"];
/**
 * - One libuv thread: a worker reads and decodes one file at a time, and
 *   each thread's stack counts against the data limit.
 * - glibc only (musl ignores them): two malloc arenas, and every block of
 *   128 KiB or more mapped and returned on free, so a decode does not leave
 *   hundreds of MiB in the allocator for the next one to run out of.
 */
const WORKER_ENV = { UV_THREADPOOL_SIZE: "1", MALLOC_ARENA_MAX: "2", MALLOC_MMAP_THRESHOLD_: "131072" };
/** A thumbnail is a 400-pixel-wide WebP; anything larger is not one. */
const MAX_THUMBNAIL_BYTES = 16 * 1024 * 1024;

type SlotState = "stopped" | "starting" | "ready" | "busy" | "exiting";

interface Job {
  id: number;
  path: string;
  resolve: (result: WorkerResult) => void;
  /** Set once the deadline passed and the worker was killed. */
  timedOut: boolean;
  sent: boolean;
}

interface Slot {
  state: SlotState;
  child: ChildProcess | null;
  job: Job | null;
  /** Failures since the last completed decode. */
  failures: number;
  restartTimer: NodeJS.Timeout | null;
  startTimer: NodeJS.Timeout | null;
  /** Why the current worker is being stopped, when the pool asked it to. */
  stopping: "retire" | "timeout" | "start-timeout" | "close" | null;
  exited: Promise<void> | null;
}

export interface ThumbnailWorkerStats {
  /** "ulimit", or null when workers run without a data limit. */
  mechanism: "ulimit" | null;
  /** The data limit a worker last reported, or null when unlimited or unknown. */
  dataLimitBytes: number | null;
  workers: Array<{ pid: number | null; state: SlotState; failures: number }>;
  spawned: number;
  crashed: number;
  timedOut: number;
  recycled: number;
  jobs: number;
}

export class ThumbnailWorkerPool {
  private readonly slots: Slot[];
  private readonly script: string;
  private readonly execArgv: string[];
  private mechanism: "ulimit" | null;
  private started = false;
  private closed = false;
  private nextJob = 1;
  private readonly waiting: Array<() => void> = [];
  private readonly counts = { spawned: 0, crashed: 0, timedOut: 0, recycled: 0, jobs: 0 };
  private reportedLimit: number | null = null;
  private announced = false;

  constructor(readonly options: ThumbnailWorkerPoolOptions) {
    this.slots = Array.from({ length: options.size }, () => ({
      state: "stopped", child: null, job: null, failures: 0,
      restartTimer: null, startTimer: null, stopping: null, exited: null,
    }));
    const ownFile = fileURLToPath(import.meta.url);
    const typescript = ownFile.endsWith(".ts");
    this.script = options.script ?? path.join(path.dirname(ownFile), `thumbnail-worker.${typescript ? "ts" : "js"}`);
    // Under tsx (tests, development) the worker needs the same loader.
    this.execArgv = options.execArgv ?? (typescript ? ["--import", import.meta.resolve("tsx")] : []);
    this.mechanism = options.dataLimitBytes !== null && process.platform === "linux" && existsSync(SHELL)
      ? "ulimit"
      : null;
  }

  /** Starts the workers now rather than at the first decode. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    if (this.options.dataLimitBytes !== null && this.mechanism === null) {
      logger.warn({ platform: process.platform }, "Thumbnail workers run without a memory limit on this system");
    }
    for (const slot of this.slots) this.spawn(slot);
  }

  /**
   * Decodes the stored file at `filePath` in a worker. `signal` stops the
   * decode: the worker is killed and the result is "timed-out". Resolves
   * once the worker is free again (after it has exited, if it was killed),
   * so the caller's admission turn covers the worker's memory. Never
   * rejects.
   */
  async run(filePath: string, signal?: AbortSignal): Promise<WorkerResult> {
    if (this.closed) return failed("thumbnail workers are shut down");
    this.start();
    let resolve!: (result: WorkerResult) => void;
    const done = new Promise<WorkerResult>((settle) => { resolve = settle; });
    const job: Job = { id: this.nextJob++, path: filePath, resolve, timedOut: false, sent: false };
    const slot = await this.reserveSlot(job, signal);
    if (!slot) {
      return signal?.aborted
        ? { ok: false, outcome: "timed-out", details: { reason: "waiting for a thumbnail worker" } }
        : failed(this.closed ? "thumbnail workers are shut down" : "thumbnail workers are restarting after repeated failures");
    }
    this.counts.jobs++;
    this.setRef(slot, true);
    const abort = () => this.abort(slot, job);
    job.resolve = (result) => {
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    if (signal?.aborted) abort();
    else {
      signal?.addEventListener("abort", abort, { once: true });
      // A starting worker is sent the job once it is ready.
      if (slot.state === "ready") this.send(slot, job);
    }
    return done;
  }

  /** Stops every worker: asks them to exit, kills any left after the grace period. */
  async close(): Promise<void> {
    this.closed = true;
    for (const wake of this.waiting.splice(0)) wake();
    const grace = this.options.closeGraceMs ?? 250;
    await Promise.all(this.slots.map(async (slot) => {
      if (slot.restartTimer) clearTimeout(slot.restartTimer);
      slot.restartTimer = null;
      const child = slot.child;
      if (!child) return;
      slot.stopping = "close";
      if (slot.state !== "exiting") slot.state = "exiting";
      if (child.connected) child.disconnect();
      const kill = setTimeout(() => child.kill("SIGKILL"), grace);
      await slot.exited;
      clearTimeout(kill);
    }));
  }

  get stats(): ThumbnailWorkerStats {
    return {
      mechanism: this.mechanism,
      dataLimitBytes: this.reportedLimit,
      workers: this.slots.map((slot) => ({ pid: slot.child?.pid ?? null, state: slot.state, failures: slot.failures })),
      ...this.counts,
    };
  }

  /**
   * Gives `job` a slot without one, preferring a ready worker, then one
   * starting; the slot is taken in the same step it is chosen. Null when
   * every free slot is waiting out a restart delay, when the pool closes,
   * or when `signal` aborts while all are busy.
   */
  private async reserveSlot(job: Job, signal?: AbortSignal): Promise<Slot | null> {
    for (;;) {
      if (this.closed || signal?.aborted) return null;
      const free = this.slots.filter((slot) => !slot.job && slot.state !== "exiting");
      const best = free.find((slot) => slot.state === "ready")
        ?? free.find((slot) => slot.state === "starting")
        ?? free.find((slot) => slot.state === "stopped" && !slot.restartTimer);
      if (best) {
        if (best.state === "stopped") this.spawn(best);
        if (best.state === "stopped") return null; // it could not be started
        best.job = job;
        return best;
      }
      if (free.length) return null; // all waiting out a restart delay
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal?.removeEventListener("abort", wake);
          const at = this.waiting.indexOf(wake);
          if (at !== -1) this.waiting.splice(at, 1);
          resolve();
        };
        this.waiting.push(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
  }

  private wakeWaiter() {
    this.waiting.shift()?.();
  }

  private spawn(slot: Slot) {
    if (this.closed) return;
    slot.restartTimer = null;
    slot.stopping = null;
    slot.state = "starting";
    const node = [process.execPath, ...this.execArgv, "--v8-pool-size=1", "--expose-gc", this.script];
    if (this.options.memoryChecks === false) node.push("--no-memory-checks");
    const limited = this.mechanism === "ulimit";
    const [command, args] = limited
      ? [SHELL, ["-c", `ulimit -d "$1" || exit ${LIMIT_REFUSED}; shift; exec "$@"`, "thumbnail-worker",
        String(Math.floor(this.options.dataLimitBytes! / 1024)), ...node]]
      : [node[0], node.slice(1)];
    const env: NodeJS.ProcessEnv = { ...WORKER_ENV };
    for (const key of WORKER_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
    let child: ChildProcess;
    try {
      child = spawn(command, args as string[], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        serialization: "advanced",
        env,
        windowsHide: true,
      });
    } catch (error) {
      slot.state = "stopped";
      slot.failures++;
      logger.warn({ err: error, failures: slot.failures }, "Could not start a thumbnail worker");
      if (slot.job) {
        const job = slot.job;
        slot.job = null;
        job.resolve(failed("thumbnail worker could not start"));
      }
      this.respawnLater(slot);
      return;
    }
    this.counts.spawned++;
    slot.child = child;
    let ended = false;
    let markExited!: () => void;
    slot.exited = new Promise((resolve) => { markExited = resolve; });
    const end = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (ended) return;
      ended = true;
      markExited();
      this.exited(slot, child, limited, code, signal, error);
    };
    child.on("exit", (code, signal) => end(code, signal));
    // A process that could not be started never emits "exit".
    child.on("error", (error) => { if (child.pid === undefined) end(null, null, error); });
    child.on("message", (message: WorkerMessage) => this.received(slot, child, message));
    slot.startTimer = setTimeout(() => {
      if (slot.child !== child || slot.state !== "starting") return;
      slot.stopping = "start-timeout";
      child.kill("SIGKILL");
    }, this.options.startTimeoutMs ?? 30_000);
    slot.startTimer.unref();
    this.setRef(slot, slot.job !== null);
  }

  private received(slot: Slot, child: ChildProcess, message: WorkerMessage) {
    if (slot.child !== child || !message || typeof message !== "object") return;
    if (message.type === "ready" && slot.state === "starting") {
      if (slot.startTimer) clearTimeout(slot.startTimer);
      slot.state = "ready";
      this.reportedLimit = typeof message.dataLimitBytes === "number" ? message.dataLimitBytes : null;
      if (this.mechanism === "ulimit" && this.reportedLimit === null && !this.announced) {
        logger.warn("Thumbnail workers report no memory limit although one was set");
      }
      if (!this.announced) {
        this.announced = true;
        logger.info(
          { workers: this.slots.length, mechanism: this.mechanism, dataLimitBytes: this.reportedLimit, oomScoreAdj: message.oomScoreAdj },
          "Thumbnail workers started",
        );
      }
      if (slot.job) this.send(slot, slot.job);
      else this.wakeWaiter();
      return;
    }
    if (message.type !== "result") return;
    const job = slot.job;
    if (!job || message.id !== job.id || job.timedOut || slot.state !== "busy") return;
    slot.failures = 0;
    slot.job = null;
    slot.state = "ready";
    job.resolve(checkedResult(message.result));
    if (this.tooBig(message.memory)) {
      this.counts.recycled++;
      this.stop(slot, "retire");
    } else {
      this.setRef(slot, false);
      this.wakeWaiter();
    }
  }

  private send(slot: Slot, job: Job) {
    if (slot.job !== job || job.timedOut || slot.state !== "ready" || !slot.child) return;
    slot.state = "busy";
    job.sent = true;
    const request: WorkerRequest = { id: job.id, path: job.path };
    slot.child.send(request, (error) => {
      if (error && slot.job === job) this.stop(slot, null); // reported as a crash on exit
    });
  }

  private abort(slot: Slot, job: Job) {
    if (slot.job !== job || job.timedOut) return;
    job.timedOut = true;
    if (!job.sent) {
      // Never reached the worker: give the slot back as it is.
      slot.job = null;
      job.resolve({ ok: false, outcome: "timed-out", details: { reason: "waiting for a thumbnail worker to start" } });
      this.setRef(slot, false);
      if (slot.state === "ready") this.wakeWaiter();
      return;
    }
    this.counts.timedOut++;
    this.stop(slot, "timeout");
  }

  /** Ends the slot's worker; `exited` reports and replaces it. */
  private stop(slot: Slot, reason: Slot["stopping"]) {
    const child = slot.child;
    if (!child || slot.state === "exiting") return;
    slot.stopping = reason;
    slot.state = "exiting";
    if (reason === "retire" && child.connected) {
      child.disconnect(); // exits on its own once the channel closes
      setTimeout(() => child.kill("SIGKILL"), this.options.closeGraceMs ?? 250).unref();
    } else {
      child.kill("SIGKILL");
    }
  }

  private exited(
    slot: Slot,
    child: ChildProcess,
    limited: boolean,
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: Error,
  ) {
    if (slot.child !== child) return;
    if (slot.startTimer) clearTimeout(slot.startTimer);
    const wasStarting = slot.state === "starting";
    const reason = slot.stopping;
    slot.child = null;
    slot.state = "stopped";
    slot.stopping = null;
    const details: WorkerDetails = { pid: child.pid, exitCode: code, signal };
    const job = slot.job;
    slot.job = null;

    // The start wrapper could not set the limit (for example under a lower
    // hard limit, which workers then inherit): start them directly from now
    // on. A decode waiting for this worker waits for the next one.
    if (limited && wasStarting && code === LIMIT_REFUSED && !reason) {
      this.mechanism = null;
      logger.warn({ dataLimitBytes: this.options.dataLimitBytes }, "Could not set the thumbnail worker memory limit; workers run without it");
      slot.job = job;
      this.spawn(slot);
      return;
    }

    if (job) {
      if (job.timedOut) {
        job.resolve({ ok: false, outcome: "timed-out", details });
      } else if (reason === "close") {
        job.resolve(failed("thumbnail workers are shut down", details));
      } else if (!job.sent) {
        job.resolve(failed("thumbnail worker could not start", details));
      } else {
        this.counts.crashed++;
        const how = error?.message ?? (signal ? `killed by ${signal}` : `exited with status ${code}`);
        job.resolve({ ok: false, outcome: "crashed", details: { ...details, reason: `worker ${how}` } });
      }
    }
    // A timed-out decode or a retired worker says nothing about the next start.
    const failure = reason !== "timeout" && reason !== "retire" && reason !== "close";
    if (failure) {
      slot.failures++;
      logger.warn({ ...details, failures: slot.failures, starting: wasStarting, err: error }, "Thumbnail worker exited");
    }
    this.respawn(slot);
  }

  private respawn(slot: Slot) {
    if (this.closed) {
      this.wakeWaiter();
      return;
    }
    if (this.restartDelay(slot) === 0) {
      this.spawn(slot);
      this.wakeWaiter();
      return;
    }
    this.respawnLater(slot);
  }

  private restartDelay(slot: Slot) {
    const { initial, max } = this.options.restartDelayMs ?? { initial: 500, max: 30_000 };
    return slot.failures <= 1 ? 0 : Math.min(max, initial * 2 ** (slot.failures - 2));
  }

  /** Restarts the slot's worker after its delay; jobs meanwhile go elsewhere or without. */
  private respawnLater(slot: Slot) {
    if (this.closed) return;
    const delay = Math.max(this.restartDelay(slot), 100);
    logger.warn({ failures: slot.failures, delayMs: delay }, "Thumbnail worker keeps failing; restarting later");
    slot.restartTimer = setTimeout(() => {
      this.spawn(slot);
      this.wakeWaiter();
    }, delay);
    slot.restartTimer.unref();
  }

  /** Idle workers never keep the server (or a test) running. */
  private setRef(slot: Slot, ref: boolean) {
    const child = slot.child as (ChildProcess & { channel?: { ref(): void; unref(): void } }) | null;
    if (!child) return;
    if (ref) {
      child.ref();
      child.channel?.ref();
    } else {
      child.unref();
      child.channel?.unref();
    }
  }

  private tooBig(memory: WorkerMemory | undefined) {
    const limit = this.options.recycleAboveBytes;
    if (!limit || !memory) return false;
    return (memory.dataBytes ?? memory.rssBytes) > limit;
  }
}

function failed(reason: string, details: WorkerDetails = {}): WorkerResult {
  return { ok: false, outcome: "failed", details: { ...details, reason } };
}

/**
 * A worker's answer, checked: a decoder bug that took over the worker can
 * still only return a small WebP or a known outcome.
 */
function checkedResult(result: DecodeResult): WorkerResult {
  const details = checkedDetails(result?.details);
  if (result?.ok === true) {
    const bytes = result.thumbnail as unknown;
    if (bytes instanceof Uint8Array && bytes.length >= 12 && bytes.length <= MAX_THUMBNAIL_BYTES) {
      const thumbnail = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (thumbnail.toString("latin1", 0, 4) === "RIFF" && thumbnail.toString("latin1", 8, 12) === "WEBP") {
        return { ok: true, thumbnail, details };
      }
    }
    return failed("the worker returned something other than a WebP", {});
  }
  const outcome = result?.ok === false && ["unsupported", "over-budget", "failed"].includes(result.outcome)
    ? result.outcome
    : "failed";
  return { ok: false, outcome, details };
}

const STAGES = new Set(["read", "signature", "detector", "container", "header", "transform"]);
const FORMAT_NAMES = new Set(["jpeg", "png", "webp", "gif", "avif"]);

function checkedDetails(details: unknown): DecodeDetails {
  if (!details || typeof details !== "object") return {};
  const d = details as Record<string, unknown>;
  const out: DecodeDetails = {};
  if (typeof d.format === "string" && FORMAT_NAMES.has(d.format)) out.format = d.format as DecodeDetails["format"];
  for (const key of ["width", "height", "estimateBytes"] as const) {
    if (typeof d[key] === "number" && Number.isFinite(d[key])) out[key] = d[key] as number;
  }
  if (typeof d.reason === "string") out.reason = d.reason.slice(0, 200);
  if (typeof d.stage === "string" && STAGES.has(d.stage)) out.stage = d.stage as DecodeDetails["stage"];
  return out;
}
