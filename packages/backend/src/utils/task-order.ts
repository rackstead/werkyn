import { Prisma, type PrismaClient } from "@prisma/client";
import { setTimeout as sleep } from "node:timers/promises";
import { AppError, NotFoundError, ValidationError } from "./errors.js";
import { logger } from "./logger.js";
import { isLockTimeoutError, isRetryableDatabaseError } from "./retryable-database-errors.js";

// Task order, column and dependency-graph changes of one project are
// serialized on the project row (DAT-012, docs/remediation/dat-012.md).
//
// Each writer below takes the Project row FOR NO KEY UPDATE as its first lock
// and keeps it until commit: task create, duplicate and template
// instantiation (including the recurring scheduler), move, status change,
// archive and unarchive, bulk update and delete, single delete, subtask create
// and reorder, dependency add and remove, and column create, update, reorder
// and delete. Under READ COMMITTED every statement after the lock sees what
// the previous holder committed, so a position chosen as "last in the column",
// a renumbered column, a cycle check or a "last column" count is still true
// when the write commits.
//
// The mode excludes only the other holders, project updates (archive, rename)
// and project deletion. It does not conflict with the FOR KEY SHARE locks of
// foreign-key checks and of the reference checks in task-references.ts, so
// assignment, label, comment and other writers that do not change order run
// alongside. Being the first lock, it keeps the documented Project-first lock
// order; the recurring scheduler, which already holds the row FOR KEY SHARE,
// upgrades it (PostgreSQL lets a holder strengthen its own lock without
// queueing behind waiters).

type Db = Prisma.TransactionClient;

export interface LockedProject {
  id: string;
  archived: boolean;
}

/** Interactive transaction clients do not expose $transaction. */
function isRootClient(db: PrismaClient | Db): db is PrismaClient {
  return typeof (db as { $transaction?: unknown }).$transaction === "function";
}

/** Locks the project's order and dependency graph until commit; null when it no longer exists. */
export async function lockProjectOrder(tx: Db, projectId: string): Promise<LockedProject | null> {
  const rows = await tx.$queryRaw<LockedProject[]>`
    SELECT id, archived FROM "Project" WHERE id = ${projectId} FOR NO KEY UPDATE
  `;
  return rows[0] ?? null;
}

/** Attempts per request, including the first, when PostgreSQL aborts the transaction. */
export const ORDER_TRANSACTION_ATTEMPTS = 3;

const ORDER_TRANSACTION_OPTIONS = {
  isolationLevel: "ReadCommitted",
  maxWait: 5_000,
  timeout: 10_000,
} as const;

/**
 * Longest wait for any lock in an order transaction. Prisma's timeout does not
 * cancel a statement already waiting on a lock, and every waiting request
 * holds a pooled connection, so a project held for long would otherwise
 * starve requests for every other project. Kept well below the transaction
 * timeout and the pool's 10 s wait for a connection.
 */
export const ORDER_LOCK_TIMEOUT_MS = 5_000;

/** Answer for a lock wait that hit ORDER_LOCK_TIMEOUT_MS; the transaction wrote nothing. */
export class ProjectBusyError extends AppError {
  constructor() {
    super(503, "Service Unavailable", "The project is busy. Try again in a moment.");
  }
}

/**
 * Takes the order lock within ORDER_LOCK_TIMEOUT_MS and caps every later lock
 * wait of the transaction at the same bound (55P03 when exceeded). Waiting for
 * the project row can take two lock waits in a row (first for its place in
 * the row's queue, then for the holder's transaction), and lock_timeout
 * restarts for each, so this one statement is bounded by a statement_timeout
 * (57014), which is then restored for the rest of the transaction.
 */
async function lockProjectOrderWithinBound(tx: Db, projectId: string) {
  const bound = `${ORDER_LOCK_TIMEOUT_MS}ms`;
  const [{ previous }] = await tx.$queryRaw<{ previous: string }[]>`
    SELECT current_setting('statement_timeout') AS previous
  `;
  await tx.$executeRaw`
    SELECT set_config('statement_timeout', ${bound}, true), set_config('lock_timeout', ${bound}, true)
  `;
  const project = await lockProjectOrder(tx, projectId);
  await tx.$executeRaw`SELECT set_config('statement_timeout', ${previous}, true)`;
  return project;
}

/**
 * A deadlock or serialization failure rolled the transaction back, so running
 * it again is safe and usually succeeds. An expired transaction (P2028) has
 * already used its whole wait and is not retried; like an exhausted retry it
 * reaches the error handler as the retryable 409 (isRetryableDatabaseError).
 */
function shouldRetry(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028") return false;
  return isRetryableDatabaseError(error);
}

/** The Prisma code, or the SQLSTATE it wraps; never the message, which quotes the query. */
function errorCode(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const state = error.meta?.code;
    return typeof state === "string" ? state : error.code;
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return /\bcode: "([0-9A-Z]{5})"/.exec(error.message)?.[1];
  }
  return undefined;
}

/**
 * Runs `work` with the project's order lock held: in a new READ COMMITTED
 * transaction retried up to ORDER_TRANSACTION_ATTEMPTS times, or inside the
 * caller's transaction (which then owns retrying and error answers). Every
 * lock wait after this point gives up after ORDER_LOCK_TIMEOUT_MS; in a new
 * transaction that is answered with ProjectBusyError (503) and not retried,
 * since the lock is still held. `work` must not have side effects outside
 * the transaction, since it can run more than once.
 */
export async function withProjectOrder<T>(
  db: PrismaClient | Db,
  projectId: string,
  work: (tx: Db, project: LockedProject) => Promise<T>,
): Promise<T> {
  const locked = async (tx: Db) => {
    const project = await lockProjectOrderWithinBound(tx, projectId);
    if (!project) throw new NotFoundError("Project not found");
    return work(tx, project);
  };
  if (!isRootClient(db)) return locked(db);
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction(locked, ORDER_TRANSACTION_OPTIONS);
    } catch (error) {
      if (isLockTimeoutError(error)) throw new ProjectBusyError();
      if (attempt >= ORDER_TRANSACTION_ATTEMPTS || !shouldRetry(error)) throw error;
      // Recorded so contention on a project stays visible even when the retry succeeds.
      logger.warn(
        { projectId, attempt, attempts: ORDER_TRANSACTION_ATTEMPTS, code: errorCode(error) },
        "Retrying a project order transaction the database aborted",
      );
      // Short and jittered, so two aborted writers do not collide again in step.
      await sleep(attempt * (10 + Math.floor(Math.random() * 40)));
    }
  }
}

// ─── Positions ─────────────────────────────────────────────
//
// Invariant: the active (non-archived) tasks of a column have distinct
// positions, and the board shows them by position, then creation time, then
// id. Gaps are allowed (deleting or archiving a task leaves one). A move
// renumbers the columns it touches to 0..n-1; other writers append after the
// column's highest active position. Archived tasks keep their old position,
// which does not count, and get a new one when unarchived.

/** Board order: a total order even where rows written before this change share a position. */
const TASK_BOARD_ORDER: Prisma.TaskOrderByWithRelationInput[] = [
  { position: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
];

/** The position after the last active task of a column. Call with the order lock held. */
export async function nextTaskPosition(tx: Db, projectId: string, statusId: string) {
  const max = await tx.task.aggregate({
    where: { projectId, statusId, archived: false },
    _max: { position: true },
  });
  return (max._max.position ?? -1) + 1;
}

/** Active tasks of a column in board order, leaving out `exclude`. */
export function columnTasks(tx: Db, projectId: string, statusId: string, exclude: readonly string[] = []) {
  return tx.task.findMany({
    where: { projectId, statusId, archived: false, ...(exclude.length ? { id: { notIn: [...exclude] } } : {}) },
    orderBy: TASK_BOARD_ORDER,
    select: { id: true, position: true },
  });
}

/** Gives `ordered` positions 0..n-1, writing only the tasks whose position changes. */
export async function writeColumnOrder(tx: Db, ordered: readonly { id: string; position: number }[]) {
  for (const [index, task] of ordered.entries()) {
    if (task.position !== index) {
      await tx.task.update({ where: { id: task.id }, data: { position: index } });
    }
  }
}

/**
 * A reorder must be a permutation of everything it orders: an ID listed twice
 * or left out would leave two items on one position.
 */
export function assertCompleteOrder(orderedIds: readonly string[], existing: ReadonlySet<string>, what: string) {
  if (new Set(orderedIds).size !== orderedIds.length || orderedIds.length !== existing.size) {
    throw new ValidationError(`The order must list every ${what} exactly once`);
  }
}
