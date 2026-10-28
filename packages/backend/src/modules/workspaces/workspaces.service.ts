import type { PrismaClient, Prisma } from "@prisma/client";
import type {
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  UpdateWorkspaceMemberInput,
  UpdateWorkspaceSettingsInput,
  WorkspaceSearchInput,
  ActivityLogQueryInput,
} from "@pm/shared";
import { ConflictError, ForbiddenError, NotFoundError } from "../../utils/errors.js";
import { projectAccessWhere } from "../../utils/project-access.js";
import { withWorkspaceLock } from "../../utils/workspace-lock.js";
import { scopeTaskRelations } from "../../utils/task-scope.js";
import {
  revokeWorkspaceAccess,
  revokeWorkspaceProjects,
} from "../realtime/realtime.service.js";
import {
  assertCurrentAdmin,
  normalizeAllowedEmailDomains,
} from "../invites/admission.service.js";

export async function createWorkspace(
  prisma: PrismaClient,
  userId: string,
  data: CreateWorkspaceInput,
) {
  const existing = await prisma.workspace.findUnique({
    where: { slug: data.slug },
  });
  if (existing) {
    throw new ConflictError("Workspace slug already in use");
  }

  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: {
        name: data.name,
        slug: data.slug,
      },
    });

    await tx.workspaceMember.create({
      data: {
        userId,
        workspaceId: workspace.id,
        role: "ADMIN",
      },
    });

    return workspace;
  });
}

export async function listWorkspaces(prisma: PrismaClient, userId: string) {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    include: {
      workspace: true,
    },
    orderBy: { joinedAt: "asc" },
  });

  return memberships.map((m) => ({
    ...m.workspace,
    role: m.role,
    membershipId: m.id,
  }));
}

export async function getWorkspace(prisma: PrismaClient, workspaceId: string, userId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: {
      _count: { select: { members: true, projects: { where: projectAccessWhere(workspaceId, userId) } } },
    },
  });

  if (!workspace) {
    throw new NotFoundError("Workspace not found");
  }

  return workspace;
}

export async function updateWorkspace(
  prisma: PrismaClient,
  workspaceId: string,
  data: UpdateWorkspaceInput,
) {
  if (data.slug) {
    const existing = await prisma.workspace.findUnique({
      where: { slug: data.slug },
    });
    if (existing && existing.id !== workspaceId) {
      throw new ConflictError("Workspace slug already in use");
    }
  }

  return prisma.workspace.update({
    where: { id: workspaceId },
    data,
  });
}

export async function deleteWorkspace(
  prisma: PrismaClient,
  workspaceId: string,
) {
  await prisma.workspace.delete({ where: { id: workspaceId } });
}

export async function listMembers(
  prisma: PrismaClient,
  workspaceId: string,
) {
  return prisma.workspaceMember.findMany({
    where: { workspaceId },
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
    orderBy: { joinedAt: "asc" },
  });
}

// Membership changes take the workspace lock before any member row, so role
// changes, removals (seat release) and admission decisions serialize. READ
// COMMITTED after the lock gives each one the previous holder's committed state.
export async function updateMemberRole(
  prisma: PrismaClient,
  workspaceId: string,
  targetUserId: string,
  actorId: string,
  data: UpdateWorkspaceMemberInput,
) {
  const result = await withWorkspaceLock(prisma, workspaceId, async (tx) => {
    await assertCurrentAdmin(tx, workspaceId, actorId);
    const member = await tx.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: targetUserId, workspaceId } },
    });

    if (!member) {
      throw new NotFoundError("Member not found");
    }

    // Last-admin guard: if demoting from ADMIN, check count
    if (member.role === "ADMIN" && data.role !== "ADMIN") {
      const adminCount = await tx.workspaceMember.count({
        where: { workspaceId, role: "ADMIN" },
      });
      if (adminCount <= 1) {
        throw new ConflictError("Cannot demote the last admin");
      }
    }

    const updated = await tx.workspaceMember.update({
      where: { id: member.id },
      data: { role: data.role },
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

    // Administrators read every project; after a demotion only explicit
    // project memberships still grant access.
    const retainedProjects =
      member.role === "ADMIN" && data.role !== "ADMIN"
        ? await tx.projectMember.findMany({
            where: { userId: targetUserId, project: { workspaceId } },
            select: { projectId: true },
          })
        : null;
    return { updated, retainedProjects };
  });

  if (result.retainedProjects) {
    revokeWorkspaceProjects(
      targetUserId,
      workspaceId,
      new Set(result.retainedProjects.map((p) => p.projectId)),
    );
  }
  return result.updated;
}

export async function removeMember(
  prisma: PrismaClient,
  workspaceId: string,
  targetUserId: string,
  actorId: string,
  actorRole: string,
) {
  const isSelf = targetUserId === actorId;

  if (!isSelf && actorRole !== "ADMIN") {
    throw new ForbiddenError("Only admins can remove other members");
  }

  await withWorkspaceLock(prisma, workspaceId, async (tx) => {
    if (!isSelf) {
      await assertCurrentAdmin(
        tx,
        workspaceId,
        actorId,
        "Only admins can remove other members",
      );
    }
    const member = await tx.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: targetUserId, workspaceId } },
    });

    if (!member) {
      throw new NotFoundError("Member not found");
    }

    // Last-admin guard
    if (member.role === "ADMIN") {
      const adminCount = await tx.workspaceMember.count({
        where: { workspaceId, role: "ADMIN" },
      });
      if (adminCount <= 1) {
        throw new ConflictError("Cannot remove the last admin");
      }
    }

    await tx.workspaceMember.delete({ where: { id: member.id } });

    // Memberships inside the workspace end with it, so a later re-admission
    // starts clean instead of silently restoring old private access. DM rows
    // are kept with their history; every DM read requires the workspace
    // membership again.
    await tx.projectMember.deleteMany({
      where: { userId: targetUserId, project: { workspaceId } },
    });
    await tx.chatChannelMember.deleteMany({
      where: { userId: targetUserId, channel: { workspaceId, type: { not: "DM" } } },
    });
    await tx.teamFolderMember.deleteMany({
      where: { userId: targetUserId, teamFolder: { workspaceId } },
    });
    await tx.groupMember.deleteMany({
      where: { userId: targetUserId, group: { workspaceId } },
    });
  });

  revokeWorkspaceAccess(targetUserId, workspaceId);
}

export async function getDashboard(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  role: string,
) {
  // Admins see all projects; members/viewers see only their ProjectMember projects
  const projectWhere: Prisma.ProjectWhereInput = {
    workspaceId,
  };

  if (role !== "ADMIN") {
    projectWhere.members = { some: { userId } };
  }

  const projects = await prisma.project.findMany({
    where: projectWhere,
    select: {
      id: true,
      name: true,
      color: true,
      archived: true,
      tasks: {
        where: { archived: false },
        select: {
          id: true,
          dueDate: true,
          status: { select: { isCompletion: true } },
        },
      },
    },
    orderBy: { name: "asc" },
  });

  const today = new Date().toISOString().split("T")[0];

  const data = projects.map((project) => {
    const totalTasks = project.tasks.length;
    const completedTasks = project.tasks.filter(
      (t) => t.status.isCompletion,
    ).length;
    const overdueTasks = project.tasks.filter(
      (t) =>
        t.dueDate &&
        t.dueDate < today &&
        !t.status.isCompletion,
    ).length;

    return {
      id: project.id,
      name: project.name,
      color: project.color,
      archived: project.archived,
      totalTasks,
      completedTasks,
      overdueTasks,
    };
  });

  return { data };
}

export async function getMyTasks(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  role: string,
) {
  const projectWhere: Prisma.ProjectWhereInput = {
    workspaceId,
    archived: false,
  };

  if (role !== "ADMIN") {
    projectWhere.members = { some: { userId } };
  }

  const tasks = await prisma.task.findMany({
    where: {
      archived: false,
      assignees: { some: { userId } },
      project: projectWhere,
    },
    include: {
      project: { select: { id: true, name: true, color: true } },
      status: true,
      labels: { include: { label: true } },
      assignees: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true },
          },
        },
      },
    },
    orderBy: [{ project: { name: "asc" } }, { position: "asc" }],
  });

  return { data: tasks.map(scopeTaskRelations) };
}

export async function searchTasks(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  role: string,
  query: string,
  limit: number,
) {
  const projectWhere: Prisma.ProjectWhereInput = {
    workspaceId,
    archived: false,
  };

  if (role !== "ADMIN") {
    projectWhere.members = { some: { userId } };
  }

  // Search title matches first, then description matches
  const titleMatches = await prisma.task.findMany({
    where: {
      archived: false,
      project: projectWhere,
      title: { contains: query, mode: "insensitive" },
    },
    include: {
      project: { select: { id: true, name: true, color: true } },
      status: true,
      labels: { include: { label: true } },
      assignees: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true },
          },
        },
      },
    },
    take: limit,
    orderBy: { updatedAt: "desc" },
  });

  const remaining = limit - titleMatches.length;
  let descriptionMatches: typeof titleMatches = [];

  if (remaining > 0) {
    const titleIds = titleMatches.map((t) => t.id);
    descriptionMatches = await prisma.task.findMany({
      where: {
        archived: false,
        project: projectWhere,
        id: { notIn: titleIds },
        description: { contains: query, mode: "insensitive" },
      },
      include: {
        project: { select: { id: true, name: true, color: true } },
        status: true,
        labels: { include: { label: true } },
        assignees: {
          include: {
            user: {
              select: { id: true, displayName: true, avatarUrl: true },
            },
          },
        },
      },
      take: remaining,
      orderBy: { updatedAt: "desc" },
    });
  }

  return { data: [...titleMatches, ...descriptionMatches].map(scopeTaskRelations) };
}

export async function getWorkspaceSettings(
  prisma: PrismaClient,
  workspaceId: string,
) {
  return prisma.workspaceSettings.upsert({
    where: { workspaceId },
    create: { workspaceId },
    update: {},
  });
}

export async function updateWorkspaceSettings(
  prisma: PrismaClient,
  workspaceId: string,
  actorId: string,
  data: UpdateWorkspaceSettingsInput,
) {
  const update = data.allowedEmailDomains
    ? {
        ...data,
        allowedEmailDomains: normalizeAllowedEmailDomains(
          data.allowedEmailDomains,
        ),
      }
    : data;
  // Admission policy changes serialize with admission decisions.
  return withWorkspaceLock(prisma, workspaceId, async (tx) => {
    await assertCurrentAdmin(tx, workspaceId, actorId);
    return tx.workspaceSettings.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        ...update,
      },
      update,
    });
  });
}

export async function listWorkspaceActivity(
  prisma: PrismaClient,
  workspaceId: string,
  query: ActivityLogQueryInput,
  userId: string,
  userRole: string,
) {
  const where = {
    task: { project: {
      workspaceId,
      ...(userRole === "ADMIN" ? {} : { members: { some: { userId } } }),
    } },
  };

  const [data, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      include: {
        actor: {
          select: { id: true, displayName: true, avatarUrl: true },
        },
        task: {
          select: {
            id: true,
            title: true,
            project: { select: { id: true, name: true, color: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.activityLog.count({ where }),
  ]);

  return {
    data,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

export async function searchWikiPages(
  prisma: PrismaClient,
  workspaceId: string,
  query: string,
  limit: number,
) {
  return prisma.wikiPage.findMany({
    where: {
      space: { workspaceId },
      title: { contains: query, mode: "insensitive" },
    },
    select: {
      id: true,
      title: true,
      icon: true,
      spaceId: true,
      updatedAt: true,
      space: { select: { id: true, name: true, icon: true } },
    },
    take: limit,
    orderBy: { updatedAt: "desc" },
  });
}
