import type { PrismaClient } from "@prisma/client";
import type {
  CreateTeamFolderInput,
  UpdateTeamFolderInput,
} from "@pm/shared";
import { NotFoundError } from "../../utils/errors.js";
import { fileAccessRole, teamFolderAccessWhere } from "../files/file-access.js";
import { collectDescendantFiles } from "../files/files.service.js";
import { withWorkspaceLock } from "../../utils/workspace-lock.js";

export async function createTeamFolder(
  prisma: PrismaClient,
  workspaceId: string,
  createdById: string,
  input: CreateTeamFolderInput,
) {
  return prisma.$transaction(async (tx) => {
    // Create the root folder (no ownerId, no teamFolderId for the root itself)
    const folder = await tx.file.create({
      data: {
        workspaceId,
        name: input.name,
        isFolder: true,
        uploadedById: createdById,
        ownerId: null,
        teamFolderId: null,
      },
    });

    // Create the TeamFolder record
    const teamFolder = await tx.teamFolder.create({
      data: {
        workspaceId,
        folderId: folder.id,
        name: input.name,
        description: input.description ?? null,
      },
    });

    // Add members if provided
    if (input.memberIds && input.memberIds.length > 0) {
      // Validate all users are workspace members
      const members = await tx.workspaceMember.findMany({
        where: {
          workspaceId,
          userId: { in: input.memberIds },
        },
        select: { userId: true },
      });
      const validUserIds = new Set(members.map((m) => m.userId));

      await tx.teamFolderMember.createMany({
        data: input.memberIds
          .filter((uid) => validUserIds.has(uid))
          .map((userId) => ({
            teamFolderId: teamFolder.id,
            userId,
          })),
      });
    }

    return {
      ...teamFolder,
      folder,
      _count: { members: input.memberIds?.length ?? 0 },
    };
  });
}

export async function listTeamFolders(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  workspaceRole: string,
) {
  const ctx = { workspaceId, userId, workspaceRole };
  const role = await fileAccessRole(prisma, ctx);
  const where = {
    workspaceId,
    folder: { workspaceId, isFolder: true, trashedAt: null },
    ...(role === "ADMIN" ? {} : teamFolderAccessWhere(ctx)),
  };

  return prisma.teamFolder.findMany({
    where,
    include: {
      folder: {
        select: { id: true, name: true },
      },
      _count: { select: { members: true } },
    },
    orderBy: { name: "asc" },
  });
}

export async function getTeamFolder(
  prisma: PrismaClient,
  workspaceId: string,
  teamFolderId: string,
  userId: string,
  workspaceRole: string,
) {
  const ctx = { workspaceId, userId, workspaceRole };
  const role = await fileAccessRole(prisma, ctx);
  const teamFolder = await prisma.teamFolder.findFirst({
    where: {
      id: teamFolderId,
      workspaceId,
      folder: { workspaceId, isFolder: true, trashedAt: null },
      ...(role === "ADMIN" ? {} : teamFolderAccessWhere(ctx)),
    },
    include: {
      folder: { select: { id: true, name: true } },
      members: {
        include: {
          user: {
            select: { id: true, displayName: true, email: true, avatarUrl: true },
          },
        },
        orderBy: { addedAt: "asc" },
      },
      groups: {
        where: { group: { workspaceId } },
        include: {
          group: {
            select: { id: true, name: true, color: true, _count: { select: { members: true } } },
          },
        },
      },
      _count: { select: { members: true } },
    },
  });

  if (!teamFolder) throw new NotFoundError("Team folder not found");

  return teamFolder;
}

export async function updateTeamFolder(
  prisma: PrismaClient,
  workspaceId: string,
  teamFolderId: string,
  input: UpdateTeamFolderInput,
) {
  const teamFolder = await prisma.teamFolder.findFirst({
    where: { id: teamFolderId, workspaceId },
  });
  if (!teamFolder) throw new NotFoundError("Team folder not found");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.teamFolder.update({
      where: { id: teamFolderId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
      },
      include: {
        folder: { select: { id: true, name: true } },
        _count: { select: { members: true } },
      },
    });

    // Sync root folder name
    if (input.name !== undefined) {
      await tx.file.update({
        where: { id: teamFolder.folderId },
        data: { name: input.name },
      });
    }

    return updated;
  });
}

export async function deleteTeamFolder(
  prisma: PrismaClient,
  workspaceId: string,
  teamFolderId: string,
) {
  // Deleting the root File cascades children; deleting TeamFolder cascades members.
  // The workspace graph lock orders this against moves into or out of the
  // team folder and new children, and the bounded subtree walk rejects legacy
  // foreign or cyclic rows before the cascade could reach them.
  await withWorkspaceLock(prisma, workspaceId, async (tx) => {
    const teamFolder = await tx.teamFolder.findFirst({
      where: { id: teamFolderId, workspaceId },
    });
    if (!teamFolder) throw new NotFoundError("Team folder not found");
    await collectDescendantFiles(tx, teamFolder.folderId);

    // Null out teamFolderId on children so cascade doesn't fail
    await tx.file.updateMany({
      where: { teamFolderId },
      data: { teamFolderId: null },
    });

    await tx.teamFolder.delete({ where: { id: teamFolderId } });

    // Now delete the root folder (cascades File children)
    await tx.file.delete({ where: { id: teamFolder.folderId } });
  });
}

export async function addMember(
  prisma: PrismaClient,
  workspaceId: string,
  teamFolderId: string,
  userId: string,
) {
  const teamFolder = await prisma.teamFolder.findFirst({
    where: { id: teamFolderId, workspaceId },
  });
  if (!teamFolder) throw new NotFoundError("Team folder not found");

  // Validate user is workspace member
  const wsMember = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  if (!wsMember) throw new NotFoundError("User is not a workspace member");

  return prisma.teamFolderMember.create({
    data: { teamFolderId, userId },
    include: {
      user: {
        select: { id: true, displayName: true, email: true, avatarUrl: true },
      },
    },
  });
}

export async function removeMember(
  prisma: PrismaClient,
  workspaceId: string,
  teamFolderId: string,
  userId: string,
) {
  const teamFolder = await prisma.teamFolder.findFirst({
    where: { id: teamFolderId, workspaceId },
  });
  if (!teamFolder) throw new NotFoundError("Team folder not found");

  const member = await prisma.teamFolderMember.findUnique({
    where: { teamFolderId_userId: { teamFolderId, userId } },
  });
  if (!member) throw new NotFoundError("Member not found");

  await prisma.teamFolderMember.delete({ where: { id: member.id } });
}

export async function addGroupToTeamFolder(
  prisma: PrismaClient,
  workspaceId: string,
  teamFolderId: string,
  groupId: string,
) {
  const teamFolder = await prisma.teamFolder.findFirst({
    where: { id: teamFolderId, workspaceId },
  });
  if (!teamFolder) throw new NotFoundError("Team folder not found");

  const group = await prisma.group.findFirst({
    where: { id: groupId, workspaceId },
  });
  if (!group) throw new NotFoundError("Group not found");

  return prisma.teamFolderGroup.create({
    data: { teamFolderId, groupId },
    include: {
      group: {
        select: { id: true, name: true, color: true, _count: { select: { members: true } } },
      },
    },
  });
}

export async function removeGroupFromTeamFolder(
  prisma: PrismaClient,
  workspaceId: string,
  teamFolderId: string,
  groupId: string,
) {
  const teamFolder = await prisma.teamFolder.findFirst({
    where: { id: teamFolderId, workspaceId },
  });
  if (!teamFolder) throw new NotFoundError("Team folder not found");

  const tfGroup = await prisma.teamFolderGroup.findUnique({
    where: { teamFolderId_groupId: { teamFolderId, groupId } },
  });
  if (!tfGroup) throw new NotFoundError("Group assignment not found");

  await prisma.teamFolderGroup.delete({ where: { id: tfGroup.id } });
}
