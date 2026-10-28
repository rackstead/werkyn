import type { Prisma, PrismaClient, WorkspaceRole } from "@prisma/client";
import type { CreateTimeEntryInput, UpdateTimeEntryInput, TimeEntryQuery } from "@pm/shared";
import { ForbiddenError, NotFoundError, ValidationError } from "../../utils/errors.js";
import { assertProjectAccess, projectAccessWhere } from "../../utils/project-access.js";

/** Both nullable relations can carry project content, including legacy mismatches. */
export function timeEntryProjectWhere(workspaceId: string, userId: string): Prisma.TimeEntryWhereInput {
  const project = projectAccessWhere(workspaceId, userId);
  return {
    AND: [
      { OR: [{ projectId: null }, { project }] },
      { OR: [{ taskId: null }, { task: { project } }] },
    ],
  };
}

async function assertEntryProjects(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  references: { projectId?: string | null; taskId?: string | null },
) {
  const projectIds = new Set<string>();
  if (references.projectId) projectIds.add(references.projectId);
  let taskProjectId: string | undefined;
  if (references.taskId) {
    const task = await prisma.task.findUnique({ where: { id: references.taskId }, select: { projectId: true } });
    if (!task) throw new NotFoundError("Task not found");
    taskProjectId = task.projectId;
    projectIds.add(task.projectId);
  }
  for (const projectId of projectIds) {
    const access = await assertProjectAccess(prisma, projectId, userId);
    if (access.workspaceId !== workspaceId) throw new NotFoundError("Project not found in this workspace");
  }
  return taskProjectId;
}

/** An entry for a task always belongs to that task's project. */
function assertTaskInProject(taskProjectId: string | undefined, projectId: string | null) {
  if (taskProjectId && projectId !== taskProjectId) {
    throw new ValidationError("Task does not belong to the selected project");
  }
}

export async function createEntry(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  data: CreateTimeEntryInput,
) {
  const taskProjectId = await assertEntryProjects(prisma, workspaceId, userId, data);
  const projectId = data.projectId ?? taskProjectId ?? null;
  assertTaskInProject(taskProjectId, projectId);

  return prisma.timeEntry.create({
    data: {
      workspaceId,
      userId,
      date: data.date,
      hours: data.hours,
      description: data.description ?? null,
      taskId: data.taskId ?? null,
      projectId,
      billable: data.billable ?? true,
    },
    include: {
      user: { select: { id: true, displayName: true, avatarUrl: true } },
      task: { select: { id: true, title: true } },
      project: { select: { id: true, name: true, color: true } },
    },
  });
}

export async function updateEntry(
  prisma: PrismaClient,
  entryId: string,
  userId: string,
  role: WorkspaceRole,
  data: UpdateTimeEntryInput,
) {
  const entry = await prisma.timeEntry.findUnique({
    where: { id: entryId },
  });
  if (!entry) throw new NotFoundError("Time entry not found");

  if (role !== "ADMIN" && entry.userId !== userId) {
    throw new ForbiddenError("You can only edit your own time entries");
  }

  await assertEntryProjects(prisma, entry.workspaceId, userId, entry);

  let projectId = data.projectId;
  // Auto-populate projectId from task if taskId changes
  if (data.taskId !== undefined && data.taskId && projectId === undefined) {
    projectId = await assertEntryProjects(prisma, entry.workspaceId, userId, { taskId: data.taskId });
  }

  const nextReferences = {
    taskId: data.taskId === undefined ? entry.taskId : data.taskId,
    projectId: projectId === undefined ? entry.projectId : projectId,
  };
  const nextTaskProjectId = await assertEntryProjects(prisma, entry.workspaceId, userId, nextReferences);
  // Unrelated edits leave a legacy mismatch as is; changing either reference must fix it.
  if (data.taskId !== undefined || projectId !== undefined) {
    assertTaskInProject(nextTaskProjectId, nextReferences.projectId);
  }

  const updateData: Record<string, unknown> = {};
  if (data.date !== undefined) updateData.date = data.date;
  if (data.hours !== undefined) updateData.hours = data.hours;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.taskId !== undefined) updateData.taskId = data.taskId;
  if (projectId !== undefined) updateData.projectId = projectId;
  if (data.billable !== undefined) updateData.billable = data.billable;

  return prisma.timeEntry.update({
    where: { id: entryId },
    data: updateData,
    include: {
      user: { select: { id: true, displayName: true, avatarUrl: true } },
      task: { select: { id: true, title: true } },
      project: { select: { id: true, name: true, color: true } },
    },
  });
}

export async function deleteEntry(
  prisma: PrismaClient,
  entryId: string,
  userId: string,
  role: WorkspaceRole,
) {
  const entry = await prisma.timeEntry.findUnique({
    where: { id: entryId },
  });
  if (!entry) throw new NotFoundError("Time entry not found");

  if (role !== "ADMIN" && entry.userId !== userId) {
    throw new ForbiddenError("You can only delete your own time entries");
  }

  await assertEntryProjects(prisma, entry.workspaceId, userId, entry);

  return prisma.timeEntry.delete({ where: { id: entryId } });
}

export async function listEntries(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
  query: TimeEntryQuery,
) {
  // Non-admins can only see their own entries
  const filterUserId = role === "ADMIN" && query.userId
    ? query.userId
    : role === "ADMIN"
      ? undefined
      : userId;

  return prisma.timeEntry.findMany({
    where: {
      workspaceId,
      ...timeEntryProjectWhere(workspaceId, userId),
      ...(filterUserId ? { userId: filterUserId } : {}),
      date: {
        gte: query.startDate,
        lte: query.endDate,
      },
    },
    include: {
      user: { select: { id: true, displayName: true, avatarUrl: true } },
      task: { select: { id: true, title: true } },
      project: { select: { id: true, name: true, color: true } },
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });
}
