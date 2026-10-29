import type { PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../utils/errors.js";
import {
  PAGE_WRITE_TRANSACTION,
  assertNotLockedByOther,
  lockPageRow,
  snapshotPage,
} from "./wiki-page-writes.js";
import { pageWithContentSelect } from "./wiki-pages.service.js";

/** Records the page as stored now, numbered after every earlier version. */
export async function createNamedVersion(
  prisma: PrismaClient,
  pageId: string,
  actorId: string,
  name: string,
) {
  return prisma.$transaction(async (tx) => {
    await lockPageRow(tx, pageId);
    return snapshotPage(tx, pageId, actorId, { name });
  }, PAGE_WRITE_TRANSACTION);
}

export async function listVersions(
  prisma: PrismaClient,
  pageId: string,
  cursor?: string,
  limit = 20,
) {
  const versions = await prisma.wikiPageVersion.findMany({
    where: { pageId },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      createdBy: { select: { id: true, displayName: true, avatarUrl: true } },
    },
  });

  const hasMore = versions.length > limit;
  if (hasMore) versions.pop();

  return {
    data: versions,
    nextCursor: hasMore ? versions[versions.length - 1].id : null,
  };
}

export async function getVersion(prisma: PrismaClient, versionId: string) {
  const version = await prisma.wikiPageVersion.findUnique({
    where: { id: versionId },
    include: {
      createdBy: { select: { id: true, displayName: true, avatarUrl: true } },
    },
  });
  if (!version) throw new NotFoundError("Version not found");
  return version;
}

/**
 * Replaces the page title and content with a version's as a new revision, so
 * a save based on the replaced revision is refused instead of undoing the
 * restore. Another user's edit lock refuses it like a save. The replaced
 * content is always recorded as a version first, however recent the last
 * auto-save version is.
 */
export async function restoreVersion(
  prisma: PrismaClient,
  versionId: string,
  actorId: string,
) {
  return prisma.$transaction(async (tx) => {
    const version = await tx.wikiPageVersion.findUnique({
      where: { id: versionId },
      select: { id: true, pageId: true, title: true, content: true },
    });
    if (!version) throw new NotFoundError("Version not found");

    const current = await lockPageRow(tx, version.pageId);
    await assertNotLockedByOther(tx, version.pageId, actorId, current);
    await snapshotPage(tx, version.pageId, actorId);

    return tx.wikiPage.update({
      where: { id: version.pageId },
      data: {
        title: version.title,
        content: version.content ?? undefined,
        lastEditedById: actorId,
        revision: { increment: 1 },
      },
      select: pageWithContentSelect,
    });
  }, PAGE_WRITE_TRANSACTION);
}
