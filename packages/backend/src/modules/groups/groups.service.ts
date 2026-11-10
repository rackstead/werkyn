import type { PrismaClient } from "@prisma/client";
import type { CreateGroupInput, UpdateGroupInput } from "@pm/shared";
import { ConflictError, NotFoundError } from "../../utils/errors.js";
import { withWorkspaceLock } from "../../utils/workspace-lock.js";

export async function createGroup(
  prisma: PrismaClient,
  workspaceId: string,
  input: CreateGroupInput,
) {
  return prisma.$transaction(async (tx) => {
    const group = await tx.group.create({
      data: {
        workspaceId,
        name: input.name,
        description: input.description ?? null,
        color: input.color ?? "#6366f1",
      },
    });

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

      await tx.groupMember.createMany({
        data: input.memberIds
          .filter((uid) => validUserIds.has(uid))
          .map((userId) => ({
            groupId: group.id,
            userId,
          })),
      });
    }

    return {
      ...group,
      _count: { members: input.memberIds?.length ?? 0 },
    };
  });
}

export async function listGroups(
  prisma: PrismaClient,
  workspaceId: string,
) {
  return prisma.group.findMany({
    where: { workspaceId },
    include: {
      _count: { select: { members: true } },
    },
    orderBy: { name: "asc" },
  });
}

export async function getGroup(
  prisma: PrismaClient,
  workspaceId: string,
  groupId: string,
) {
  const group = await prisma.group.findFirst({
    where: { id: groupId, workspaceId },
    include: {
      members: {
        include: {
          user: {
            select: { id: true, displayName: true, email: true, avatarUrl: true },
          },
        },
        orderBy: { addedAt: "asc" },
      },
      teamFolderGroups: {
        include: {
          teamFolder: {
            select: { id: true, name: true },
          },
        },
      },
      _count: { select: { members: true } },
    },
  });

  if (!group) throw new NotFoundError("Group not found");
  return group;
}

export async function updateGroup(
  prisma: PrismaClient,
  workspaceId: string,
  groupId: string,
  input: UpdateGroupInput,
) {
  const group = await prisma.group.findFirst({
    where: { id: groupId, workspaceId },
  });
  if (!group) throw new NotFoundError("Group not found");

  return prisma.group.update({
    where: { id: groupId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
    },
    include: {
      _count: { select: { members: true } },
    },
  });
}

export async function deleteGroup(
  prisma: PrismaClient,
  workspaceId: string,
  groupId: string,
) {
  // File updates re-check group grants after they take the workspace lock.
  // Deleting the group has to take that same lock so it cannot commit underneath one.
  await withWorkspaceLock(prisma, workspaceId, async (tx) => {
    const group = await tx.group.findFirst({
      where: { id: groupId, workspaceId },
    });
    if (!group) throw new NotFoundError("Group not found");

    await tx.group.delete({ where: { id: groupId } });
  });
}

export async function addMember(
  prisma: PrismaClient,
  workspaceId: string,
  groupId: string,
  userId: string,
) {
  const group = await prisma.group.findFirst({
    where: { id: groupId, workspaceId },
  });
  if (!group) throw new NotFoundError("Group not found");

  // Validate user is workspace member
  const wsMember = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  if (!wsMember) throw new NotFoundError("User is not a workspace member");

  return prisma.groupMember.create({
    data: { groupId, userId },
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
  groupId: string,
  userId: string,
) {
  // File updates re-check this grant after they take the workspace lock.
  // The delete has to take that same lock so it cannot commit underneath one.
  await withWorkspaceLock(prisma, workspaceId, async (tx) => {
    const group = await tx.group.findFirst({
      where: { id: groupId, workspaceId },
    });
    if (!group) throw new NotFoundError("Group not found");

    const member = await tx.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!member) throw new NotFoundError("Member not found");

    await tx.groupMember.delete({ where: { id: member.id } });
  });
}
