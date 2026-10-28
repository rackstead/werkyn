type ShutdownLog = {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  fatal: (...args: any[]) => void;
};

export interface ShutdownStep {
  name: string;
  run: () => unknown;
  /**
   * The step's own budget. When it runs out the step is logged as failed and
   * the next step starts, so one stalled step cannot keep later ones (such as
   * signalling Dex) from running before the overall deadline.
   */
  timeoutMs?: number;
}

async function runStep(step: ShutdownStep): Promise<void> {
  if (step.timeoutMs === undefined) {
    await step.run();
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${step.name} did not finish within ${step.timeoutMs} ms`)),
      step.timeoutMs,
    );
  });
  try {
    await Promise.race([Promise.resolve().then(step.run), budget]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ShutdownOptions {
  log: ShutdownLog;
  steps: ShutdownStep[];
  exit?: (code: number) => void;
  /** Must stay below the orchestrator's kill grace period (Docker: 10 s). */
  timeoutMs?: number;
  /**
   * A repeated signal within this window is a duplicate (a terminal and a
   * process runner can both deliver one Ctrl+C) and is ignored; a later one
   * forces exit.
   */
  forceAfterMs?: number;
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
  forceAfterMs = 1000,
}: ShutdownOptions) {
  let startedAt: number | undefined;
  let exited = false;
  const finish = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  return async function shutdown(signal?: string): Promise<void> {
    if (startedAt !== undefined) {
      if (Date.now() - startedAt < forceAfterMs) return;
      log.warn({ signal }, "Shutdown already in progress; forcing exit");
      finish(1);
      return;
    }
    startedAt = Date.now();
    log.info({ signal }, "Shutting down...");

    let current: string | undefined;
    const deadline = setTimeout(() => {
      log.fatal(
        { timeoutMs, step: current },
        `Shutdown did not finish in time (waiting on ${current ?? "nothing"}); exiting`,
      );
      finish(1);
    }, timeoutMs);
    deadline.unref?.();

    let failed = false;
    for (const step of steps) {
      current = step.name;
      try {
        await runStep(step);
      } catch (err) {
        failed = true;
        log.error({ err, step: step.name }, `Shutdown step failed: ${step.name}`);
      }
    }
    current = undefined;
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
