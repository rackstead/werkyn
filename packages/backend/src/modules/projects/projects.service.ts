import type { PrismaClient } from "@prisma/client";
import type {
  CreateProjectInput,
  UpdateProjectInput,
  ArchiveInput,
  ProjectQueryInput,
  AddProjectMemberInput,
} from "@pm/shared";
import { ConflictError, ForbiddenError, NotFoundError } from "../../utils/errors.js";
import { clearAssignments } from "../../utils/task-references.js";
import { withWorkspaceLock } from "../../utils/workspace-lock.js";
import { revokeProjectAccess } from "../realtime/realtime.service.js";

const DEFAULT_STATUSES = [
  { name: "To Do", color: "#94a3b8", position: 0, isCompletion: false },
  { name: "In Progress", color: "#3b82f6", position: 1, isCompletion: false },
  { name: "Done", color: "#22c55e", position: 2, isCompletion: true },
];

export async function createProject(
  prisma: PrismaClient,
  workspaceId: string,
  creatorId: string,
  data: CreateProjectInput,
) {
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        workspaceId,
        name: data.name,
        description: data.description,
        color: data.color,
        icon: data.icon,
      },
    });

    await tx.statusColumn.createMany({
      data: DEFAULT_STATUSES.map((s) => ({
        projectId: project.id,
        ...s,
      })),
    });

    await tx.projectMember.create({
      data: {
        projectId: project.id,
        userId: creatorId,
      },
    });

    return tx.project.findUnique({
      where: { id: project.id },
      include: {
        statuses: { orderBy: { position: "asc" } },
        _count: { select: { members: true, tasks: true } },
      },
    });
  });
}

export async function listProjects(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  userRole: string,
  query: ProjectQueryInput,
) {
  const where: Record<string, unknown> = {
    workspaceId,
    archived: query.archived,
  };

  if (query.search) {
    where.name = { contains: query.search, mode: "insensitive" };
  }

  // Non-admins only see projects they're members of
  if (userRole !== "ADMIN") {
    where.members = { some: { userId } };
  }

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
      include: {
        _count: { select: { members: true, tasks: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.project.count({ where }),
  ]);

  return {
    data: projects,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

export async function getProject(
  prisma: PrismaClient,
  projectId: string,
  userId: string,
  userRole: string,
) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      statuses: { orderBy: { position: "asc" } },
      _count: { select: { members: true, tasks: true } },
    },
  });

  if (!project) {
    throw new NotFoundError("Project not found");
  }

  // Non-admins must be project member
  if (userRole !== "ADMIN") {
    const isMember = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    if (!isMember) {
      throw new ForbiddenError("Not a member of this project");
    }
  }

  return project;
}

export async function updateProject(
  prisma: PrismaClient,
  projectId: string,
  data: UpdateProjectInput,
) {
  return prisma.project.update({
    where: { id: projectId },
    data,
  });
}

export async function deleteProject(
  prisma: PrismaClient,
  projectId: string,
) {
  await prisma.project.delete({ where: { id: projectId } });
}

export async function archiveProject(
  prisma: PrismaClient,
  projectId: string,
  data: ArchiveInput,
) {
  return prisma.project.update({
    where: { id: projectId },
    data: { archived: data.archived },
  });
}

export async function listProjectMembers(
  prisma: PrismaClient,
  projectId: string,
) {
  return prisma.projectMember.findMany({
    where: { projectId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          avatarUrl: true,
        },
      },
    },
    orderBy: { addedAt: "asc" },
  });
}

export async function addProjectMember(
  prisma: PrismaClient,
  projectId: string,
  workspaceId: string,
  data: AddProjectMemberInput,
) {
  // Under the workspace lock, so a concurrent workspace removal of the same
  // user either commits first (and the membership check fails) or waits for
  // this row and then deletes it with the user's other project rows.
  return withWorkspaceLock(prisma, workspaceId, async (tx) => {
    // Validate target is a workspace member
    const wsMember = await tx.workspaceMember.findUnique({
      where: {
        userId_workspaceId: { userId: data.userId, workspaceId },
      },
    });
    if (!wsMember) {
      throw new NotFoundError("User is not a workspace member");
    }

    // Check if already a project member
    const existing = await tx.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: data.userId } },
    });
    if (existing) {
      throw new ConflictError("User is already a project member");
    }

    return tx.projectMember.create({
      data: { projectId, userId: data.userId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            avatarUrl: true,
          },
        },
      },
    });
  });
}

export async function removeProjectMember(
  prisma: PrismaClient,
  projectId: string,
  targetUserId: string,
) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  if (!project) {
    throw new NotFoundError("Project not found");
  }

  // Workspace lock first, as for every membership change. Deleting the
  // membership row before clearing assignments makes the removal wait for any
  // assignment that already holds the row (task-references.ts) and makes any
  // later one see the user without access, so no assignment survives.
  await withWorkspaceLock(prisma, project.workspaceId, async (tx) => {
    const removed = await tx.projectMember.deleteMany({
      where: { projectId, userId: targetUserId },
    });
    if (removed.count === 0) {
      throw new NotFoundError("Project member not found");
    }

    // Unassign from all tasks and subtasks in this project
    await clearAssignments(tx, targetUserId, { projectId });
  });
  revokeProjectAccess(targetUserId, projectId);
}
