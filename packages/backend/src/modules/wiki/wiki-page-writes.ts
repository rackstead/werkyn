import type { Prisma } from "@prisma/client";
import { EditConflictError, NotFoundError } from "../../utils/errors.js";
import { assertWikiJson } from "./wiki-json.js";

type Tx = Prisma.TransactionClient;

/**
 * Page writes run in READ COMMITTED: after waiting for the page row, each
 * statement sees what the previous holder committed. Waiting for the row
 * counts toward the timeout; an expired wait becomes a retryable 409.
 */
export const PAGE_WRITE_TRANSACTION = {
  isolationLevel: "ReadCommitted",
  maxWait: 5_000,
  timeout: 10_000,
} as const;

export interface PageRevision {
  revision: number;
  updatedAt: Date;
}

/**
 * Locks a page row before a save, a version restore, a version snapshot or an
 * edit-lock acquisition. Every one of these takes this lock first, so for one
 * page they run one at a time: a save sees the lock that an acquisition
 * committed, version numbers are not reused and a revision check cannot be
 * overtaken between its read and its write. `FOR NO KEY UPDATE` does not block
 * the foreign-key checks of comment, share or version inserts.
 *
 * Lock order: the page row, then its lock and version rows. Moves and deletes
 * take the workspace lock and then page rows; these writers take no workspace
 * lock, so the two cannot wait for each other in a cycle.
 */
export async function lockPageRow(tx: Tx, pageId: string): Promise<PageRevision> {
  const [row] = await tx.$queryRaw<PageRevision[]>`
    SELECT "revision", "updatedAt" FROM "WikiPage"
    WHERE "id" = ${pageId}
    FOR NO KEY UPDATE
  `;
  if (!row) throw new NotFoundError("Wiki page not found");
  return row;
}

/**
 * The database's current time. Lock expiry is set and compared on this one
 * clock, so application servers with different clocks agree on it, and a
 * statement that waited for a row is judged by when it ran, not when it was
 * sent.
 */
export async function databaseNow(tx: Tx): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS now
  `;
  return now;
}

/**
 * Refuses a write while another user holds an unexpired edit lock on the page.
 * Writers without any lock (API clients, or a page nobody is editing) are not
 * affected; the caller holds the page row lock, so no lock can be acquired
 * between this check and the write.
 */
export async function assertNotLockedByOther(
  tx: Tx,
  pageId: string,
  actorId: string,
  current: PageRevision,
) {
  const lock = await tx.wikiPageLock.findUnique({
    where: { pageId },
    select: {
      userId: true,
      expiresAt: true,
      user: { select: { id: true, displayName: true } },
    },
  });
  if (!lock || lock.userId === actorId) return;
  if (lock.expiresAt <= (await databaseNow(tx))) return;
  throw new EditConflictError(
    `Page is being edited by ${lock.user.displayName}`,
    "EDIT_LOCKED",
    { ...current, lockedBy: lock.user, lockExpiresAt: lock.expiresAt },
  );
}

/** Refuses a save based on a revision other than the stored one. */
export function assertRevision(
  expectedRevision: number | undefined,
  current: PageRevision,
) {
  if (expectedRevision === undefined || expectedRevision === current.revision)
    return;
  throw new EditConflictError(
    "This page was changed after the version you edited. Reload it before saving.",
    "REVISION_CONFLICT",
    current,
  );
}

const AUTO_SAVE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Records the stored title and content of a page as its next version. The
 * caller holds the page row lock, so the snapshot is the content the following
 * write replaces and version numbers are assigned one at a time. Without a
 * name it is an auto-save version; `throttle` skips it when the previous
 * auto-save version is less than five minutes old.
 */
export async function snapshotPage(
  tx: Tx,
  pageId: string,
  actorId: string,
  { name, throttle = false }: { name?: string; throttle?: boolean } = {},
) {
  if (throttle) {
    const recent = await tx.wikiPageVersion.findFirst({
      where: { pageId, isAutoSave: true },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (recent && recent.createdAt.getTime() > Date.now() - AUTO_SAVE_INTERVAL_MS)
      return null;
  }
  const page = await tx.wikiPage.findUniqueOrThrow({
    where: { id: pageId },
    select: { title: true, content: true },
  });
  assertWikiJson(page.content, "content");
  const latest = await tx.wikiPageVersion.aggregate({
    where: { pageId },
    _max: { versionNumber: true },
  });
  return tx.wikiPageVersion.create({
    data: {
      pageId,
      title: page.title,
      content: page.content ?? undefined,
      versionNumber: (latest._max.versionNumber ?? 0) + 1,
      name,
      isAutoSave: name === undefined,
      createdById: actorId,
    },
    include: {
      createdBy: { select: { id: true, displayName: true, avatarUrl: true } },
    },
  });
}
