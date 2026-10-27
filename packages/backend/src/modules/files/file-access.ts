import type { Prisma, PrismaClient } from "@prisma/client";
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

export function teamFolderAccessWhere(
  ctx: AccessContext,
): Prisma.TeamFolderWhereInput {
  return {
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
  };
}

/** Explicit shares grant reads independently of ownership/team membership, and
 * include descendants in the same scope. UNION deduplicates legacy cycles.
 * Revoking a group does not revoke a separate explicit grant; both are checked
 * from current database state on every request.
 */
async function sharedFileIds(prisma: PrismaClient, ctx: AccessContext) {
  const files = await prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE scoped AS (
      SELECT f.id, f."parentId", f."ownerId", f."isFolder",
        COALESCE(t.id, f."teamFolderId") AS "teamFolderId"
      FROM "File" f LEFT JOIN "TeamFolder" t ON t."folderId" = f.id
      WHERE f."workspaceId" = ${ctx.workspaceId} AND f."trashedAt" IS NULL
        AND (
          (t.id IS NULL AND f."teamFolderId" IS NULL AND f."ownerId" IS NOT NULL)
          OR EXISTS (
            SELECT 1 FROM "TeamFolder" valid JOIN "File" root ON root.id = valid."folderId"
            WHERE valid.id = COALESCE(t.id, f."teamFolderId")
              AND valid."workspaceId" = ${ctx.workspaceId}
              AND root."workspaceId" = ${ctx.workspaceId} AND root."isFolder" = true AND root."trashedAt" IS NULL
          )
        )
    ), shared AS (
      SELECT f.id, f."ownerId", f."teamFolderId", f."isFolder" FROM scoped f
      JOIN "FileShare" s ON s."fileId" = f.id
      WHERE s."workspaceId" = ${ctx.workspaceId} AND s."sharedWithId" = ${ctx.userId}
      UNION
      SELECT f.id, f."ownerId", f."teamFolderId", f."isFolder" FROM scoped f
      JOIN "File" original ON original.id = f.id
      JOIN shared p ON original."parentId" = p.id AND p."isFolder" = true
      WHERE f."ownerId" IS NOT DISTINCT FROM p."ownerId"
        AND f."teamFolderId" IS NOT DISTINCT FROM p."teamFolderId"
    ) SELECT id FROM shared
  `;
  return files.map((f) => f.id);
}

export async function fileReadWhere(
  prisma: PrismaClient,
  ctx: AccessContext,
  allowTrashed = false,
): Promise<Prisma.FileWhereInput> {
  const role = await fileAccessRole(prisma, ctx);
  const validTeam: Prisma.TeamFolderWhereInput = {
    workspaceId: ctx.workspaceId,
    folder: {
      workspaceId: ctx.workspaceId,
      isFolder: true,
      ...(allowTrashed ? {} : { trashedAt: null }),
    },
  };
  // Match assertFileAccess's effective team scope, including legacy rows with
  // both root and child relations: the root relation takes precedence.
  const scope: Prisma.FileWhereInput = {
    workspaceId: ctx.workspaceId,
    ...(allowTrashed ? {} : { trashedAt: null }),
    OR: [
      { asTeamFolder: null, teamFolderId: null },
      { asTeamFolder: validTeam },
      { asTeamFolder: null, teamFolder: validTeam },
    ],
  };
  if (role === "ADMIN") return scope;
  const team = teamFolderAccessWhere(ctx);
  return {
    AND: [scope],
    OR: [
      { ownerId: ctx.userId, teamFolderId: null, asTeamFolder: null },
      { asTeamFolder: { AND: [team] } },
      { asTeamFolder: null, teamFolder: { AND: [team] } },
      { id: { in: await sharedFileIds(prisma, ctx) } },
    ],
  };
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
      where: { id: teamFolderId, ...teamFolderAccessWhere(ctx) },
      select: { id: true },
    });
    if (membership) return result;
    if (
      !requireWrite &&
      !allowTrashed &&
      (await sharedFileIds(prisma, ctx)).includes(fileId)
    )
      return result;
    throw new ForbiddenError("You do not have access to this team folder");
  }
  if (role === "ADMIN" || file.ownerId === ctx.userId) return result;
  if (
    !requireWrite &&
    !allowTrashed &&
    (await sharedFileIds(prisma, ctx)).includes(fileId)
  )
    return result;
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
