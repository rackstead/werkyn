import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../utils/logger.js";
import type { DecodeDetails, DecodeOutcome, DecodeResult } from "./thumbnail-decode.js";
import { FrameReader, ProtocolError, thumbnailFileLocation, type Frame, type ThumbnailFile } from "./thumbnail-protocol.js";
import type { WorkerRequest } from "./thumbnail-worker.js";

/**
 * A small pool of long-lived decoder processes for Drive thumbnails. Each
 * worker (thumbnail-worker.ts) runs sharp under a hard data limit, so an
 * image that needs more memory than its estimate said fails or ends that
 * worker, never the server. A worker that crashes or is killed at the
 * deadline is replaced at once; a worker that keeps failing to start is
 * restarted later and later. An idle worker that does not answer a ping
 * is replaced without waiting for the next decode's deadline; a worker
 * busy with a decode is not pinged and is not killed for it.
 * See docs/remediation/r19.md.
 *
 * The limit is RLIMIT_DATA, which counts a process's heap, anonymous
 * mappings and thread stacks but not the address space V8 reserves, so
 * Node runs normally under it. Node cannot set it for a child, so on Linux
 * the worker starts as `/bin/sh -c 'ulimit -d <KiB>; exec node ...'`, which
 * needs no privilege (glibc and Alpine's busybox both have it). Without
 * /bin/sh or on another platform the workers run without a limit: a crash
 * still ends only the worker, and the pre-decode checks remain the bound.
 *
 * The workers run as the server's user. Their small environment and the
 * checks on their answers keep secrets out of a worker and a malformed
 * answer out of the server, but they are not a sandbox: code that takes
 * over a worker through a decoder bug can still read what the server's
 * user can read.
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
  /** A started worker that has not reported ready by then is killed (30 s). */
  startTimeoutMs?: number;
  /**
   * After a start failure (exiting or hanging before ready, or exiting
   * while idle) the worker is restarted at once; after each further one in
   * a row, the delay doubles from `initial` up to `max`. A crash during a
   * decode is the input's doing and is restarted at once.
   */
  restartDelayMs?: { initial: number; max: number };
  /** A worker alive this long has proved it starts, and its failures are forgotten (30 s). */
  healthyAfterMs?: number;
  /**
   * A worker whose data size is over this after a decode is replaced, so
   * memory the allocator keeps does not count against the next decode.
   */
  recycleAboveBytes?: number;
  /** How long close() and retiring wait for a worker to exit before killing it (250 ms). */
  closeGraceMs?: number;
  /**
   * How often an idle worker is pinged, and how long its pong may take
   * (each 1 s). A miss replaces that worker. Far inside the 12 s decode
   * deadline, and never applied to a worker that is already decoding.
   */
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  /** The worker entry point and Node options; derived from this module by default. */
  script?: string;
  execArgv?: string[];
}

const SHELL = "/bin/sh";
/** Exit status of the start wrapper when it cannot set the limit. */
const LIMIT_REFUSED = 125;
/**
 * Environment the workers get: nothing secret, only what Node and libvips
 * need. (This keeps secrets from leaking into a worker by accident; see
 * above for what it does not do.)
 */
const WORKER_ENV_KEYS = ["PATH", "TMPDIR", "TZ", "LANG", "LC_ALL", "NODE_ENV"];
/**
 * - One libuv thread: a worker reads and decodes one file at a time, and
 *   each thread's stack counts against the data limit.
 * - glibc only (musl ignores them): two malloc arenas, and every block of
 *   128 KiB or more mapped and returned on free, so a decode does not leave
 *   hundreds of MiB in the allocator for the next one to run out of.
 */
const WORKER_ENV = { UV_THREADPOOL_SIZE: "1", MALLOC_ARENA_MAX: "2", MALLOC_MMAP_THRESHOLD_: "131072" };

type SlotState = "stopped" | "starting" | "ready" | "busy" | "exiting";

interface Job {
  id: number;
  file: ThumbnailFile;
  resolve: (result: WorkerResult) => void;
  /** Set once the deadline passed and the worker was killed. */
  timedOut: boolean;
  sent: boolean;
}

interface Slot {
  state: SlotState;
  child: ChildProcess | null;
  channel: Socket | null;
  job: Job | null;
  /** Start failures in a row (see restartDelayMs). */
  failures: number;
  readyAt: number;
  restartTimer: NodeJS.Timeout | null;
  startTimer: NodeJS.Timeout | null;
  /** Why the current worker is being stopped, when the pool asked it to. */
  stopping: "retire" | "timeout" | "start-timeout" | "close" | "violation" | "hung" | null;
  /** How the worker broke the reply protocol, if it did. */
  violation: string | null;
  exited: Promise<void> | null;
  /** Pings an idle worker; cleared once it answers or is replaced. */
  probeTimer: NodeJS.Timeout | null;
  /** The ping this worker has been asked and has not answered. */
  ping: { id: number; timer: NodeJS.Timeout; promise: Promise<boolean>; finish: (ok: boolean) => void } | null;
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
  /** Idle workers replaced because they did not answer a ping. */
  hung: number;
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
  private nextPing = 1;
  private readonly waiting: Array<() => void> = [];
  private readonly counts = { spawned: 0, crashed: 0, timedOut: 0, hung: 0, recycled: 0, jobs: 0 };
  private reportedLimit: number | null = null;
  private announced = false;

  constructor(readonly options: ThumbnailWorkerPoolOptions) {
    this.slots = Array.from({ length: options.size }, () => ({
      state: "stopped", child: null, channel: null, job: null, failures: 0, readyAt: 0,
      restartTimer: null, startTimer: null, stopping: null, violation: null, exited: null,
      probeTimer: null, ping: null,
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
   * Decodes the stored file in a worker, which opens it below its root
   * without following links (ThumbnailFile). `signal` stops the
   * decode: the worker is killed and the result is "timed-out". Resolves
   * once the worker is free again (after it has exited, if it was killed),
   * so the caller's admission turn covers the worker's memory. Never
   * rejects.
   */
  async run(file: ThumbnailFile, signal?: AbortSignal): Promise<WorkerResult> {
    if (this.closed) return failed("thumbnail workers are shut down");
    this.start();
    let resolve!: (result: WorkerResult) => void;
    const done = new Promise<WorkerResult>((settle) => { resolve = settle; });
    let settled = false;
    const job: Job = {
      id: this.nextJob++,
      file,
      resolve: (result) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        resolve(result);
      },
      timedOut: false,
      sent: false,
    };
    // The slot can change when an idle worker fails its ping and the decode
    // is tried on another worker.
    const abort = () => {
      const slot = this.slots.find((candidate) => candidate.job === job);
      if (slot) this.abort(slot, job);
      else if (!settled) {
        job.timedOut = true;
        job.resolve({ ok: false, outcome: "timed-out", details: { reason: "waiting for a thumbnail worker" } });
      }
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    let counted = false;
    while (!settled) {
      const slot = await this.reserveSlot(job, signal);
      if (settled) break;
      if (!slot) {
        job.resolve(signal?.aborted
          ? { ok: false, outcome: "timed-out", details: { reason: "waiting for a thumbnail worker" } }
          : failed(this.closed ? "thumbnail workers are shut down" : "thumbnail workers are restarting after repeated start failures"));
        break;
      }
      if (!counted) {
        this.counts.jobs++;
        counted = true;
      }
      this.setRef(slot, true);
      // Just started: ready is the proof of life, and the job is sent then.
      // Already idle: ping first, so a hung worker is replaced inside the
      // ping timeout instead of the decode deadline.
      if (slot.state === "starting") break;
      if (slot.state !== "ready" || !slot.child) {
        slot.job = null;
        this.setRef(slot, false);
        job.resolve(failed("thumbnail worker could not start"));
        break;
      }
      const child = slot.child;
      const alive = await this.prove(slot);
      if (settled) {
        if (slot.state === "ready" && !slot.job) this.armProbe(slot);
        break;
      }
      if (alive && slot.job === job && slot.state === "ready" && slot.child === child && !job.timedOut) {
        this.send(slot, job);
        break;
      }
      if (slot.job === job) {
        slot.job = null;
        this.setRef(slot, false);
        if (slot.state === "ready") this.armProbe(slot);
      }
    }
    return done;
  }

  /** Stops every worker: closes its channel, kills any left after the grace period. */
  async close(): Promise<void> {
    this.closed = true;
    for (const wake of this.waiting.splice(0)) wake();
    const grace = this.options.closeGraceMs ?? 250;
    await Promise.all(this.slots.map(async (slot) => {
      if (slot.restartTimer) clearTimeout(slot.restartTimer);
      slot.restartTimer = null;
      this.clearProbe(slot);
      const child = slot.child;
      if (!child) return;
      slot.stopping = "close";
      slot.state = "exiting";
      slot.channel?.end();
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
    slot.violation = null;
    this.clearProbe(slot);
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
      // fd 3 is the worker's channel (thumbnail-protocol.ts); its output
      // goes straight to the server's, never through the server's memory.
      child = spawn(command, args as string[], {
        stdio: ["ignore", "inherit", "inherit", "pipe"],
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
    const channel = child.stdio[3] as Socket;
    slot.child = child;
    slot.channel = channel;
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
    const reader = new FrameReader();
    channel.on("error", () => {}); // a worker gone mid-write; its exit reports it
    channel.on("data", (chunk: Buffer) => {
      if (slot.child !== child || slot.violation) return;
      let frames: Frame[];
      try {
        frames = reader.push(chunk);
      } catch (error) {
        this.violated(slot, error instanceof ProtocolError ? error.message : "an unreadable reply");
        return;
      }
      for (const frame of frames) this.received(slot, child, frame);
    });
    slot.startTimer = setTimeout(() => {
      if (slot.child !== child || slot.state !== "starting") return;
      slot.stopping = "start-timeout";
      child.kill("SIGKILL");
    }, this.options.startTimeoutMs ?? 30_000);
    slot.startTimer.unref();
    this.setRef(slot, slot.job !== null);
  }

  /** The worker sent something it should not have: it is killed, and its decode reported as a crash. */
  private violated(slot: Slot, how: string) {
    if (slot.violation) return;
    slot.violation = how;
    logger.warn({ pid: slot.child?.pid, violation: how }, "Thumbnail worker broke the reply protocol");
    this.stop(slot, "violation");
  }

  private received(slot: Slot, child: ChildProcess, frame: Frame) {
    // Nothing from a worker that is being stopped counts any more.
    if (slot.child !== child || slot.violation || slot.state === "exiting") return;
    const message = frame.header as Record<string, unknown> | null;
    if (!message || typeof message !== "object") return this.violated(slot, "a reply that is not an object");
    if (message.type === "ready") {
      if (slot.state !== "starting") return this.violated(slot, "an unexpected ready message");
      if (slot.startTimer) clearTimeout(slot.startTimer);
      slot.state = "ready";
      slot.readyAt = Date.now();
      this.reportedLimit = typeof message.dataLimitBytes === "number" ? message.dataLimitBytes : null;
      if (!this.announced) {
        this.announced = true;
        if (this.mechanism === "ulimit" && this.reportedLimit === null) {
          logger.warn("Thumbnail workers report no memory limit although one was set");
        }
        logger.info(
          { workers: this.slots.length, mechanism: this.mechanism, dataLimitBytes: this.reportedLimit, oomScoreAdj: message.oomScoreAdj },
          "Thumbnail workers started",
        );
      }
      if (slot.job) this.send(slot, slot.job);
      else {
        this.armProbe(slot);
        this.wakeWaiter();
      }
      return;
    }
    if (message.type === "pong") {
      // Only the ping we just sent, and only from an idle worker. Anything
      // else is the worker speaking out of turn.
      if (slot.state !== "ready" || !slot.ping || message.id !== slot.ping.id) {
        return this.violated(slot, "an unexpected pong");
      }
      clearTimeout(slot.ping.timer);
      const finish = slot.ping.finish;
      slot.ping = null;
      finish(true);
      return;
    }
    const job = slot.job;
    if (message.type !== "result" || !job || slot.state !== "busy" || message.id !== job.id) {
      return this.violated(slot, "an unexpected reply");
    }
    slot.failures = 0;
    slot.job = null;
    slot.state = "ready";
    job.resolve(checkedResult(message, frame.body));
    const memory = message.memory as { dataBytes?: unknown; rssBytes?: unknown } | undefined;
    const size = typeof memory?.dataBytes === "number" ? memory.dataBytes : memory?.rssBytes;
    if (this.options.recycleAboveBytes && typeof size === "number" && size > this.options.recycleAboveBytes) {
      this.counts.recycled++;
      this.stop(slot, "retire");
    } else {
      this.setRef(slot, false);
      this.armProbe(slot);
      this.wakeWaiter();
    }
  }

  /** Asks an idle worker to prove it can still read the channel. */
  private prove(slot: Slot): Promise<boolean> {
    if (slot.ping) return slot.ping.promise;
    const child = slot.child;
    const channel = slot.channel;
    if (!child || !channel || slot.state !== "ready") return Promise.resolve(false);
    if (slot.probeTimer) {
      clearTimeout(slot.probeTimer);
      slot.probeTimer = null;
    }
    const id = this.nextPing++;
    let settled = false;
    let finish!: (ok: boolean) => void;
    const promise = new Promise<boolean>((resolve) => { finish = resolve; });
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (slot.ping?.id === id) slot.ping = null;
      finish(ok);
    };
    const timer = setTimeout(() => {
      if (slot.ping?.id !== id || slot.child !== child) return;
      // A decode started inside its own deadline. Missing this ping is not
      // a reason to kill it; the caller's abort still is.
      if (slot.state === "busy" || slot.job?.sent) {
        done(false);
        return;
      }
      const held = slot.job;
      if (held && !held.sent) {
        slot.job = null;
        this.setRef(slot, false);
      }
      done(false);
      this.hung(slot);
    }, this.pingTimeout());
    timer.unref();
    slot.ping = { id, timer, promise, finish: done };
    channel.write(`${JSON.stringify({ type: "ping", id })}\n`, (error) => {
      if (!error || slot.ping?.id !== id || slot.child !== child) return;
      const held = slot.job;
      if (held && !held.sent) {
        slot.job = null;
        this.setRef(slot, false);
      }
      done(false);
      this.hung(slot);
    });
    return promise;
  }

  /** Replaces an idle worker that did not answer. A busy worker is left alone. */
  private hung(slot: Slot) {
    if (this.closed || slot.state !== "ready") return;
    this.stop(slot, "hung");
  }

  /** Pings again once this idle worker has been quiet for the interval. */
  private armProbe(slot: Slot) {
    if (slot.probeTimer) clearTimeout(slot.probeTimer);
    slot.probeTimer = null;
    if (this.closed || slot.state !== "ready" || slot.job || slot.ping) return;
    const timer = setTimeout(() => {
      slot.probeTimer = null;
      if (this.closed || slot.state !== "ready" || slot.job || slot.ping) return;
      void this.prove(slot).then((ok) => {
        if (ok && slot.state === "ready" && !slot.job && !slot.ping) this.armProbe(slot);
      });
    }, this.pingInterval());
    timer.unref();
    slot.probeTimer = timer;
  }

  private clearProbe(slot: Slot) {
    if (slot.probeTimer) clearTimeout(slot.probeTimer);
    slot.probeTimer = null;
    if (slot.ping) {
      clearTimeout(slot.ping.timer);
      const finish = slot.ping.finish;
      slot.ping = null;
      finish(false);
    }
  }

  private pingInterval() {
    return this.options.pingIntervalMs ?? 1_000;
  }

  private pingTimeout() {
    return this.options.pingTimeoutMs ?? 1_000;
  }

  private send(slot: Slot, job: Job) {
    if (slot.job !== job || job.timedOut || slot.state !== "ready" || !slot.channel) return;
    if (slot.probeTimer) {
      clearTimeout(slot.probeTimer);
      slot.probeTimer = null;
    }
    slot.state = "busy";
    job.sent = true;
    const request: WorkerRequest = { id: job.id, ...thumbnailFileLocation(job.file) };
    slot.channel.write(`${JSON.stringify(request)}\n`, (error) => {
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
      if (slot.state === "ready") {
        this.armProbe(slot);
        this.wakeWaiter();
      }
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
    if (reason === "retire") {
      slot.channel?.end(); // exits on its own once the channel closes
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
    if (slot.probeTimer) clearTimeout(slot.probeTimer);
    slot.probeTimer = null;
    if (slot.ping) {
      clearTimeout(slot.ping.timer);
      const finish = slot.ping.finish;
      slot.ping = null;
      finish(false);
    }
    const wasStarting = slot.state === "starting";
    const reason = slot.stopping;
    const violation = slot.violation;
    const aliveMs = slot.readyAt ? Date.now() - slot.readyAt : 0;
    slot.child = null;
    slot.channel = null;
    slot.state = "stopped";
    slot.stopping = null;
    slot.readyAt = 0;
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

    const decoding = job !== null && job.sent && !job.timedOut;
    if (job) {
      if (job.timedOut) {
        job.resolve({ ok: false, outcome: "timed-out", details });
      } else if (reason === "close") {
        job.resolve(failed("thumbnail workers are shut down", details));
      } else if (!job.sent && reason !== "hung") {
        // A hung idle worker never saw this decode; run() tries another slot.
        job.resolve(failed("thumbnail worker could not start", details));
      } else if (job.sent) {
        this.counts.crashed++;
        const how = violation
          ? `sent ${violation}`
          : error?.message ?? (signal ? `killed by ${signal}` : `exited with status ${code}`);
        job.resolve({ ok: false, outcome: "crashed", details: { ...details, reason: `worker ${how}` } });
      }
    }
    if (reason === "timeout" || reason === "retire" || reason === "close" || reason === "hung") {
      if (reason === "hung") {
        this.counts.hung++;
        logger.warn({ ...details }, "Thumbnail worker did not answer a liveness check; replacing it");
      }
      this.respawn(slot);
      return;
    }
    // A crash while decoding is the input's doing (it is backed off per
    // workspace, in thumbnails.ts): restart at once. Anything else that
    // ends a worker before it proved itself counts towards the delay.
    if (aliveMs >= (this.options.healthyAfterMs ?? 30_000)) slot.failures = 0;
    if (!decoding) slot.failures++;
    logger.warn(
      { ...details, failures: slot.failures, starting: wasStarting, decoding, violation, err: error },
      "Thumbnail worker exited",
    );
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
    logger.warn({ failures: slot.failures, delayMs: delay }, "Thumbnail worker keeps failing to start; restarting later");
    slot.restartTimer = setTimeout(() => {
      this.spawn(slot);
      this.wakeWaiter();
    }, delay);
    slot.restartTimer.unref();
  }

  /** Idle workers never keep the server (or a test) running. */
  private setRef(slot: Slot, ref: boolean) {
    if (!slot.child) return;
    if (ref) {
      slot.child.ref();
      slot.channel?.ref();
    } else {
      slot.child.unref();
      slot.channel?.unref();
    }
  }
}

function failed(reason: string, details: WorkerDetails = {}): WorkerResult {
  return { ok: false, outcome: "failed", details: { ...details, reason } };
}

/**
 * A worker's answer, checked: a decoder bug that took over the worker can
 * still only return a WebP of at most MAX_BODY_BYTES (thumbnail-protocol.ts)
 * or a known outcome with bounded details.
 */
function checkedResult(message: Record<string, unknown>, body: Buffer): WorkerResult {
  const details = checkedDetails(message.details);
  if (message.ok === true) {
    if (body.length >= 12 && body.toString("latin1", 0, 4) === "RIFF" && body.toString("latin1", 8, 12) === "WEBP") {
      return { ok: true, thumbnail: Buffer.from(body), details };
    }
    return failed("the worker returned something other than a WebP");
  }
  const outcome = message.ok === false && typeof message.outcome === "string" && OUTCOMES.has(message.outcome)
    ? message.outcome as DecodeOutcome
    : "failed";
  return { ok: false, outcome, details };
}

const OUTCOMES = new Set(["unsupported", "over-budget", "failed"]);
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
