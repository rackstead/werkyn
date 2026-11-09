import type { Prisma, PrismaClient, WorkspaceRole } from "@prisma/client";
import {
  TIME_ENTRY_PAGE_DEFAULT,
  hasUnpairedSurrogate,
  isDateOnly,
  type CreateTimeEntryInput,
  type UpdateTimeEntryInput,
  type TimeEntryQuery,
} from "@pm/shared";
import { ForbiddenError, NotFoundError, ValidationError } from "../../utils/errors.js";
import { assertProjectAccess, projectAccessWhere } from "../../utils/project-access.js";

/** Timesheet order. The id makes rows that share a date and createdAt stable. */
const ENTRY_ORDER: Prisma.TimeEntryOrderByWithRelationInput[] = [
  { date: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
];

/** Sort position carried by a cursor, so it does not depend on the row still being there. */
type EntryPosition = { date: string; createdAt: string; id: string };

const isCursorText = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !value.includes("\u0000") &&
  !hasUnpairedSurrogate(value);

function encodeEntryCursor(row: { date: string; createdAt: Date; id: string }) {
  const position: EntryPosition = {
    date: row.date,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  };
  return Buffer.from(JSON.stringify([position.date, position.createdAt, position.id])).toString("base64url");
}

function decodeEntryCursor(cursor: string): { date: string; createdAt: Date; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 3) throw new Error("shape");
    const [date, createdAt, id] = value;
    if (typeof date !== "string" || typeof createdAt !== "string") throw new Error("fields");
    const parsed = new Date(createdAt);
    if (
      !isDateOnly(date) ||
      !isCursorText(id, 200) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString() !== createdAt
    ) {
      throw new Error("fields");
    }
    return { date, createdAt: parsed, id };
  } catch {
    throw new ValidationError("Validation failed", [
      { field: "cursor", message: "Invalid cursor: use the nextCursor of the previous page" },
    ]);
  }
}

/** Rows after the cursor's stored position. The cursor row itself is not required. */
function entriesAfter(at: { date: string; createdAt: Date; id: string }): Prisma.TimeEntryWhereInput {
  return {
    OR: [
      { date: { gt: at.date } },
      { date: at.date, createdAt: { gt: at.createdAt } },
      { date: at.date, createdAt: at.createdAt, id: { gt: at.id } },
    ],
  };
}

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
  // Any supplied ID, including an empty string, must resolve before it is written.
  if (references.projectId != null) projectIds.add(references.projectId);
  let taskProjectId: string | undefined;
  if (references.taskId != null) {
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
  if (data.taskId !== undefined && data.taskId !== null && projectId === undefined) {
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

/**
 * One page of entries in the date range, ordered by date, createdAt, then id.
 * Omit `cursor` for the first page. The page size is `limit`, or
 * TIME_ENTRY_PAGE_DEFAULT (100) when the caller omits it. `nextCursor` carries
 * the last row's sort position and is null on the last page. A malformed
 * cursor is rejected. Deleting or re-dating that row does not end the list or
 * move the boundary, because the position was stored when the cursor was issued.
 */
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

  const filters: Prisma.TimeEntryWhereInput[] = [
    {
      workspaceId,
      ...timeEntryProjectWhere(workspaceId, userId),
      ...(filterUserId ? { userId: filterUserId } : {}),
      date: {
        gte: query.startDate,
        lte: query.endDate,
      },
    },
  ];
  if (query.cursor) filters.push(entriesAfter(decodeEntryCursor(query.cursor)));

  const limit = query.limit ?? TIME_ENTRY_PAGE_DEFAULT;
  const rows = await prisma.timeEntry.findMany({
    where: { AND: filters },
    include: {
      user: { select: { id: true, displayName: true, avatarUrl: true } },
      task: { select: { id: true, title: true } },
      project: { select: { id: true, name: true, color: true } },
    },
    orderBy: ENTRY_ORDER,
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const last = rows.at(-1);
  return {
    data: rows,
    nextCursor: hasMore && last ? encodeEntryCursor(last) : null,
  };
}
