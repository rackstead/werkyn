import { Prisma, type PrismaClient } from "@prisma/client";
import { setTimeout as sleep } from "node:timers/promises";
import { AppError, NotFoundError, ValidationError } from "./errors.js";
import { logger } from "./logger.js";
import {
  isLockTimeoutError,
  isRetryableDatabaseError,
  isStatementCanceledError,
} from "./retryable-database-errors.js";

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
 * wait of the transaction at that bound, preserving each stricter nonzero
 * caller/role setting independently (55P03 when the lock timeout is exceeded).
 * Waiting for the project row can take two lock waits in a row (first for its place in
 * the row's queue, then for the holder's transaction), and lock_timeout
 * restarts for each, so this one statement is bounded by a statement_timeout,
 * which is then restored for the rest of the transaction. Either timeout on
 * this statement (57014 or 55P03) becomes ProjectBusyError here; a cancel of
 * any later statement keeps its own error.
 */
async function lockProjectOrderWithinBound(tx: Db, projectId: string) {
  // pg_settings reports integer milliseconds, including transaction-local
  // values. Do not widen a stricter statement or lock budget during acquisition.
  const settings = await tx.$queryRaw<{ name: string; timeoutMs: number }[]>`
    SELECT name, setting::integer AS "timeoutMs" FROM pg_settings
    WHERE name IN ('statement_timeout', 'lock_timeout')
  `;
  const previousStatement = settings.find((setting) => setting.name === "statement_timeout")!.timeoutMs;
  const previousLock = settings.find((setting) => setting.name === "lock_timeout")!.timeoutMs;
  const bounded = (previous: number) => `${Math.min(previous || ORDER_LOCK_TIMEOUT_MS, ORDER_LOCK_TIMEOUT_MS)}ms`;
  await tx.$executeRaw`
    SELECT set_config('statement_timeout', ${bounded(previousStatement)}, true),
           set_config('lock_timeout', ${bounded(previousLock)}, true)
  `;
  let project: LockedProject | null;
  try {
    project = await lockProjectOrder(tx, projectId);
  } catch (error) {
    // Only this statement runs under the statement timeout, so a cancel here
    // is the bound; the lock timeout may fire first on the same wait.
    if (isStatementCanceledError(error) || isLockTimeoutError(error)) throw new ProjectBusyError();
    throw error;
  }
  await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${previousStatement}ms`}, true)`;
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
 * caller's transaction (which then owns retrying and error answers). Waiting
 * for the order lock gives up after ORDER_LOCK_TIMEOUT_MS with
 * ProjectBusyError (503); every later lock wait gives up after the same bound
 * (55P03), which a new transaction also answers with ProjectBusyError. Neither
 * is retried, since the lock is still held. `work` must not have side effects outside
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

// Moves do not use writeColumnOrder. A column of n tasks was one UPDATE per
// shifted row. The statements below shift a position range, or renumber a
// column that is not already 0..n-1, in one statement. Callers hold the
// project order lock, so a concurrent delete or move cannot land between the
// shape read and the write. Archived rows are excluded: their positions do
// not count, and a move must not rewrite them.

const BOARD_POSITION_ORDER = Prisma.sql`position ASC, "createdAt" ASC, id ASC`;

function activeTasks(projectId: string, statusId: string, excludeId?: string) {
  const column = Prisma.sql`"projectId" = ${projectId} AND "statusId" = ${statusId} AND archived = false`;
  if (excludeId === undefined) return column;
  return Prisma.sql`${column} AND id <> ${excludeId}`;
}

interface ActiveColumnShape {
  count: number;
  minPosition: number | null;
  maxPosition: number | null;
  distinctPositions: number;
}

/** One aggregate row. Not the ids of the column. */
async function activeColumnShape(
  tx: Db,
  projectId: string,
  statusId: string,
  excludeId?: string,
): Promise<ActiveColumnShape> {
  const [row] = await tx.$queryRaw<Array<{
    count: number | bigint;
    minPosition: number | bigint | null;
    maxPosition: number | bigint | null;
    distinctPositions: number | bigint;
  }>>`
    SELECT COUNT(*)::int AS count,
           MIN(position)::int AS "minPosition",
           MAX(position)::int AS "maxPosition",
           COUNT(DISTINCT position)::int AS "distinctPositions"
    FROM "Task"
    WHERE ${activeTasks(projectId, statusId, excludeId)}
  `;
  const asNumber = (value: number | bigint | null) => (value === null ? null : Number(value));
  return {
    count: Number(row.count),
    minPosition: asNumber(row.minPosition),
    maxPosition: asNumber(row.maxPosition),
    distinctPositions: Number(row.distinctPositions),
  };
}

/** Positions are exactly the indexes 0..n-1, so a board index is the position. */
function isDense(shape: ActiveColumnShape) {
  return shape.count === 0
    || (shape.minPosition === 0
      && shape.maxPosition === shape.count - 1
      && shape.distinctPositions === shape.count);
}

/** Shift positions strictly after `from` down by one. Dense columns only. */
async function shiftTailDown(tx: Db, projectId: string, statusId: string, taskId: string, from: number) {
  await tx.$executeRaw`
    UPDATE "Task"
    SET position = position - 1, "updatedAt" = CURRENT_TIMESTAMP
    WHERE ${activeTasks(projectId, statusId, taskId)} AND position > ${from}
  `;
}

/** Shift position >= `to` up by one, excluding `taskId`. Dense columns only. */
async function shiftFromUp(tx: Db, projectId: string, statusId: string, taskId: string, to: number) {
  await tx.$executeRaw`
    UPDATE "Task"
    SET position = position + 1, "updatedAt" = CURRENT_TIMESTAMP
    WHERE ${activeTasks(projectId, statusId, taskId)} AND position >= ${to}
  `;
}

/**
 * One statement: the active tasks (except `excludeId`, when given) become
 * dense board positions. Rows that already have that position are not rewritten.
 */
async function renumberActive(tx: Db, projectId: string, statusId: string, excludeId?: string) {
  await tx.$executeRaw`
    UPDATE "Task" AS task
    SET position = ranked.rn, "updatedAt" = CURRENT_TIMESTAMP
    FROM (
      SELECT id, (ROW_NUMBER() OVER (ORDER BY ${BOARD_POSITION_ORDER}) - 1)::int AS rn
      FROM "Task"
      WHERE ${activeTasks(projectId, statusId, excludeId)}
    ) AS ranked
    WHERE task.id = ranked.id AND task.position IS DISTINCT FROM ranked.rn
  `;
}

/**
 * One statement: open index `to` in a column that is not dense, and compact
 * the other active tasks around it. `to` is an index into those tasks.
 */
async function openSparseSlot(tx: Db, projectId: string, statusId: string, taskId: string, to: number) {
  await tx.$executeRaw`
    UPDATE "Task" AS task
    SET position = ranked.rn, "updatedAt" = CURRENT_TIMESTAMP
    FROM (
      SELECT id,
             CASE WHEN idx >= ${to} THEN idx + 1 ELSE idx END AS rn
      FROM (
        SELECT id, (ROW_NUMBER() OVER (ORDER BY ${BOARD_POSITION_ORDER}) - 1)::int AS idx
        FROM "Task"
        WHERE ${activeTasks(projectId, statusId, taskId)}
      ) AS ordered
    ) AS ranked
    WHERE task.id = ranked.id AND task.position IS DISTINCT FROM ranked.rn
  `;
}

/**
 * One statement for a same-column move on a column that is not already dense.
 * Tasks outside the index range are compacted to their index; tasks inside
 * the range take the shifted index. The moved task itself is left for the caller.
 */
async function shiftSparseColumn(tx: Db, projectId: string, statusId: string, taskId: string, to: number) {
  await tx.$executeRaw`
    WITH ordered AS (
      SELECT id, (ROW_NUMBER() OVER (ORDER BY ${BOARD_POSITION_ORDER}) - 1)::int AS idx
      FROM "Task"
      WHERE ${activeTasks(projectId, statusId)}
    ),
    bounds AS (
      SELECT idx AS from_idx FROM ordered WHERE id = ${taskId}
    )
    UPDATE "Task" AS task
    SET position = shifted.rn, "updatedAt" = CURRENT_TIMESTAMP
    FROM (
      SELECT ordered.id,
             CASE
               WHEN bounds.from_idx < ${to} AND ordered.idx > bounds.from_idx AND ordered.idx <= ${to}
                 THEN ordered.idx - 1
               WHEN bounds.from_idx > ${to} AND ordered.idx >= ${to} AND ordered.idx < bounds.from_idx
                 THEN ordered.idx + 1
               ELSE ordered.idx
             END AS rn
      FROM ordered
      CROSS JOIN bounds
    ) AS shifted
    WHERE task.id = shifted.id AND task.id <> ${taskId} AND task.position IS DISTINCT FROM shifted.rn
  `;
}

export interface TaskMovePlacement {
  projectId: string;
  taskId: string;
  fromStatusId: string;
  toStatusId: string;
  /** 0-based index into the destination column. The schema already requires a non-negative integer. */
  toIndex: number;
  fromPosition: number;
  archived: boolean;
}

/**
 * Place `taskId` at `toIndex` and leave every active column the move touches
 * dense at 0..n-1. Returns the position to store on the moved task.
 *
 * A dense column is a range update (`position +/- 1` where position is past
 * the moved index), so a one-slot move does not rewrite the rest of the
 * column. A column with a gap or a shared position is renumbered in one
 * statement instead. Neither path reads the column's ids into the client.
 */
export async function shiftColumnsForMove(tx: Db, move: TaskMovePlacement): Promise<number> {
  const sameColumn = move.fromStatusId === move.toStatusId;
  // An archived task is not an active slot. Moving it compacts a column that
  // already had a gap, and does not shift the active tasks to make a hole.
  if (move.archived) {
    if (!sameColumn) await compactColumn(tx, move.projectId, move.fromStatusId);
    await compactColumn(tx, move.projectId, move.toStatusId);
    const shape = await activeColumnShape(tx, move.projectId, move.toStatusId);
    if (shape.count === 0) return 0;
    return Math.min(Math.max(move.toIndex, 0), shape.count - 1);
  }
  if (sameColumn) return shiftWithinColumn(tx, move);
  await closeSourceGap(tx, move);
  return openDestination(tx, move.projectId, move.toStatusId, move.taskId, move.toIndex);
}

async function shiftWithinColumn(tx: Db, move: TaskMovePlacement): Promise<number> {
  const shape = await activeColumnShape(tx, move.projectId, move.fromStatusId);
  const to = shape.count === 0 ? 0 : Math.min(move.toIndex, shape.count - 1);
  const member = isDense(shape) && move.fromPosition >= 0 && move.fromPosition < shape.count;
  if (!member) {
    await shiftSparseColumn(tx, move.projectId, move.fromStatusId, move.taskId, to);
    return to;
  }
  const from = move.fromPosition;
  if (to < from) {
    await tx.$executeRaw`
      UPDATE "Task"
      SET position = position + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE ${activeTasks(move.projectId, move.fromStatusId, move.taskId)}
        AND position >= ${to} AND position < ${from}
    `;
  } else if (to > from) {
    await tx.$executeRaw`
      UPDATE "Task"
      SET position = position - 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE ${activeTasks(move.projectId, move.fromStatusId, move.taskId)}
        AND position > ${from} AND position <= ${to}
    `;
  }
  return to;
}

async function closeSourceGap(tx: Db, move: TaskMovePlacement) {
  const shape = await activeColumnShape(tx, move.projectId, move.fromStatusId);
  const member = isDense(shape) && move.fromPosition >= 0 && move.fromPosition < shape.count;
  if (!member) {
    await renumberActive(tx, move.projectId, move.fromStatusId, move.taskId);
    return;
  }
  // The task is last: nothing after it moves, and the column stays dense.
  if (move.fromPosition >= shape.count - 1) return;
  await shiftTailDown(tx, move.projectId, move.fromStatusId, move.taskId, move.fromPosition);
}

/** Compact active tasks in place. Already-dense columns are not rewritten. */
async function compactColumn(tx: Db, projectId: string, statusId: string) {
  const shape = await activeColumnShape(tx, projectId, statusId);
  if (isDense(shape)) return;
  await renumberActive(tx, projectId, statusId);
}

async function openDestination(
  tx: Db,
  projectId: string,
  statusId: string,
  taskId: string,
  toIndex: number,
): Promise<number> {
  const shape = await activeColumnShape(tx, projectId, statusId, taskId);
  const to = Math.min(Math.max(toIndex, 0), shape.count);
  if (isDense(shape)) {
    if (to < shape.count) await shiftFromUp(tx, projectId, statusId, taskId, to);
    return to;
  }
  await openSparseSlot(tx, projectId, statusId, taskId, to);
  return to;
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
