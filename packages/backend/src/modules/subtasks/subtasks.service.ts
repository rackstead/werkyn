import type { PrismaClient } from "@prisma/client";
import type { CreateSubtaskInput, UpdateSubtaskInput } from "@pm/shared";
import { NotFoundError, ValidationError } from "../../utils/errors.js";
import { logActivity } from "../../utils/activity-log.js";
import { assertTaskEdit } from "../../utils/project-access.js";
import { assertProjectAssignees } from "../../utils/task-references.js";
import { assertCompleteOrder, withProjectOrder } from "../../utils/task-order.js";

export async function listSubtasks(prisma: PrismaClient, taskId: string) {
  return prisma.subtask.findMany({
    where: { taskId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    include: {
      assignee: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
    },
  });
}

export async function createSubtask(
  prisma: PrismaClient,
  taskId: string,
  actorId: string,
  data: CreateSubtaskInput,
) {
  await assertTaskEdit(prisma, taskId, actorId);
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true },
  });
  if (!task) throw new NotFoundError("Task not found");

  // The assignee's membership rows stay locked until the subtask commits, so a
  // concurrent project or workspace removal cannot slip in between. The
  // project's order lock keeps the chosen position last until then
  // (utils/task-order.ts).
  const subtask = await withProjectOrder(prisma, task.projectId, async (tx) => {
    if (data.assigneeId !== undefined) {
      await assertProjectAssignees(tx, task.projectId, [data.assigneeId]);
    }

    const maxPos = await tx.subtask.aggregate({
      where: { taskId },
      _max: { position: true },
    });
    const position = (maxPos._max.position ?? -1) + 1;

    const created = await tx.subtask.create({
      data: {
        taskId,
        title: data.title,
        assigneeId: data.assigneeId,
        dueDate: data.dueDate,
        position,
      },
      include: {
        assignee: {
          select: { id: true, displayName: true, avatarUrl: true },
        },
      },
    });

    await logActivity(tx, {
      taskId,
      actorId,
      action: "subtask_added",
      details: { subtaskId: created.id, title: created.title },
    });
    return created;
  });

  return { subtask, projectId: task.projectId };
}

export async function updateSubtask(
  prisma: PrismaClient,
  subtaskId: string,
  actorId: string,
  data: UpdateSubtaskInput,
) {
  const existing = await prisma.subtask.findUnique({
    where: { id: subtaskId },
    include: { task: { select: { projectId: true } } },
  });
  if (!existing) throw new NotFoundError("Subtask not found");

  await assertTaskEdit(prisma, existing.taskId, actorId);

  const subtask = await prisma.$transaction(async (tx) => {
    if (data.assigneeId !== undefined && data.assigneeId !== null) {
      await assertProjectAssignees(tx, existing.task.projectId, [data.assigneeId]);
    }

    const updated = await tx.subtask.update({
      where: { id: subtaskId },
      data,
      include: {
        assignee: {
          select: { id: true, displayName: true, avatarUrl: true },
        },
      },
    });

    await logActivity(tx, {
      taskId: existing.taskId,
      actorId,
      action: "subtask_edited",
      details: { subtaskId, title: updated.title },
    });
    return updated;
  });

  return { subtask, projectId: existing.task.projectId };
}

export async function toggleSubtask(
  prisma: PrismaClient,
  subtaskId: string,
  actorId: string,
) {
  const existing = await prisma.subtask.findUnique({
    where: { id: subtaskId },
    include: { task: { select: { projectId: true } } },
  });
  if (!existing) throw new NotFoundError("Subtask not found");

  await assertTaskEdit(prisma, existing.taskId, actorId);

  const subtask = await prisma.subtask.update({
    where: { id: subtaskId },
    data: { completed: !existing.completed },
    include: {
      assignee: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
    },
  });

  await logActivity(prisma, {
    taskId: existing.taskId,
    actorId,
    action: "subtask_toggled",
    details: { subtaskId, completed: subtask.completed, title: subtask.title },
  });

  return { subtask, projectId: existing.task.projectId };
}

export async function reorderSubtasks(
  prisma: PrismaClient,
  taskId: string,
  orderedIds: string[],
  actorId: string,
) {
  await assertTaskEdit(prisma, taskId, actorId);
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true },
  });
  if (!task) throw new NotFoundError("Task not found");

  // Under the project's order lock, so a subtask created meanwhile is either
  // listed here or created after the reorder (utils/task-order.ts).
  await withProjectOrder(prisma, task.projectId, async (tx) => {
    // Validate all IDs belong to this task
    const subtasks = await tx.subtask.findMany({
      where: { taskId },
      select: { id: true },
    });
    const validIds = new Set(subtasks.map((s) => s.id));
    for (const id of orderedIds) {
      if (!validIds.has(id)) {
        throw new ValidationError(`Subtask ${id} does not belong to this task`);
      }
    }
    assertCompleteOrder(orderedIds, validIds, "subtask of the task");

    // Update in subtask id order, the order in which member removals lock
    // subtask rows (clearAssignments), so the two cannot deadlock.
    const positions = orderedIds.map((id, index) => ({ id, index }));
    positions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const { id, index } of positions) {
      await tx.subtask.update({
        where: { id },
        data: { position: index },
      });
    }
  });

  return task.projectId;
}

export async function deleteSubtask(
  prisma: PrismaClient,
  subtaskId: string,
  actorId: string,
) {
  const existing = await prisma.subtask.findUnique({
    where: { id: subtaskId },
    include: { task: { select: { projectId: true } } },
  });
  if (!existing) throw new NotFoundError("Subtask not found");

  await assertTaskEdit(prisma, existing.taskId, actorId);

  await prisma.subtask.delete({ where: { id: subtaskId } });

  await logActivity(prisma, {
    taskId: existing.taskId,
    actorId,
    action: "subtask_deleted",
    details: { subtaskId, title: existing.title },
  });

  return { taskId: existing.taskId, projectId: existing.task.projectId };
}
