import type { PrismaClient } from "@prisma/client";
import type { CreateWikiSpaceInput, UpdateWikiSpaceInput } from "@pm/shared";
import { ConflictError, NotFoundError } from "../../utils/errors.js";
import { withWorkspaceLock } from "../../utils/workspace-lock.js";

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export async function createSpace(
  prisma: PrismaClient,
  workspaceId: string,
  data: CreateWikiSpaceInput,
) {
  let slug = generateSlug(data.name);

  // The workspace lock serializes the MAX+1 append with other space writers.
  return withWorkspaceLock(prisma, workspaceId, async (tx) => {
    // Ensure slug uniqueness within workspace
    const existing = await tx.wikiSpace.findUnique({
      where: { workspaceId_slug: { workspaceId, slug } },
    });
    if (existing) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }

    // Position: append at end
    const maxPos = await tx.wikiSpace.aggregate({
      where: { workspaceId },
      _max: { position: true },
    });
    const position = (maxPos._max.position ?? -1) + 1;

    return tx.wikiSpace.create({
      data: {
        workspaceId,
        name: data.name,
        slug,
        description: data.description,
        icon: data.icon,
        position,
      },
    });
  });
}

export async function listSpaces(prisma: PrismaClient, workspaceId: string) {
  return prisma.wikiSpace.findMany({
    where: { workspaceId },
    orderBy: { position: "asc" },
    include: {
      _count: { select: { pages: true } },
    },
  });
}

export async function getSpace(prisma: PrismaClient, spaceId: string) {
  const space = await prisma.wikiSpace.findUnique({
    where: { id: spaceId },
    include: {
      _count: { select: { pages: true } },
    },
  });
  if (!space) throw new NotFoundError("Wiki space not found");
  return space;
}

export async function updateSpace(
  prisma: PrismaClient,
  workspaceId: string,
  spaceId: string,
  data: UpdateWikiSpaceInput,
) {
  return withWorkspaceLock(prisma, workspaceId, async (tx) => {
    const existing = await tx.wikiSpace.findFirst({
      where: { id: spaceId, workspaceId },
    });
    if (!existing) throw new NotFoundError("Wiki space not found");

    return tx.wikiSpace.update({
      where: { id: spaceId },
      data: {
        name: data.name,
        description: data.description,
        icon: data.icon,
        position: data.position,
      },
    });
  });
}

export async function deleteSpace(
  prisma: PrismaClient,
  workspaceId: string,
  spaceId: string,
) {
  // Ordered with page moves into or out of the space and with page creates.
  await withWorkspaceLock(prisma, workspaceId, async (tx) => {
    const existing = await tx.wikiSpace.findFirst({
      where: { id: spaceId, workspaceId },
    });
    if (!existing) throw new NotFoundError("Wiki space not found");

    // The parent cascade would also delete legacy pages of other spaces whose
    // parent lives here; refuse instead of removing content outside the space.
    const foreignChildren = await tx.wikiPage.count({
      where: { spaceId: { not: spaceId }, parent: { spaceId } },
    });
    if (foreignChildren > 0) throw new ConflictError("Invalid page hierarchy");

    await tx.wikiSpace.delete({ where: { id: spaceId } });
  });
}
