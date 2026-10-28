type ShutdownLog = {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  fatal: (...args: any[]) => void;
};

export interface ShutdownStep {
  name: string;
  run: () => unknown;
}

export interface ShutdownOptions {
  log: ShutdownLog;
  steps: ShutdownStep[];
  exit?: (code: number) => void;
  /** Must stay below the orchestrator's kill grace period (Docker: 10 s). */
  timeoutMs?: number;
}

/**
 * Builds a signal handler that runs each shutdown step once, logs every
 * failure, and exits non-zero when any step fails or the deadline passes,
 * so a broken shutdown is visible instead of an unhandled rejection.
 */
export function createShutdownHandler({
  log,
  steps,
  exit = (code) => process.exit(code),
  timeoutMs = 8000,
}: ShutdownOptions) {
  let started = false;
  let exited = false;
  const finish = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  return async function shutdown(signal?: string): Promise<void> {
    if (started) {
      log.warn({ signal }, "Shutdown already in progress; forcing exit");
      finish(1);
      return;
    }
    started = true;
    log.info({ signal }, "Shutting down...");

    const deadline = setTimeout(() => {
      log.fatal({ timeoutMs }, "Shutdown did not finish in time; exiting");
      finish(1);
    }, timeoutMs);
    deadline.unref?.();

    let failed = false;
    for (const step of steps) {
      try {
        await step.run();
      } catch (err) {
        failed = true;
        log.error({ err, step: step.name }, `Shutdown step failed: ${step.name}`);
      }
    }
    clearTimeout(deadline);

    if (failed) {
      log.fatal("Shutdown finished with errors");
      finish(1);
    } else {
      log.info("Shutdown complete");
      finish(0);
    }
  };
}
