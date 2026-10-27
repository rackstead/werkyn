import type { PrismaClient } from "@prisma/client";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.js";

export interface AccessContext {
  workspaceId: string;
  userId: string;
  workspaceRole: string;
}

export async function fileAccessRole(prisma: PrismaClient, ctx: AccessContext) {
  const member = await prisma.workspaceMember.findUnique({
    where: {
      userId_workspaceId: { userId: ctx.userId, workspaceId: ctx.workspaceId },
    },
    select: { role: true },
  });
  if (!member) throw new ForbiddenError("Not a member of this workspace");
  return member.role;
}

/** Resolve the resource workspace and current role before any access shortcut. */
export async function assertFileAccess(
  prisma: PrismaClient,
  fileId: string,
  ctx: AccessContext,
  requireWrite = false,
  allowTrashed = false,
) {
  const file = await prisma.file.findFirst({
    where: {
      id: fileId,
      workspaceId: ctx.workspaceId,
      ...(allowTrashed ? {} : { trashedAt: null }),
    },
    select: {
      ownerId: true,
      teamFolderId: true,
      asTeamFolder: { select: { id: true } },
    },
  });
  if (!file) throw new NotFoundError("File not found");
  const role = await fileAccessRole(prisma, ctx);
  if (requireWrite && role === "VIEWER")
    throw new ForbiddenError("Read-only workspace access");
  const teamFolderId = file.asTeamFolder?.id ?? file.teamFolderId;
  const result = teamFolderId
    ? { type: "team" as const, teamFolderId }
    : { type: "personal" as const };
  // Validate team context even for admins: legacy cross-workspace relations confer no access.
  if (teamFolderId) {
    const team = await prisma.teamFolder.findFirst({
      where: {
        id: teamFolderId,
        workspaceId: ctx.workspaceId,
        folder: {
          isFolder: true,
          workspaceId: ctx.workspaceId,
          ...(allowTrashed ? {} : { trashedAt: null }),
        },
      },
      select: { id: true },
    });
    if (!team)
      throw new ForbiddenError("You do not have access to this team folder");
    if (role === "ADMIN") return result;
    const membership = await prisma.teamFolder.findFirst({
      where: {
        id: teamFolderId,
        workspaceId: ctx.workspaceId,
        OR: [
          { members: { some: { userId: ctx.userId } } },
          {
            groups: {
              some: {
                group: {
                  workspaceId: ctx.workspaceId,
                  members: { some: { userId: ctx.userId } },
                },
              },
            },
          },
        ],
      },
      select: { id: true },
    });
    if (membership) return result;
    throw new ForbiddenError("You do not have access to this team folder");
  }
  if (role === "ADMIN" || file.ownerId === ctx.userId) return result;
  throw new ForbiddenError("You do not have access to this file");
}

/** Authorize the actual destination before storage or database writes. */
export async function resolveFileDestination(
  prisma: PrismaClient,
  ctx: AccessContext,
  parentId?: string | null,
  requestedTeamFolderId?: string | null,
) {
  const role = await fileAccessRole(prisma, ctx);
  if (role === "VIEWER") throw new ForbiddenError("Read-only workspace access");
  let resolvedParentId = parentId || null;
  if (!resolvedParentId && requestedTeamFolderId) {
    const team = await prisma.teamFolder.findFirst({
      where: { id: requestedTeamFolderId, workspaceId: ctx.workspaceId },
      select: { folderId: true },
    });
    if (!team) throw new NotFoundError("Team folder not found");
    resolvedParentId = team.folderId;
  }
  if (!resolvedParentId)
    return { parentId: null, teamFolderId: null, ownerId: ctx.userId };
  await assertFileAccess(prisma, resolvedParentId, ctx, true);
  const parent = await prisma.file.findFirst({
    where: {
      id: resolvedParentId,
      workspaceId: ctx.workspaceId,
      isFolder: true,
      trashedAt: null,
    },
    select: {
      ownerId: true,
      teamFolderId: true,
      asTeamFolder: { select: { id: true } },
    },
  });
  if (!parent)
    throw new ValidationError("Destination must be an active folder");
  const teamFolderId = parent.asTeamFolder?.id ?? parent.teamFolderId;
  if (
    requestedTeamFolderId !== undefined &&
    requestedTeamFolderId !== teamFolderId
  )
    throw new ValidationError(
      "Destination team folder does not match its parent",
    );
  // Preserve the personal folder's owner when an administrator writes there.
  return {
    parentId: resolvedParentId,
    teamFolderId,
    ownerId: teamFolderId ? null : parent.ownerId,
  };
}
