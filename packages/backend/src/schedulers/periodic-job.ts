interface JobLogger {
  error(obj: unknown, msg?: string): void;
}

export interface PeriodicJob {
  /** Runs the job now, or returns the run in progress. Does nothing once stopped. */
  run(): Promise<void>;
  /**
   * Stops scheduling runs, signals the run in progress to stop at its next
   * safe point, and waits for it to return.
   */
  stop(): Promise<void>;
}

export interface PeriodicJobOptions {
  name: string;
  /**
   * The job. The signal is aborted by stop(); a long job checks it between
   * units of work and returns early, leaving the rest for a later run.
   */
  run: (signal: AbortSignal) => Promise<unknown>;
  intervalMs: number;
  /** Delay before the first run; defaults to one interval. */
  initialDelayMs?: number;
  log: JobLogger;
}

/**
 * Runs a job on a timer. Runs never overlap: a timer firing while a run is in
 * progress joins that run instead of starting a second one. A failed run is
 * logged and the next one still starts on schedule.
 */
export function startPeriodicJob({
  name,
  run: job,
  intervalMs,
  initialDelayMs = intervalMs,
  log,
}: PeriodicJobOptions): PeriodicJob {
  const controller = new AbortController();
  let running: Promise<void> | undefined;

  const run = () => {
    if (controller.signal.aborted) return running ?? Promise.resolve();
    running ??= Promise.resolve()
      .then(() => job(controller.signal))
      .then(
        () => undefined,
        (err) => log.error(err, `Scheduled job failed: ${name}`),
      )
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  const initial = setTimeout(run, initialDelayMs);
  const interval = setInterval(run, intervalMs);
  return {
    run,
    async stop() {
      controller.abort();
      clearTimeout(initial);
      clearInterval(interval);
      await running;
    },
  };
}
