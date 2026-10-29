import type { Prisma, PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError } from "./errors.js";
import { isRetryableDatabaseError } from "./retryable-database-errors.js";

/**
 * Workspace-row mutex shared by every writer whose correctness depends on a
 * consistent view of one workspace (admission, membership, invitations and
 * workspace policy).
 *
 * Lock order, always:
 *   1. Workspace rows, ascending by id when one operation spans several;
 *   2. rows owned by the workspace that the operation reads or writes
 *      (for admission: invite, pending request, then member rows).
 * Never take a Workspace lock after locking or writing a child row in the same
 * transaction, and never lock a User row before a Workspace row.
 *
 * The lock is `FOR NO KEY UPDATE`: it excludes every other holder, workspace
 * deletion and workspace row updates, but not the `FOR KEY SHARE` locks taken
 * by foreign-key checks, so unrelated inserts of child rows (projects, files,
 * messages) are not blocked by a short admission or graph transaction.
 *
 * Use READ COMMITTED: each statement after the lock sees every change that a
 * previous holder committed. A stronger isolation level would keep the
 * snapshot from before the wait and could act on stale policy.
 */
export async function lockWorkspace(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR NO KEY UPDATE
  `;
  return rows.length === 1;
}

/**
 * Locks several workspaces in the documented order and returns the ids that
 * exist. Callers spanning workspaces must use this rather than repeated
 * lockWorkspace calls in an arbitrary order.
 */
export async function lockWorkspaces(
  tx: Prisma.TransactionClient,
  workspaceIds: Iterable<string>,
): Promise<Set<string>> {
  const locked = new Set<string>();
  for (const id of [...new Set(workspaceIds)].sort()) {
    if (await lockWorkspace(tx, id)) locked.add(id);
  }
  return locked;
}

const LOCKED_TRANSACTION_OPTIONS = {
  isolationLevel: "ReadCommitted",
  // Waiting for the workspace lock counts toward the transaction timeout.
  maxWait: 5_000,
  timeout: 10_000,
} as const;

function isRetryableTransactionError(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  // P2034: write conflict/deadlock; P2028: transaction start/timeout failure.
  // Deadlocks and serialization failures also arrive under other Prisma error
  // classes (see the helper).
  return code === "P2034" || code === "P2028" || isRetryableDatabaseError(error);
}

/**
 * Runs `work` in a READ COMMITTED transaction after locking the workspace.
 * When the workspace does not exist (or was deleted while waiting) it returns
 * `onMissing()` if given, otherwise throws NotFoundError. A transaction the
 * database abandons (deadlock, start or lock-wait timeout) becomes a
 * retryable 409; no partial work is committed in either case.
 */
export async function withWorkspaceLock<T>(
  prisma: PrismaClient,
  workspaceId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { onMissing?: () => T } = {},
): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      if (!(await lockWorkspace(tx, workspaceId))) {
        if (options.onMissing) return options.onMissing();
        throw new NotFoundError("Workspace not found");
      }
      return work(tx);
    }, LOCKED_TRANSACTION_OPTIONS);
  } catch (error) {
    if (isRetryableTransactionError(error)) {
      throw new ConflictError("The workspace is busy. Please try again.");
    }
    throw error;
  }
}
