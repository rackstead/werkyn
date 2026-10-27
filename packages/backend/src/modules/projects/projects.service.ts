import type { PrismaClient } from "@prisma/client";
import type {
  CreateProjectInput,
  UpdateProjectInput,
  ArchiveInput,
  ProjectQueryInput,
  AddProjectMemberInput,
} from "@pm/shared";
import { ConflictError, ForbiddenError, NotFoundError } from "../../utils/errors.js";
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
  // Validate target is a workspace member
  const wsMember = await prisma.workspaceMember.findUnique({
    where: {
      userId_workspaceId: { userId: data.userId, workspaceId },
    },
  });
  if (!wsMember) {
    throw new NotFoundError("User is not a workspace member");
  }

  // Check if already a project member
  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: data.userId } },
  });
  if (existing) {
    throw new ConflictError("User is already a project member");
  }

  return prisma.projectMember.create({
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
}

export async function removeProjectMember(
  prisma: PrismaClient,
  projectId: string,
  targetUserId: string,
) {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: targetUserId } },
  });
  if (!member) {
    throw new NotFoundError("Project member not found");
  }

  await prisma.$transaction(async (tx) => {
    // Unassign from all tasks in this project
    await tx.taskAssignee.deleteMany({
      where: {
        userId: targetUserId,
        task: { projectId },
      },
    });

    // Unassign from all subtasks in this project
    await tx.subtask.updateMany({
      where: {
        assigneeId: targetUserId,
        task: { projectId },
      },
      data: { assigneeId: null },
    });

    await tx.projectMember.delete({ where: { id: member.id } });
  });
  revokeProjectAccess(targetUserId, projectId);
}
