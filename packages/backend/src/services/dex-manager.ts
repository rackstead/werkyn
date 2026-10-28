import { spawn, type ChildProcess } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env.js";
import { generateDexConfig } from "./dex-config.js";

export interface DexManagerOptions {
  /** How long Dex gets to exit after SIGTERM before it is sent SIGKILL. */
  stopTimeoutMs?: number;
  /** How long to wait for Dex to exit after SIGKILL. */
  killTimeoutMs?: number;
  /** Delay before the first respawn after Dex fails; doubles on each failure. */
  restartDelayMs?: number;
  /** Upper bound for the respawn delay. */
  maxRestartDelayMs?: number;
  /** A Dex that stays up this long resets the respawn delay. */
  stableRunMs?: number;
  /** Path of the Dex binary, read on each start. */
  binaryPath?: () => string;
}

function exited(proc: ChildProcess): boolean {
  return (
    proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null
  );
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (exited(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      proc.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    proc.once("exit", onExit);
  });
}

/**
 * Runs the embedded Dex identity provider as a child process.
 *
 * start(), restart() and stop() are serialized: each lifecycle change waits for
 * the previous one, so at most one Dex process exists at a time. Restarts that
 * are requested while another is still waiting to run share it, and a restart
 * that begins after stop() does not spawn Dex.
 */
export class DexManager {
  private process: ChildProcess | null = null;
  private prisma: PrismaClient | null = null;
  private logger: FastifyBaseLogger | null = null;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private queuedReconcile: Promise<void> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;

  private readonly stopTimeoutMs: number;
  private readonly killTimeoutMs: number;
  private readonly restartDelayMs: number;
  private readonly maxRestartDelayMs: number;
  private readonly stableRunMs: number;
  private readonly binaryPath: () => string;

  constructor(options: DexManagerOptions = {}) {
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.killTimeoutMs = options.killTimeoutMs ?? 2_000;
    this.restartDelayMs = options.restartDelayMs ?? 2_000;
    this.maxRestartDelayMs = options.maxRestartDelayMs ?? 60_000;
    this.stableRunMs = options.stableRunMs ?? 60_000;
    this.binaryPath = options.binaryPath ?? (() => env.DEX_BINARY_PATH);
  }

  get isRunning(): boolean {
    return this.process !== null && !exited(this.process);
  }

  start(prisma: PrismaClient, logger: FastifyBaseLogger): Promise<void> {
    this.prisma = prisma;
    this.logger = logger;
    this.stopped = false;
    this.failures = 0;
    return this.reconcile();
  }

  /** Applies the saved SSO settings: (re)starts Dex, or stops it if SSO is off. */
  restart(prisma: PrismaClient): Promise<void> {
    this.prisma = prisma;
    this.failures = 0;
    return this.reconcile();
  }

  /** Stops Dex and keeps it stopped until start() is called again. */
  stop(): Promise<void> {
    this.stopped = true;
    this.clearRestartTimer();
    return this.enqueue(() => this.stopProcess());
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => {});
    return run;
  }

  private reconcile(): Promise<void> {
    // Requests made before a queued reconcile starts read the settings it
    // reads, so they can share it.
    if (this.queuedReconcile) return this.queuedReconcile;
    const run = this.enqueue(async () => {
      this.queuedReconcile = null;
      await this.applySettings();
    });
    this.queuedReconcile = run;
    return run;
  }

  private async applySettings(): Promise<void> {
    this.clearRestartTimer();
    await this.stopProcess();

    const prisma = this.prisma;
    if (this.stopped || !prisma) return;

    if (!(await this.canStart(prisma))) {
      this.logger?.info(
        "SSO not enabled or no connectors — Dex is not running",
      );
      return;
    }
    if (this.stopped) return;

    let configPath: string;
    try {
      configPath = await generateDexConfig(prisma);
    } catch (err) {
      this.logger?.error(err, "Failed to generate Dex config");
      return;
    }
    if (this.stopped) return;

    this.spawnProcess(configPath);
  }

  private async canStart(prisma: PrismaClient): Promise<boolean> {
    const config = await prisma.ssoConfig.findUnique({
      where: { id: "singleton" },
      include: { connectors: { where: { enabled: true } } },
    });

    return !!config?.enabled && config.connectors.length > 0;
  }

  private spawnProcess(configPath: string): void {
    this.logger?.info("Starting Dex process...");
    const startedAt = Date.now();

    const binary = this.binaryPath();
    let proc: ChildProcess;
    try {
      proc = spawn(binary, ["serve", configPath], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (err) {
      this.logger?.error(err, "Failed to start Dex");
      this.scheduleRestart(0);
      return;
    }

    proc.stdout?.on("data", (data: Buffer) => {
      this.logger?.info({ dex: true }, data.toString().trim());
    });

    proc.stderr?.on("data", (data: Buffer) => {
      this.logger?.warn({ dex: true }, data.toString().trim());
    });

    // A missing or non-executable binary is reported here, without an exit
    // event. Without this listener the error would crash the server.
    proc.on("error", (err) => {
      if (proc.pid !== undefined) {
        this.logger?.error(err, "Dex process error");
        return;
      }
      this.logger?.error(err, `Failed to start Dex from ${binary}`);
      if (this.process === proc) {
        this.process = null;
        this.scheduleRestart(0);
      }
    });

    proc.on("exit", (code, signal) => {
      if (this.process !== proc) return;
      this.process = null;
      this.logger?.warn(
        `Dex exited unexpectedly (code=${code}, signal=${signal})`,
      );
      this.scheduleRestart(Date.now() - startedAt);
    });

    this.process = proc;
  }

  private scheduleRestart(uptimeMs: number): void {
    if (this.stopped) return;
    if (uptimeMs >= this.stableRunMs) this.failures = 0;
    const delay = Math.min(
      this.restartDelayMs * 2 ** Math.min(this.failures, 30),
      this.maxRestartDelayMs,
    );
    this.failures += 1;
    this.logger?.warn(`Restarting Dex in ${delay} ms`);

    this.clearRestartTimer();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.reconcile().catch((err) => {
        this.logger?.error(err, "Failed to restart Dex");
      });
    }, delay);
    this.restartTimer.unref();
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private async stopProcess(): Promise<void> {
    const proc = this.process;
    if (!proc) return;
    this.process = null;
    if (exited(proc)) return;

    proc.kill("SIGTERM");
    if (await waitForExit(proc, this.stopTimeoutMs)) return;

    this.logger?.warn(
      `Dex did not exit within ${this.stopTimeoutMs} ms of SIGTERM; sending SIGKILL`,
    );
    proc.kill("SIGKILL");
    if (!(await waitForExit(proc, this.killTimeoutMs))) {
      this.logger?.error(`Dex (pid ${proc.pid}) did not exit after SIGKILL`);
    }
  }
}

export const dexManager = new DexManager();
