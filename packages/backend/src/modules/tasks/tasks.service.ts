import type { PrismaClient, Prisma } from "@prisma/client";
import type {
  CreateTaskInput,
  UpdateTaskInput,
  MoveTaskInput,
  TaskQueryInput,
  ArchiveInput,
  TaskAssigneeInput,
  TaskLabelInput,
  ActivityLogQueryInput,
  BulkUpdateFieldsInput,
  TaskDependencyInput,
} from "@pm/shared";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.js";
import { logActivity } from "../../utils/activity-log.js";
import { assertProjectAccess, assertTaskEdit } from "../../utils/project-access.js";
import { sanitizeDescription } from "../../utils/description-html.js";
import {
  assertProjectAssignees,
  assertProjectLabels,
  assertProjectStatus,
  assertUniqueIds,
  projectAssigneeIds,
  projectLabelIds,
} from "../../utils/task-references.js";
import { scopeTaskDependencyTasks, scopeTaskRelations } from "../../utils/task-scope.js";

export async function listTasks(
  prisma: PrismaClient,
  projectId: string,
  query: TaskQueryInput,
) {
  const where: Prisma.TaskWhereInput = {
    projectId,
    archived: query.archived,
  };

  if (query.status) {
    where.statusId = query.status;
  }
  if (query.priority) {
    where.priority = query.priority as Prisma.EnumPriorityFilter;
  }
  if (query.assignee) {
    where.assignees = { some: { userId: query.assignee } };
  }
  if (query.label) {
    where.labels = { some: { labelId: query.label } };
  }
  if (query.dueBefore) {
    where.dueDate = { ...(where.dueDate as object || {}), lte: query.dueBefore };
  }
  if (query.dueAfter) {
    where.dueDate = { ...(where.dueDate as object || {}), gte: query.dueAfter };
  }
  if (query.search) {
    where.title = { contains: query.search, mode: "insensitive" };
  }

  const include = {
    assignees: {
      include: {
        user: {
          select: { id: true, displayName: true, avatarUrl: true },
        },
      },
    },
    labels: {
      include: { label: true },
    },
    customFieldValues: {
      include: { field: true },
    },
    _count: {
      select: { subtasks: true, blockedBy: { where: { blockingTask: { projectId } } } },
    },
    status: true,
  };

  const primarySort: Prisma.TaskOrderByWithRelationInput =
    query.sort === "priority"
      ? { priority: query.order }
      : query.sort === "dueDate"
        ? { dueDate: query.order }
        : query.sort === "createdAt"
          ? { createdAt: query.order }
          : { position: query.order };

  // Secondary sort ensures stable ordering when primary values tie
  const orderBy: Prisma.TaskOrderByWithRelationInput[] = [
    primarySort,
    { createdAt: "asc" },
  ];

  if (query.view === "board") {
    // Board view: return all non-archived tasks, no pagination
    const tasks = await prisma.task.findMany({
      where: { ...where, archived: false },
      include,
      orderBy,
    });
    return { data: tasks.map(scopeTaskRelations) };
  }

  // Paginated view
  const [tasks, total] = await Promise.all([
    prisma.task.findMany({
      where,
      include,
      orderBy,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.task.count({ where }),
  ]);

  return {
    data: tasks.map(scopeTaskRelations),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

export async function createTask(
  prisma: PrismaClient,
  projectId: string,
  actorId: string,
  actorRole: string,
  data: CreateTaskInput,
) {
  actorRole = (await assertProjectAccess(prisma, projectId, actorId)).role;
  if (actorRole === "VIEWER") throw new ForbiddenError("Insufficient permissions");
  // Check project is not archived
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { archived: true },
  });
  if (project?.archived) {
    throw new ValidationError("Cannot create tasks in an archived project");
  }

  return prisma.$transaction(async (tx) => {
    // Determine statusId: use provided (same project only) or first column by position
    let statusId = data.statusId;
    if (statusId) {
      await assertProjectStatus(tx, projectId, statusId);
    } else {
      const firstColumn = await tx.statusColumn.findFirst({
        where: { projectId },
        orderBy: { position: "asc" },
      });
      if (!firstColumn) {
        throw new ValidationError("Project has no status columns");
      }
      statusId = firstColumn.id;
    }

    // Determine position: max in column + 1
    const maxPos = await tx.task.aggregate({
      where: { statusId, projectId },
      _max: { position: true },
    });
    const position = (maxPos._max.position ?? -1) + 1;

    const description = sanitizeDescription(data.description);

    // Build assigneeIds: if MEMBER, auto-include creator
    let assigneeIds = data.assigneeIds ?? [];
    assertUniqueIds(assigneeIds, "assignee");
    if (actorRole === "MEMBER" && !assigneeIds.includes(actorId)) {
      assigneeIds = [actorId, ...assigneeIds];
    }
    await assertProjectAssignees(tx, projectId, assigneeIds);
    await assertProjectLabels(tx, projectId, data.labelIds ?? []);

    const task = await tx.task.create({
      data: {
        projectId,
        statusId,
        title: data.title,
        description,
        priority: data.priority,
        position,
        dueDate: data.dueDate,
        startDate: data.startDate,
        reminder: data.reminder,
        assignees: assigneeIds.length
          ? {
              createMany: {
                data: assigneeIds.map((userId) => ({ userId })),
              },
            }
          : undefined,
        labels: data.labelIds?.length
          ? {
              createMany: {
                data: data.labelIds.map((labelId) => ({ labelId })),
              },
            }
          : undefined,
      },
      include: {
        assignees: {
          include: {
            user: {
              select: { id: true, displayName: true, avatarUrl: true },
            },
          },
        },
        labels: { include: { label: true } },
        status: true,
      },
    });

    await logActivity(tx, {
      taskId: task.id,
      actorId,
      action: "created",
    });

    return task;
  });
}

export async function getTask(
  prisma: PrismaClient,
  taskId: string,
) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      assignees: {
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
      },
      labels: { include: { label: true } },
      customFieldValues: {
        include: { field: true },
      },
      subtasks: { orderBy: { position: "asc" } },
      blockedBy: {
        include: {
          blockingTask: {
            select: { id: true, title: true, projectId: true, status: true },
          },
        },
      },
      blocking: {
        include: {
          blockedTask: {
            select: { id: true, title: true, projectId: true, status: true },
          },
        },
      },
      status: true,
    },
  });

  if (!task) {
    throw new NotFoundError("Task not found");
  }

  return scopeTaskRelations(task);
}

export async function updateTask(
  prisma: PrismaClient,
  taskId: string,
  actorId: string,
  actorRole: string,
  data: UpdateTaskInput,
) {
  actorRole = (await assertTaskEdit(prisma, taskId, actorId)).role;
  const existing = await prisma.task.findUnique({
    where: { id: taskId },
    include: { assignees: true },
  });
  if (!existing) {
    throw new NotFoundError("Task not found");
  }

  // Member ownership: MEMBER must be assignee
  if (actorRole === "MEMBER") {
    const isAssignee = existing.assignees.some((a) => a.userId === actorId);
    if (!isAssignee) {
      throw new ForbiddenError("Members can only edit tasks assigned to them");
    }
  }

  return prisma.$transaction(async (tx) => {
    const updateData: Prisma.TaskUpdateInput = {};

    if (data.title !== undefined) updateData.title = data.title;
    if (data.description !== undefined) {
      updateData.description = sanitizeDescription(data.description);
    }
    if (data.dueDate !== undefined) updateData.dueDate = data.dueDate;
    if (data.startDate !== undefined) updateData.startDate = data.startDate;
    if (data.reminder !== undefined) updateData.reminder = data.reminder;

    // Handle status change
    if (data.statusId && data.statusId !== existing.statusId) {
      // Validate the status belongs to the same project
      const newStatus = await tx.statusColumn.findFirst({
        where: { id: data.statusId, projectId: existing.projectId },
      });
      if (!newStatus) {
        throw new ValidationError("Status column not found in this project");
      }

      // Get max position in new column
      const maxPos = await tx.task.aggregate({
        where: { statusId: data.statusId, projectId: existing.projectId },
        _max: { position: true },
      });
      updateData.status = { connect: { id: data.statusId } };
      updateData.position = (maxPos._max.position ?? -1) + 1;

      await logActivity(tx, {
        taskId,
        actorId,
        action: "status_changed",
        details: { from: existing.statusId, to: data.statusId },
      });
    }

    // Handle priority change
    if (data.priority && data.priority !== existing.priority) {
      updateData.priority = data.priority;
      await logActivity(tx, {
        taskId,
        actorId,
        action: "priority_changed",
        details: { from: existing.priority, to: data.priority },
      });
    }

    // Log field_edited for other changes
    const editedFields: string[] = [];
    if (data.title !== undefined && data.title !== existing.title) editedFields.push("title");
    if (data.description !== undefined) editedFields.push("description");
    if (data.dueDate !== undefined && data.dueDate !== existing.dueDate) editedFields.push("dueDate");
    if (data.startDate !== undefined && data.startDate !== existing.startDate) editedFields.push("startDate");
    if (data.reminder !== undefined && data.reminder !== existing.reminder) editedFields.push("reminder");

    if (editedFields.length > 0) {
      await logActivity(tx, {
        taskId,
        actorId,
        action: "field_edited",
        details: { fields: editedFields },
      });
    }

    const task = await tx.task.update({
      where: { id: taskId },
      data: updateData,
      include: {
        assignees: {
          include: {
            user: {
              select: { id: true, displayName: true, avatarUrl: true },
            },
          },
        },
        labels: { include: { label: true } },
        status: true,
      },
    });
    return scopeTaskRelations(task);
  });
}

export async function deleteTask(
  prisma: PrismaClient,
  taskId: string,
  actorId: string,
) {
  const access = await assertTaskEdit(prisma, taskId, actorId);
  if (access.role !== "ADMIN") throw new ForbiddenError("Only administrators can delete tasks");
  await prisma.task.delete({ where: { id: taskId } });
}

export async function moveTask(
  prisma: PrismaClient,
  taskId: string,
  actorId: string,
  data: MoveTaskInput,
) {
  await assertTaskEdit(prisma, taskId, actorId);
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { projectId: true, statusId: true, position: true },
  });
  if (!task) {
    throw new NotFoundError("Task not found");
  }

  // Validate statusId belongs to same project
  const newStatus = await prisma.statusColumn.findFirst({
    where: { id: data.statusId, projectId: task.projectId },
  });
  if (!newStatus) {
    throw new ValidationError("Status column not found in this project");
  }

  // Warn (but allow) move to completion column if there are incomplete dependencies
  let warning: string | undefined;
  if (newStatus.isCompletion) {
    const incompleteDeps = await prisma.taskDependency.findMany({
      where: {
        blockedTaskId: taskId,
        blockingTask: {
          projectId: task.projectId,
          status: { isCompletion: false },
        },
      },
      include: {
        blockingTask: { select: { title: true } },
      },
    });

    if (incompleteDeps.length > 0) {
      const depNames = incompleteDeps.map((d) => d.blockingTask.title).join(", ");
      warning = `Warning: blocked by incomplete tasks: ${depNames}`;
    }
  }

  // Position from the frontend is a 0-based index into the sorted column.
  // We normalize all affected columns inside a transaction so positions
  // stay contiguous (0, 1, 2, …) and match the frontend's expectations.
  return prisma.$transaction(async (tx) => {
    const isSameColumn = task.statusId === data.statusId;

    if (isSameColumn) {
      // Same-column reorder
      const colTasks = await tx.task.findMany({
        where: { statusId: data.statusId, projectId: task.projectId, archived: false },
        orderBy: { position: "asc" },
        select: { id: true, position: true },
      });

      // Build new order: remove task, re-insert at desired index
      const ordered = colTasks.filter((t) => t.id !== taskId);
      const insertIdx = Math.min(data.position, ordered.length);
      ordered.splice(insertIdx, 0, { id: taskId, position: -1 });

      // Update positions that changed
      const updates: Promise<unknown>[] = [];
      for (let i = 0; i < ordered.length; i++) {
        if (ordered[i].id !== taskId && ordered[i].position !== i) {
          updates.push(
            tx.task.update({ where: { id: ordered[i].id }, data: { position: i } }),
          );
        }
      }
      await Promise.all(updates);

      const movedPos = ordered.findIndex((t) => t.id === taskId);
      const updatedTask = await tx.task.update({
        where: { id: taskId },
        data: { position: movedPos },
        include: { status: true },
      });

      return { ...updatedTask, warning };
    }

    // Cross-column move
    // 1. Normalize source column (close the gap)
    const srcTasks = await tx.task.findMany({
      where: { statusId: task.statusId, projectId: task.projectId, id: { not: taskId }, archived: false },
      orderBy: { position: "asc" },
      select: { id: true, position: true },
    });

    const srcUpdates: Promise<unknown>[] = [];
    for (let i = 0; i < srcTasks.length; i++) {
      if (srcTasks[i].position !== i) {
        srcUpdates.push(
          tx.task.update({ where: { id: srcTasks[i].id }, data: { position: i } }),
        );
      }
    }

    // 2. Insert into destination column at the desired index
    const dstTasks = await tx.task.findMany({
      where: { statusId: data.statusId, projectId: task.projectId, archived: false },
      orderBy: { position: "asc" },
      select: { id: true, position: true },
    });

    const dstOrdered = [...dstTasks];
    const insertIdx = Math.min(data.position, dstOrdered.length);
    dstOrdered.splice(insertIdx, 0, { id: taskId, position: -1 });

    const dstUpdates: Promise<unknown>[] = [];
    for (let i = 0; i < dstOrdered.length; i++) {
      if (dstOrdered[i].id !== taskId && dstOrdered[i].position !== i) {
        dstUpdates.push(
          tx.task.update({ where: { id: dstOrdered[i].id }, data: { position: i } }),
        );
      }
    }

    await Promise.all([...srcUpdates, ...dstUpdates]);

    const movedPos = dstOrdered.findIndex((t) => t.id === taskId);
    const updatedTask = await tx.task.update({
      where: { id: taskId },
      data: { statusId: data.statusId, position: movedPos },
      include: { status: true },
    });

    if (data.statusId !== task.statusId) {
      await logActivity(tx, {
        taskId,
        actorId,
        action: "status_changed",
        details: { from: task.statusId, to: data.statusId },
      });
    }

    return { ...updatedTask, warning };
  });
}

export async function archiveTask(
  prisma: PrismaClient,
  taskId: string,
  data: ArchiveInput,
  actorId: string,
) {
  const access = await assertTaskEdit(prisma, taskId, actorId);
  if (access.role !== "ADMIN") throw new ForbiddenError("Only administrators can archive tasks");
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { statusId: true, projectId: true },
  });
  if (!task) {
    throw new NotFoundError("Task not found");
  }

  const updateData: Prisma.TaskUpdateInput = { archived: data.archived };

  // On unarchive: position = max + 1 in current column
  if (!data.archived) {
    const maxPos = await prisma.task.aggregate({
      where: { statusId: task.statusId, projectId: task.projectId, archived: false },
      _max: { position: true },
    });
    updateData.position = (maxPos._max.position ?? -1) + 1;
  }

  return prisma.task.update({
    where: { id: taskId },
    data: updateData,
  });
}

export async function addAssignee(
  prisma: PrismaClient,
  taskId: string,
  actorId: string,
  actorRole: string,
  data: TaskAssigneeInput,
) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { projectId: true },
  });
  if (!task) {
    throw new NotFoundError("Task not found");
  }
  actorRole = (await assertProjectAccess(prisma, task.projectId, actorId)).role;
  if (actorRole === "VIEWER") throw new ForbiddenError("Insufficient permissions");
  if (actorRole === "MEMBER" && data.userId !== actorId) {
    throw new ForbiddenError("Members can only assign themselves");
  }

  await assertProjectAssignees(prisma, task.projectId, [data.userId]);

  // Check if already assigned
  const existing = await prisma.taskAssignee.findUnique({
    where: { taskId_userId: { taskId, userId: data.userId } },
  });
  if (existing) {
    throw new ConflictError("User is already assigned to this task");
  }

  const assignee = await prisma.taskAssignee.create({
    data: { taskId, userId: data.userId },
    include: {
      user: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
    },
  });

  await logActivity(prisma, {
    taskId,
    actorId,
    action: "assigned",
    details: { userId: data.userId },
  });

  return assignee;
}

export async function removeAssignee(
  prisma: PrismaClient,
  taskId: string,
  targetUserId: string,
  actorId: string,
  actorRole: string,
) {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
  if (!task) throw new NotFoundError("Task not found");
  actorRole = (await assertProjectAccess(prisma, task.projectId, actorId)).role;
  if (actorRole === "VIEWER") throw new ForbiddenError("Insufficient permissions");
  // Member ownership check: must be self or admin
  if (actorRole === "MEMBER" && targetUserId !== actorId) {
    throw new ForbiddenError("Members can only unassign themselves");
  }

  const assignee = await prisma.taskAssignee.findUnique({
    where: { taskId_userId: { taskId, userId: targetUserId } },
  });
  if (!assignee) {
    throw new NotFoundError("Assignee not found");
  }

  await prisma.taskAssignee.delete({ where: { id: assignee.id } });

  await logActivity(prisma, {
    taskId,
    actorId,
    action: "unassigned",
    details: { userId: targetUserId },
  });
}

export async function addLabel(
  prisma: PrismaClient,
  taskId: string,
  data: TaskLabelInput,
  actorId: string,
) {
  await assertTaskEdit(prisma, taskId, actorId);
  // Validate label belongs to the same project
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { projectId: true },
  });
  if (!task) {
    throw new NotFoundError("Task not found");
  }

  const label = await prisma.label.findFirst({
    where: { id: data.labelId, projectId: task.projectId },
  });
  if (!label) {
    throw new NotFoundError("Label not found in this project");
  }

  // Check if already applied
  const existing = await prisma.taskLabel.findUnique({
    where: { taskId_labelId: { taskId, labelId: data.labelId } },
  });
  if (existing) {
    throw new ConflictError("Label already applied to this task");
  }

  return prisma.taskLabel.create({
    data: { taskId, labelId: data.labelId },
    include: { label: true },
  });
}

export async function listTaskActivity(
  prisma: PrismaClient,
  taskId: string,
  query: ActivityLogQueryInput,
) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true },
  });
  if (!task) {
    throw new NotFoundError("Task not found");
  }

  const where = { taskId };
  const [data, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      include: {
        actor: {
          select: { id: true, displayName: true, avatarUrl: true },
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

export async function bulkUpdateTasks(
  prisma: PrismaClient,
  projectId: string,
  actorId: string,
  data: BulkUpdateFieldsInput,
) {
  return prisma.$transaction(async (tx) => {
    const access = await assertProjectAccess(tx, projectId, actorId);
    if (access.role === "VIEWER") throw new ForbiddenError("Insufficient permissions");
    if (access.role !== "ADMIN" && data.archived !== undefined) {
      throw new ForbiddenError("Only administrators can archive tasks");
    }
    // Validate all tasks belong to this project
    assertUniqueIds(data.taskIds, "task");
    const tasks = await tx.task.findMany({
      where: { id: { in: data.taskIds }, projectId },
      select: { id: true, assignees: { select: { userId: true } } },
    });
    if (tasks.length !== data.taskIds.length) {
      throw new ValidationError("Some tasks do not belong to this project");
    }
    if (access.role === "MEMBER") {
      for (const task of tasks) {
        if (!task.assignees.some((assignee) => assignee.userId === actorId)) {
          throw new ForbiddenError("Members can only edit tasks assigned to them");
        }
        if (data.assigneeIds !== undefined) {
          const previousOthers = task.assignees.map((a) => a.userId).filter((id) => id !== actorId).sort();
          const nextOthers = [...new Set(data.assigneeIds)].filter((id) => id !== actorId).sort();
          if (JSON.stringify(previousOthers) !== JSON.stringify(nextOthers)) {
            throw new ForbiddenError("Members can only change their own assignment");
          }
        }
      }
    }

    // Resolve every referenced status, assignee and label before any write
    if (data.statusId) await assertProjectStatus(tx, projectId, data.statusId);
    if (data.assigneeIds) await assertProjectAssignees(tx, projectId, data.assigneeIds);
    if (data.labelIds) await assertProjectLabels(tx, projectId, data.labelIds);

    // Bulk update status
    if (data.statusId) {
      await tx.task.updateMany({
        where: { id: { in: data.taskIds } },
        data: { statusId: data.statusId },
      });
    }

    // Bulk update priority
    if (data.priority) {
      await tx.task.updateMany({
        where: { id: { in: data.taskIds } },
        data: { priority: data.priority },
      });
    }

    // Bulk update assignees (replace)
    if (data.assigneeIds) {
      for (const taskId of data.taskIds) {
        await tx.taskAssignee.deleteMany({ where: { taskId } });
        if (data.assigneeIds.length > 0) {
          await tx.taskAssignee.createMany({
            data: data.assigneeIds.map((userId) => ({ taskId, userId })),
          });
        }
      }
    }

    // Bulk update archive
    if (data.archived !== undefined) {
      await tx.task.updateMany({
        where: { id: { in: data.taskIds } },
        data: { archived: data.archived },
      });
    }

    // Bulk update labels (replace)
    if (data.labelIds !== undefined) {
      for (const taskId of data.taskIds) {
        await tx.taskLabel.deleteMany({ where: { taskId } });
        if (data.labelIds.length > 0) {
          await tx.taskLabel.createMany({
            data: data.labelIds.map((labelId) => ({ taskId, labelId })),
          });
        }
      }
    }

    // Bulk update due date
    if (data.dueDate !== undefined) {
      await tx.task.updateMany({
        where: { id: { in: data.taskIds } },
        data: { dueDate: data.dueDate },
      });
    }

    // Bulk update start date
    if (data.startDate !== undefined) {
      await tx.task.updateMany({
        where: { id: { in: data.taskIds } },
        data: { startDate: data.startDate },
      });
    }

    // Log activity for each task
    for (const taskId of data.taskIds) {
      await logActivity(tx, {
        taskId,
        actorId,
        action: "bulk_updated",
        details: {
          statusId: data.statusId,
          priority: data.priority,
          assigneeIds: data.assigneeIds,
          archived: data.archived,
          labelIds: data.labelIds,
          dueDate: data.dueDate,
        },
      });
    }

    return { count: data.taskIds.length };
  });
}

export async function bulkDeleteTasks(
  prisma: PrismaClient,
  projectId: string,
  taskIds: string[],
  actorId: string,
) {
  const access = await assertProjectAccess(prisma, projectId, actorId);
  if (access.role !== "ADMIN") throw new ForbiddenError("Only administrators can delete tasks");
  // Validate all tasks belong to this project
  const tasks = await prisma.task.findMany({
    where: { id: { in: taskIds }, projectId },
    select: { id: true },
  });
  if (tasks.length !== taskIds.length) {
    throw new ValidationError("Some tasks do not belong to this project");
  }

  const result = await prisma.task.deleteMany({
    where: { id: { in: taskIds }, projectId },
  });

  return { count: result.count };
}

export async function removeLabel(
  prisma: PrismaClient,
  taskId: string,
  labelId: string,
  actorId: string,
  actorRole: string,
) {
  actorRole = (await assertTaskEdit(prisma, taskId, actorId)).role;
  // Member ownership check
  if (actorRole === "MEMBER") {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: { assignees: true },
    });
    if (!task) {
      throw new NotFoundError("Task not found");
    }
    const isAssignee = task.assignees.some((a) => a.userId === actorId);
    if (!isAssignee) {
      throw new ForbiddenError("Members can only modify tasks assigned to them");
    }
  }

  const taskLabel = await prisma.taskLabel.findUnique({
    where: { taskId_labelId: { taskId, labelId } },
  });
  if (!taskLabel) {
    throw new NotFoundError("Label not applied to this task");
  }

  await prisma.taskLabel.delete({ where: { id: taskLabel.id } });
}

export async function duplicateTask(
  prisma: PrismaClient,
  taskId: string,
  actorId: string,
) {
  const source = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      assignees: true,
      labels: true,
      subtasks: { orderBy: { position: "asc" } },
    },
  });
  if (!source) {
    throw new NotFoundError("Task not found");
  }
  const access = await assertProjectAccess(prisma, source.projectId, actorId);
  if (access.role === "VIEWER") throw new ForbiddenError("Insufficient permissions");

  // Check project not archived
  const project = await prisma.project.findUnique({
    where: { id: source.projectId },
    select: { archived: true },
  });
  if (project?.archived) {
    throw new ValidationError("Cannot duplicate tasks in an archived project");
  }

  return prisma.$transaction(async (tx) => {
    // Copy only references that are valid in the source project today: legacy
    // rows may point at another project, and members may have lost access.
    let statusId = source.statusId;
    const sourceStatus = await tx.statusColumn.findFirst({
      where: { id: statusId, projectId: source.projectId },
      select: { id: true },
    });
    if (!sourceStatus) {
      const firstColumn = await tx.statusColumn.findFirst({
        where: { projectId: source.projectId },
        orderBy: { position: "asc" },
        select: { id: true },
      });
      if (!firstColumn) throw new ValidationError("Project has no status columns");
      statusId = firstColumn.id;
    }
    const labelIds = await projectLabelIds(tx, source.projectId, source.labels.map((l) => l.labelId));
    const assigneeIds = await projectAssigneeIds(tx, source.projectId, source.assignees.map((a) => a.userId));
    const subtaskAssignees = new Set(await projectAssigneeIds(
      tx,
      source.projectId,
      source.subtasks.flatMap((s) => (s.assigneeId ? [s.assigneeId] : [])),
    ));

    // Calculate position
    const maxPos = await tx.task.aggregate({
      where: { statusId, projectId: source.projectId },
      _max: { position: true },
    });
    const position = (maxPos._max.position ?? -1) + 1;

    const task = await tx.task.create({
      data: {
        projectId: source.projectId,
        statusId,
        title: `Copy of ${source.title}`,
        // Rows written before every path sanitized may hold unfiltered HTML.
        description: sanitizeDescription(source.description),
        priority: source.priority,
        position,
        dueDate: source.dueDate,
        startDate: source.startDate,
        reminder: source.reminder,
        assignees: assigneeIds.length
          ? { createMany: { data: assigneeIds.map((userId) => ({ userId })) } }
          : undefined,
        labels: labelIds.length
          ? { createMany: { data: labelIds.map((labelId) => ({ labelId })) } }
          : undefined,
      },
      include: {
        assignees: {
          include: {
            user: {
              select: { id: true, displayName: true, avatarUrl: true },
            },
          },
        },
        labels: { include: { label: true } },
        status: true,
      },
    });

    // Copy subtasks (not completed state)
    if (source.subtasks.length > 0) {
      await tx.subtask.createMany({
        data: source.subtasks.map((s, i) => ({
          taskId: task.id,
          title: s.title,
          position: i,
          assigneeId: s.assigneeId && subtaskAssignees.has(s.assigneeId) ? s.assigneeId : null,
        })),
      });
    }

    await logActivity(tx, {
      taskId: task.id,
      actorId,
      action: "created",
      details: { duplicatedFrom: taskId },
    });

    return task;
  });
}

export async function addDependency(
  prisma: PrismaClient,
  taskId: string,
  actorId: string,
  data: TaskDependencyInput,
) {
  await assertTaskEdit(prisma, taskId, actorId);
  // No self-dependency
  if (taskId === data.blockingTaskId) {
    throw new ValidationError("A task cannot depend on itself");
  }

  // Both tasks must exist and belong to the same project
  const [blockedTask, blockingTask] = await Promise.all([
    prisma.task.findUnique({ where: { id: taskId }, select: { id: true, projectId: true } }),
    prisma.task.findUnique({ where: { id: data.blockingTaskId }, select: { id: true, title: true, projectId: true } }),
  ]);

  if (!blockedTask) {
    throw new NotFoundError("Task not found");
  }
  if (!blockingTask) {
    throw new NotFoundError("Blocking task not found");
  }
  if (blockedTask.projectId !== blockingTask.projectId) {
    throw new ValidationError("Both tasks must belong to the same project");
  }

  // Check for duplicate
  const existing = await prisma.taskDependency.findUnique({
    where: {
      blockedTaskId_blockingTaskId: {
        blockedTaskId: taskId,
        blockingTaskId: data.blockingTaskId,
      },
    },
  });
  if (existing) {
    throw new ConflictError("This dependency already exists");
  }

  // BFS circular detection: load all deps for the project and check if
  // blockingTaskId can reach blockedTaskId (taskId) through the graph
  const allDeps = await prisma.taskDependency.findMany({
    where: {
      blockedTask: { projectId: blockedTask.projectId },
    },
    select: { blockedTaskId: true, blockingTaskId: true },
  });

  // Build adjacency: blockingTaskId → [blockedTaskIds]
  // i.e. if A blocks B, then completing A allows B. We need to check:
  // would adding "blockingTaskId blocks taskId" create a cycle?
  // That means: can we reach blockingTaskId starting from taskId via existing edges?
  // Edge direction: blockedTaskId is blocked by blockingTaskId
  // For cycle detection: if taskId (the blocked one) already transitively blocks blockingTaskId
  const adj = new Map<string, string[]>();
  for (const dep of allDeps) {
    const list = adj.get(dep.blockedTaskId) ?? [];
    list.push(dep.blockingTaskId);
    adj.set(dep.blockedTaskId, list);
  }

  // BFS from blockingTaskId: if we can reach taskId, adding this edge creates a cycle
  const visited = new Set<string>();
  const queue = [data.blockingTaskId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === taskId) {
      throw new ValidationError("Cannot add dependency: would create a circular dependency");
    }
    if (visited.has(current)) continue;
    visited.add(current);
    const neighbors = adj.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        queue.push(neighbor);
      }
    }
  }

  // Create the dependency
  const dependency = await prisma.taskDependency.create({
    data: {
      blockedTaskId: taskId,
      blockingTaskId: data.blockingTaskId,
    },
    include: {
      blockingTask: { select: { id: true, title: true, projectId: true, status: true } },
      blockedTask: { select: { id: true, title: true, projectId: true, status: true } },
    },
  });

  await logActivity(prisma, {
    taskId,
    actorId,
    action: "dependency_added",
    details: { blockingTaskId: data.blockingTaskId, blockingTaskTitle: blockingTask.title },
  });

  return scopeTaskDependencyTasks(dependency);
}

export async function removeDependency(
  prisma: PrismaClient,
  taskId: string,
  dependencyId: string,
  actorId: string,
) {
  await assertTaskEdit(prisma, taskId, actorId);
  const dependency = await prisma.taskDependency.findUnique({
    where: { id: dependencyId },
    include: {
      blockingTask: { select: { id: true, title: true, projectId: true } },
      blockedTask: { select: { projectId: true } },
    },
  });

  if (!dependency) {
    throw new NotFoundError("Dependency not found");
  }

  if (dependency.blockedTaskId !== taskId) {
    throw new ValidationError("Dependency does not belong to this task");
  }

  await prisma.taskDependency.delete({ where: { id: dependencyId } });

  await logActivity(prisma, {
    taskId,
    actorId,
    action: "dependency_removed",
    details: {
      blockingTaskId: dependency.blockingTaskId,
      // A legacy cross-project link may be removed without copying its title.
      ...(dependency.blockingTask.projectId === dependency.blockedTask.projectId
        ? { blockingTaskTitle: dependency.blockingTask.title }
        : {}),
    },
  });

  return { blockingTaskId: dependency.blockingTaskId };
}
