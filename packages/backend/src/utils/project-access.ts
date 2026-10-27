import type { Prisma, PrismaClient } from "@prisma/client";
import { ForbiddenError, NotFoundError } from "./errors.js";

type AccessDatabase = Pick<PrismaClient, "project">;

/** Current workspace membership is required even if a stale project row remains. */
export function projectAccessWhere(
  workspaceId: string,
  userId: string,
): Prisma.ProjectWhereInput {
  return {
    workspaceId,
    workspace: { members: { some: { userId } } },
    OR: [
      { workspace: { members: { some: { userId, role: "ADMIN" } } } },
      { members: { some: { userId } } },
    ],
  };
}

/** Workspace administrators can access their projects; everyone else must join. */
export async function assertProjectAccess(
  prisma: Pick<AccessDatabase, "project">,
  projectId: string,
  userId: string,
) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      workspaceId: true,
      members: { where: { userId }, select: { id: true } },
      workspace: {
        select: { members: { where: { userId }, select: { role: true } } },
      },
    },
  });
  if (!project) throw new NotFoundError("Project not found");
  const member = project.workspace.members[0];
  if (!member) throw new ForbiddenError("Not a member of this workspace");
  if (member.role !== "ADMIN" && project.members.length === 0) {
    throw new ForbiddenError("Not a member of this project");
  }
  return { workspaceId: project.workspaceId, role: member.role };
}

export async function filterProjectRecipients(
  prisma: Pick<AccessDatabase, "project">,
  projectId: string,
  userIds: string[],
) {
  if (userIds.length === 0) return [];
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      members: { where: { userId: { in: userIds } }, select: { userId: true } },
      workspace: {
        select: { members: { where: { userId: { in: userIds } }, select: { userId: true, role: true } } },
      },
    },
  });
  if (!project) return [];
  const projectMembers = new Set(project.members.map((m) => m.userId));
  return project.workspace.members
    .filter((m) => m.role === "ADMIN" || projectMembers.has(m.userId))
    .map((m) => m.userId);
}
