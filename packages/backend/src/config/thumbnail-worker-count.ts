import os from "node:os";

/**
 * How many thumbnail decoder processes to start.
 * Unset (or blank) keeps today's pool: one worker on fewer than four CPUs,
 * two otherwise, the same count admission uses for concurrent decodes.
 * Set to 1 to run a single worker on a small pod. 2 forces two workers.
 * Anything else is rejected at startup.
 */
export const THUMBNAIL_WORKER_COUNT_MESSAGE =
  "THUMBNAIL_WORKERS must be a whole number from 1 to 2";

/** Pool size when THUMBNAIL_WORKERS is unset. Same rule as admission's maxActive. */
export function defaultThumbnailWorkerCount(cpus = os.availableParallelism()): number {
  return Math.max(1, Math.min(2, Math.floor(cpus / 2)));
}

/**
 * The worker-pool size for `raw` (the THUMBNAIL_WORKERS value).
 * Blank keeps the CPU default. A non-integer, zero, or negative value throws.
 */
export function thumbnailWorkerCount(raw: string | undefined, cpus = os.availableParallelism()): number {
  if (raw === undefined || raw.trim() === "") return defaultThumbnailWorkerCount(cpus);
  const text = raw.trim();
  // Digits only: "1.5", "2.0", "1e1" and "-1" are not a whole number here.
  if (!/^[0-9]+$/.test(text)) throw new Error(THUMBNAIL_WORKER_COUNT_MESSAGE);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2) {
    throw new Error(THUMBNAIL_WORKER_COUNT_MESSAGE);
  }
  return value;
}

/** The count env.ts accepted, when that module has already been loaded. */
let accepted: number | undefined;

/** Remember the count from startup validation so the pool does not parse again. */
export function useThumbnailWorkerCount(count: number): void {
  accepted = count;
}

/**
 * The count to ask for. After env.ts has validated the variable, that value;
 * otherwise the same rules applied to `raw` (tests that load the pool alone).
 */
export function configuredThumbnailWorkerCount(raw = process.env.THUMBNAIL_WORKERS): number {
  return accepted ?? thumbnailWorkerCount(raw);
}

/** The pool never starts a worker admission will not use. */
export function cappedThumbnailWorkerCount(requested: number, maxActive: number): number {
  return Math.min(requested, maxActive);
}
