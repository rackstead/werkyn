import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  UpdateWorkspaceMemberInput,
  UpdateWorkspaceSettingsInput,
  WorkspaceSearchInput,
  ActivityLogQueryInput,
  MyTasksQueryInput,
} from "@pm/shared";
import { ACTIVITY_COUNT_LIMIT } from "@pm/shared";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../utils/errors.js";
import { projectAccessWhere } from "../../utils/project-access.js";
import { withWorkspaceLock } from "../../utils/workspace-lock.js";
import { clearAssignments } from "../../utils/task-references.js";
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
    if (retainedProjects) {
      // The role update waits for assignments holding this membership. Clear
      // every project that lost access in one globally ordered pass, retaining
      // explicit memberships even when the new workspace role is VIEWER.
      await clearAssignments(tx, targetUserId, {
        workspaceId,
        retainedProjectIds: retainedProjects.map((p) => p.projectId),
      });
    }
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
    // Assignments end with access, as on project removal. An assignment that
    // held the membership rows committed before the delete above, so these
    // later statements see and clear it (task-references.ts).
    await clearAssignments(tx, targetUserId, { workspaceId });
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
    },
    orderBy: { name: "asc" },
  });
  if (projects.length === 0) return { data: [] };

  const today = new Date().toISOString().split("T")[0];

  // Counted in the database instead of loading every active task of every
  // project. A task is overdue when its non-empty due date sorts before today
  // by code unit, as a JavaScript string comparison would (hence COLLATE "C").
  const counts = await prisma.$queryRaw<
    {
      projectId: string;
      totalTasks: number;
      completedTasks: number;
      overdueTasks: number;
    }[]
  >`
    SELECT t."projectId",
      count(*)::int AS "totalTasks",
      count(*) FILTER (WHERE s."isCompletion")::int AS "completedTasks",
      count(*) FILTER (
        WHERE NOT s."isCompletion" AND t."dueDate" <> '' AND t."dueDate" < ${today} COLLATE "C"
      )::int AS "overdueTasks"
    FROM "Task" t
    JOIN "StatusColumn" s ON s."id" = t."statusId"
    WHERE t."projectId" IN (${Prisma.join(projects.map((p) => p.id))}) AND NOT t."archived"
    GROUP BY t."projectId"`;
  const byProject = new Map(counts.map((c) => [c.projectId, c]));

  const data = projects.map((project) => {
    const count = byProject.get(project.id);
    return {
      id: project.id,
      name: project.name,
      color: project.color,
      archived: project.archived,
      totalTasks: count?.totalTasks ?? 0,
      completedTasks: count?.completedTasks ?? 0,
      overdueTasks: count?.overdueTasks ?? 0,
    };
  });

  return { data };
}

/** The sort values of a my-tasks row; the cursor carries them, not just the ID. */
type MyTasksPosition =
  | { sort: "project"; projectName: string; projectId: string; position: number; id: string }
  | { sort: "dueDate"; dueDate: string | null; id: string };

function encodeMyTasksCursor(row: MyTasksPosition) {
  const values =
    row.sort === "project"
      ? [row.projectName, row.projectId, row.position, row.id]
      : [row.dueDate, row.id];
  return Buffer.from(JSON.stringify(values)).toString("base64url");
}

function decodeMyTasksCursor(cursor: string, sort: MyTasksQueryInput["sort"]): MyTasksPosition {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(value)) throw new Error("not an array");
    if (
      sort === "project" &&
      value.length === 4 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string" &&
      Number.isSafeInteger(value[2]) &&
      typeof value[3] === "string"
    ) {
      return { sort, projectName: value[0], projectId: value[1], position: value[2], id: value[3] };
    }
    if (
      sort === "dueDate" &&
      value.length === 2 &&
      (value[0] === null || typeof value[0] === "string") &&
      typeof value[1] === "string"
    ) {
      return { sort, dueDate: value[0], id: value[1] };
    }
  } catch {
    // Reported below.
  }
  throw new ValidationError("Validation failed", [
    { field: "cursor", message: "Invalid cursor: use the nextCursor of the previous page with the same sort" },
  ]);
}

/** Rows after `at` in its sort order. */
function myTasksAfter(at: MyTasksPosition): Prisma.TaskWhereInput {
  if (at.sort === "dueDate") {
    // Ascending with tasks without a due date last.
    return at.dueDate === null
      ? { dueDate: null, id: { gt: at.id } }
      : {
          OR: [
            { dueDate: { gt: at.dueDate } },
            { dueDate: at.dueDate, id: { gt: at.id } },
            { dueDate: null },
          ],
        };
  }
  return {
    OR: [
      { project: { name: { gt: at.projectName } } },
      { project: { name: at.projectName }, projectId: { gt: at.projectId } },
      { projectId: at.projectId, position: { gt: at.position } },
      { projectId: at.projectId, position: at.position, id: { gt: at.id } },
    ],
  };
}

/**
 * The caller's assigned, unarchived tasks in visible projects, one page at a
 * time: by project name, then project, board position and ID, or with
 * sort=dueDate by due date (none last) and ID.
 */
export async function getMyTasks(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  role: string,
  query: MyTasksQueryInput,
) {
  const projectWhere: Prisma.ProjectWhereInput = {
    workspaceId,
    archived: false,
  };

  if (role !== "ADMIN") {
    projectWhere.members = { some: { userId } };
  }

  const filters: Prisma.TaskWhereInput[] = [
    {
      archived: false,
      assignees: { some: { userId } },
      project: projectWhere,
    },
  ];
  if (query.dueBefore || query.dueAfter) {
    filters.push({
      dueDate: {
        ...(query.dueBefore ? { lte: query.dueBefore } : {}),
        ...(query.dueAfter ? { gte: query.dueAfter } : {}),
      },
    });
  }
  if (query.completed !== undefined) {
    filters.push({ status: { isCompletion: query.completed } });
  }
  if (query.cursor) filters.push(myTasksAfter(decodeMyTasksCursor(query.cursor, query.sort)));

  const tasks = await prisma.task.findMany({
    where: { AND: filters },
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
    orderBy:
      query.sort === "dueDate"
        ? [{ dueDate: { sort: "asc", nulls: "last" } }, { id: "asc" }]
        : [
            { project: { name: "asc" } },
            { projectId: "asc" },
            { position: "asc" },
            { id: "asc" },
          ],
    take: query.limit + 1,
  });

  const hasMore = tasks.length > query.limit;
  const page = hasMore ? tasks.slice(0, query.limit) : tasks;
  const last = page.at(-1);
  return {
    data: page.map(scopeTaskRelations),
    nextCursor:
      hasMore && last
        ? encodeMyTasksCursor(
            query.sort === "dueDate"
              ? { sort: "dueDate", dueDate: last.dueDate, id: last.id }
              : {
                  sort: "project",
                  projectName: last.project.name,
                  projectId: last.projectId,
                  position: last.position,
                  id: last.id,
                },
          )
        : null,
  };
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

  const [rows, counted] = await Promise.all([
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
      // The ID gives equal timestamps one order, so pages do not overlap.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      // One extra row tells whether another page follows.
      take: query.limit + 1,
    }),
    // Counting stops after ACTIVITY_COUNT_LIMIT + 1 rows: an exact count of
    // every activity row of the visible projects cost most of the request.
    // Same rows as `where`; raw SQL because Prisma's count with `take` adds an
    // ORDER BY that makes PostgreSQL read every row before the LIMIT.
    prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM "ActivityLog" a
        WHERE a."taskId" IN (
          SELECT t."id" FROM "Task" t
          JOIN "Project" p ON p."id" = t."projectId"
          WHERE p."workspaceId" = ${workspaceId}
          ${
            userRole === "ADMIN"
              ? Prisma.empty
              : Prisma.sql`AND EXISTS (
                  SELECT 1 FROM "ProjectMember" pm
                  WHERE pm."projectId" = p."id" AND pm."userId" = ${userId})`
          }
        )
        LIMIT ${ACTIVITY_COUNT_LIMIT + 1}
      ) s`.then(([row]) => row.n),
  ]);

  const hasMore = rows.length > query.limit;
  const data = hasMore ? rows.slice(0, query.limit) : rows;
  const totalCapped = counted > ACTIVITY_COUNT_LIMIT;
  const total = totalCapped ? ACTIVITY_COUNT_LIMIT : counted;

  return {
    data,
    pagination: {
      page: query.page,
      limit: query.limit,
      /** Exact up to ACTIVITY_COUNT_LIMIT; that limit when totalCapped. */
      total,
      totalPages: Math.ceil(total / query.limit),
      totalCapped,
      hasMore,
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
