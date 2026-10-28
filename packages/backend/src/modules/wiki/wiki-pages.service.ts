import type { PrismaClient, Prisma } from "@prisma/client";
import type {
  CreateWikiPageInput,
  UpdateWikiPageInput,
  MoveWikiPageInput,
} from "@pm/shared";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.js";
import { batches, graphLimits } from "../../utils/graph-limits.js";
import { withWorkspaceLock } from "../../utils/workspace-lock.js";

const pageSelect = {
  id: true,
  spaceId: true,
  parentId: true,
  title: true,
  icon: true,
  position: true,
  createdById: true,
  lastEditedById: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, displayName: true, avatarUrl: true } },
  lastEditedBy: { select: { id: true, displayName: true, avatarUrl: true } },
} satisfies Prisma.WikiPageSelect;

const pageWithContentSelect = {
  ...pageSelect,
  content: true,
} satisfies Prisma.WikiPageSelect;

type Tx = Prisma.TransactionClient;

function invalidPageTree(): never {
  throw new ConflictError("Invalid page hierarchy");
}

function pageTreeTooLarge(): never {
  throw new ConflictError("Page tree exceeds the supported depth or size");
}

/** Re-reads the actor's current role after the workspace lock. */
export async function assertWikiRole(
  tx: Tx,
  workspaceId: string,
  actorId: string,
  roles: readonly string[],
) {
  const member = await tx.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId: actorId, workspaceId } },
    select: { role: true },
  });
  if (!member) throw new ForbiddenError("Not a member of this workspace");
  if (!roles.includes(member.role))
    throw new ForbiddenError("Insufficient permissions");
}

async function findSpace(tx: Tx, workspaceId: string, spaceId: string) {
  const space = await tx.wikiSpace.findFirst({
    where: { id: spaceId, workspaceId },
    select: { id: true },
  });
  if (!space) throw new NotFoundError("Wiki space not found");
  return space;
}

async function findPage(tx: Tx, workspaceId: string, pageId: string) {
  const page = await tx.wikiPage.findFirst({
    where: { id: pageId, space: { workspaceId } },
    select: { id: true, spaceId: true, parentId: true },
  });
  if (!page) throw new NotFoundError("Wiki page not found");
  return page;
}

/**
 * Collects the ids of every descendant of `rootId` level by level. A cycle,
 * a child in another space or an exhausted budget rejects the operation, so a
 * move never leaves part of a tree behind and a delete never lets the parent
 * cascade reach pages outside the space.
 */
async function collectSubtree(tx: Tx, rootId: string, spaceId: string) {
  const seen = new Set([rootId]);
  const descendants: string[] = [];
  let parents = [rootId];
  for (let depth = 1; parents.length; depth++) {
    const children: Array<{ id: string; spaceId: string }> = [];
    for (const batch of batches(parents))
      children.push(
        ...(await tx.wikiPage.findMany({
          where: { parentId: { in: batch } },
          select: { id: true, spaceId: true },
        })),
      );
    if (children.length === 0) break;
    if (depth > graphLimits.maxDepth) pageTreeTooLarge();
    parents = [];
    for (const child of children) {
      if (seen.has(child.id) || child.spaceId !== spaceId) invalidPageTree();
      if (descendants.length >= graphLimits.maxNodes) pageTreeTooLarge();
      seen.add(child.id);
      descendants.push(child.id);
      parents.push(child.id);
    }
  }
  return descendants;
}

/** Rewrites one sibling group to 0..n-1 in the given order. */
async function renumber(
  tx: Tx,
  ordered: Array<{ id: string; position: number }>,
  data: (id: string) => Prisma.WikiPageUncheckedUpdateInput = () => ({}),
) {
  for (let i = 0; i < ordered.length; i++) {
    const extra = data(ordered[i].id);
    if (ordered[i].position !== i || Object.keys(extra).length > 0)
      await tx.wikiPage.update({
        where: { id: ordered[i].id },
        data: { position: i, ...extra },
      });
  }
}

function siblings(
  tx: Tx,
  spaceId: string,
  parentId: string | null,
  excludeId: string,
) {
  return tx.wikiPage.findMany({
    where: { spaceId, parentId, id: { not: excludeId } },
    // Legacy duplicate positions get a deterministic order.
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { id: true, position: true },
  });
}

export async function createPage(
  prisma: PrismaClient,
  workspaceId: string,
  spaceId: string,
  actorId: string,
  data: CreateWikiPageInput,
) {
  // The workspace graph lock orders the parent check and MAX+1 append with
  // concurrent moves, deletes and other creates.
  return withWorkspaceLock(prisma, workspaceId, async (tx) => {
    await assertWikiRole(tx, workspaceId, actorId, ["ADMIN", "MEMBER"]);
    await findSpace(tx, workspaceId, spaceId);

    if (data.parentId) {
      const parent = await tx.wikiPage.findFirst({
        where: { id: data.parentId, spaceId },
        select: { id: true },
      });
      if (!parent)
        throw new NotFoundError("Parent page not found in this space");
    }

    // Position: append at end of siblings
    const maxPos = await tx.wikiPage.aggregate({
      where: { spaceId, parentId: data.parentId ?? null },
      _max: { position: true },
    });
    const position = (maxPos._max.position ?? -1) + 1;

    return tx.wikiPage.create({
      data: {
        spaceId,
        parentId: data.parentId,
        title: data.title,
        content: data.content ?? undefined,
        icon: data.icon,
        position,
        createdById: actorId,
      },
      select: pageWithContentSelect,
    });
  });
}

export async function getPageTree(
  prisma: PrismaClient,
  spaceId: string,
  parentId?: string,
) {
  if (parentId) {
    const parent = await prisma.wikiPage.findFirst({
      where: { id: parentId, spaceId },
      select: { id: true },
    });
    if (!parent) throw new NotFoundError("Parent page not found in this space");
  }
  return prisma.wikiPage.findMany({
    where: {
      spaceId,
      parentId: parentId ?? null,
    },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: {
      ...pageSelect,
      // Legacy children in another space are not part of this tree.
      _count: { select: { children: { where: { spaceId } } } },
    },
  });
}

export async function getPage(prisma: PrismaClient, pageId: string) {
  const page = await prisma.wikiPage.findUnique({
    where: { id: pageId },
    select: pageWithContentSelect,
  });
  if (!page) throw new NotFoundError("Wiki page not found");
  return page;
}

export async function updatePage(
  prisma: PrismaClient,
  pageId: string,
  actorId: string,
  data: UpdateWikiPageInput,
) {
  const existing = await prisma.wikiPage.findUnique({
    where: { id: pageId },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError("Wiki page not found");

  const updateData: Prisma.WikiPageUpdateInput = {
    lastEditedBy: { connect: { id: actorId } },
  };
  if (data.title !== undefined) updateData.title = data.title;
  if (data.content !== undefined) updateData.content = data.content;
  if (data.icon !== undefined) updateData.icon = data.icon;

  return prisma.wikiPage.update({
    where: { id: pageId },
    data: updateData,
    select: pageWithContentSelect,
  });
}

export async function deletePage(
  prisma: PrismaClient,
  workspaceId: string,
  actorId: string,
  pageId: string,
) {
  return withWorkspaceLock(prisma, workspaceId, async (tx) => {
    await assertWikiRole(tx, workspaceId, actorId, ["ADMIN"]);
    const existing = await findPage(tx, workspaceId, pageId);
    // Validate the whole subtree before the parent cascade removes it.
    await collectSubtree(tx, pageId, existing.spaceId);
    await tx.wikiPage.delete({ where: { id: pageId } });
    return existing;
  });
}

export async function movePage(
  prisma: PrismaClient,
  workspaceId: string,
  actorId: string,
  pageId: string,
  data: MoveWikiPageInput,
) {
  // Source, destination, ancestry, subtree and sibling reads all happen after
  // the workspace graph lock, so concurrent moves cannot combine into a cycle
  // and no page joins or leaves the subtree between validation and writes.
  return withWorkspaceLock(prisma, workspaceId, async (tx) => {
    await assertWikiRole(tx, workspaceId, actorId, ["ADMIN", "MEMBER"]);
    const existing = await findPage(tx, workspaceId, pageId);

    // Destinations resolve only inside the source workspace; a separate
    // transfer flow would be needed to move pages between workspaces.
    const targetSpaceId = data.spaceId ?? existing.spaceId;
    if (targetSpaceId !== existing.spaceId)
      await findSpace(tx, workspaceId, targetSpaceId);
    // An omitted parentId keeps the current parent, which must then also be
    // in the target space; pass null to move to the target space root.
    const targetParentId =
      data.parentId !== undefined ? data.parentId : existing.parentId;

    if (targetParentId) {
      if (targetParentId === pageId)
        throw new ValidationError("Cannot move page under itself");
      const ancestors = new Set<string>();
      let ancestorId: string | null = targetParentId;
      while (ancestorId) {
        if (ancestorId === pageId)
          throw new ValidationError(
            "Cannot move page under its own descendant",
          );
        if (ancestors.has(ancestorId)) invalidPageTree();
        if (ancestors.size >= graphLimits.maxDepth) pageTreeTooLarge();
        ancestors.add(ancestorId);
        const ancestor: { parentId: string | null } | null =
          await tx.wikiPage.findFirst({
            where: { id: ancestorId, spaceId: targetSpaceId },
            select: { parentId: true },
          });
        if (!ancestor) {
          if (ancestorId === targetParentId)
            throw new NotFoundError("Parent page not found in this space");
          invalidPageTree();
        }
        ancestorId = ancestor.parentId;
      }
    }

    const descendants = await collectSubtree(tx, pageId, existing.spaceId);
    if (targetSpaceId !== existing.spaceId)
      for (const batch of batches(descendants))
        await tx.wikiPage.updateMany({
          where: { id: { in: batch } },
          data: { spaceId: targetSpaceId },
        });

    const sameGroup =
      targetSpaceId === existing.spaceId &&
      targetParentId === existing.parentId;
    if (!sameGroup)
      await renumber(
        tx,
        await siblings(tx, existing.spaceId, existing.parentId, pageId),
      );
    const target: Array<{ id: string; position: number }> = await siblings(
      tx,
      targetSpaceId,
      targetParentId,
      pageId,
    );
    target.splice(Math.min(data.position, target.length), 0, {
      id: pageId,
      position: -1,
    });
    // Only the subtree root changes parent; internal edges and ids are kept.
    await renumber(tx, target, (id) =>
      id === pageId ? { spaceId: targetSpaceId, parentId: targetParentId } : {},
    );

    const page = await tx.wikiPage.findUnique({
      where: { id: pageId },
      select: pageSelect,
    });
    return {
      page,
      previous: { spaceId: existing.spaceId, parentId: existing.parentId },
    };
  });
}

/**
 * Follows parents only inside the page's own space, so a legacy foreign
 * parent's title is never read into the response. A cycle or an exhausted
 * depth budget is reported instead of looping.
 */
export async function getBreadcrumbs(prisma: PrismaClient, pageId: string) {
  const start = await prisma.wikiPage.findUnique({
    where: { id: pageId },
    select: { spaceId: true },
  });
  if (!start) throw new NotFoundError("Wiki page not found");
  const breadcrumbs: Array<{ id: string; title: string; icon: string | null }> =
    [];
  const visited = new Set<string>();

  let currentId: string | null = pageId;
  while (currentId) {
    if (visited.has(currentId)) invalidPageTree();
    if (visited.size >= graphLimits.maxDepth) pageTreeTooLarge();
    visited.add(currentId);
    const node: {
      id: string;
      title: string;
      icon: string | null;
      parentId: string | null;
    } | null = await prisma.wikiPage.findFirst({
      where: { id: currentId, spaceId: start.spaceId },
      select: { id: true, title: true, icon: true, parentId: true },
    });
    if (!node) break;
    breadcrumbs.unshift({ id: node.id, title: node.title, icon: node.icon });
    currentId = node.parentId;
  }

  return breadcrumbs;
}
