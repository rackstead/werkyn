import type { FastifyRequest, FastifyReply } from "fastify";
import * as tasksService from "./tasks.service.js";
import { notify } from "../../utils/notify.js";
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
  BulkDeleteInput,
  TaskDependencyInput,
} from "@pm/shared";

export async function listTasksHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string };
  const query = request.query as TaskQueryInput;
  const result = await tasksService.listTasks(
    request.server.prisma,
    params.pid,
    query,
  );
  return reply.send(result);
}

export async function createTaskHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string };
  const body = request.body as CreateTaskInput;
  const task = await tasksService.createTask(
    request.server.prisma,
    params.pid,
    request.user!.id,
    request.workspaceMember!.role,
    body,
  );
  request.server.broadcast(params.pid, "task_created", { taskId: task.id });
  return reply.status(201).send({ data: task });
}

export async function getTaskHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string };
  const task = await tasksService.getTask(
    request.server.prisma,
    params.tid,
  );
  return reply.send({ data: task });
}

export async function updateTaskHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string };
  const body = request.body as UpdateTaskInput;
  const oldTask = body.statusId
    ? await request.server.prisma.task.findUnique({
        where: { id: params.tid },
        select: { statusId: true },
      })
    : null;
  const task = await tasksService.updateTask(
    request.server.prisma,
    params.tid,
    request.user!.id,
    request.workspaceMember!.role,
    body,
  );
  request.server.broadcast(task.projectId, "task_updated", { taskId: task.id });

  // Notify assignees on status change
  if (body.statusId && oldTask && oldTask.statusId !== body.statusId) {
    const assigneeIds = task.assignees.map((a: { userId: string }) => a.userId);
    if (assigneeIds.length > 0) {
      const statusName = task.status?.name || "new status";
      notify(request.server.prisma, request.server, {
        recipients: assigneeIds,
        type: "TASK_STATUS_CHANGED",
        title: `"${task.title}" moved to ${statusName}`,
        body: `${request.user!.displayName} changed the status`,
        data: {
          taskId: task.id,
          projectId: task.projectId,
          actorId: request.user!.id,
          actorName: request.user!.displayName,
          taskTitle: task.title,
        },
        excludeUserId: request.user!.id,
      }).catch((err) => request.log.error(err, "Failed to send status change notification"));
    }
  }
  return reply.send({ data: task });
}

export async function deleteTaskHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string };
  // Get projectId before deletion for broadcast
  const taskToDelete = await request.server.prisma.task.findUnique({
    where: { id: params.tid },
    select: { projectId: true },
  });
  await tasksService.deleteTask(request.server.prisma, params.tid, request.user!.id);
  if (taskToDelete) {
    request.server.broadcast(taskToDelete.projectId, "task_deleted", { taskId: params.tid });
  }
  return reply.status(204).send();
}

export async function moveTaskHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string };
  const body = request.body as MoveTaskInput;
  const oldTask = await request.server.prisma.task.findUnique({
    where: { id: params.tid },
    select: { statusId: true, title: true, assignees: { select: { userId: true } } },
  });
  const result = await tasksService.moveTask(
    request.server.prisma,
    params.tid,
    request.user!.id,
    body,
  );
  request.server.broadcast(result.projectId, "task_moved", { taskId: params.tid });

  // Notify assignees if status column changed
  if (oldTask && oldTask.statusId !== body.statusId) {
    const assigneeIds = oldTask.assignees.map((a) => a.userId);
    if (assigneeIds.length > 0) {
      const statusName = result.status?.name || "new status";
      notify(request.server.prisma, request.server, {
        recipients: assigneeIds,
        type: "TASK_STATUS_CHANGED",
        title: `"${oldTask.title}" moved to ${statusName}`,
        body: `${request.user!.displayName} changed the status`,
        data: {
          taskId: params.tid,
          projectId: result.projectId,
          actorId: request.user!.id,
          actorName: request.user!.displayName,
          taskTitle: oldTask.title,
        },
        excludeUserId: request.user!.id,
      }).catch((err) => request.log.error(err, "Failed to send move notification"));
    }
  }
  return reply.send({ data: result });
}

export async function archiveTaskHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string };
  const body = request.body as ArchiveInput;
  const task = await tasksService.archiveTask(
    request.server.prisma,
    params.tid,
    body,
    request.user!.id,
  );
  request.server.broadcast(task.projectId, "task_updated", { taskId: params.tid });
  return reply.send({ data: task });
}

export async function addAssigneeHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string };
  const body = request.body as TaskAssigneeInput;
  const assignee = await tasksService.addAssignee(
    request.server.prisma,
    params.tid,
    request.user!.id,
    request.workspaceMember!.role,
    body,
  );
  const taskForAssignee = await request.server.prisma.task.findUnique({
    where: { id: params.tid },
    select: { projectId: true, title: true, project: { select: { name: true } } },
  });
  if (taskForAssignee) {
    request.server.broadcast(taskForAssignee.projectId, "task_updated", { taskId: params.tid });
    notify(request.server.prisma, request.server, {
      recipients: [body.userId],
      type: "TASK_ASSIGNED",
      title: `You were assigned to "${taskForAssignee.title}"`,
      body: `${request.user!.displayName} assigned you to this task`,
      data: {
        taskId: params.tid,
        projectId: taskForAssignee.projectId,
        actorId: request.user!.id,
        actorName: request.user!.displayName,
        taskTitle: taskForAssignee.title,
        projectName: taskForAssignee.project.name,
      },
      excludeUserId: request.user!.id,
    }).catch((err) => request.log.error(err, "Failed to send assignment notification"));
  }
  return reply.status(201).send({ data: assignee });
}

export async function removeAssigneeHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string; uid: string };
  await tasksService.removeAssignee(
    request.server.prisma,
    params.tid,
    params.uid,
    request.user!.id,
    request.workspaceMember!.role,
  );
  const taskForUnassign = await request.server.prisma.task.findUnique({ where: { id: params.tid }, select: { projectId: true } });
  if (taskForUnassign) {
    request.server.broadcast(taskForUnassign.projectId, "task_updated", { taskId: params.tid });
  }
  return reply.status(204).send();
}

export async function addLabelHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string };
  const body = request.body as TaskLabelInput;
  const taskLabel = await tasksService.addLabel(
    request.server.prisma,
    params.tid,
    body,
    request.user!.id,
  );
  const taskForLabel = await request.server.prisma.task.findUnique({ where: { id: params.tid }, select: { projectId: true } });
  if (taskForLabel) {
    request.server.broadcast(taskForLabel.projectId, "task_updated", { taskId: params.tid });
  }
  return reply.status(201).send({ data: taskLabel });
}

export async function removeLabelHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string; lid: string };
  await tasksService.removeLabel(
    request.server.prisma,
    params.tid,
    params.lid,
    request.user!.id,
    request.workspaceMember!.role,
  );
  const taskForLabelRemove = await request.server.prisma.task.findUnique({ where: { id: params.tid }, select: { projectId: true } });
  if (taskForLabelRemove) {
    request.server.broadcast(taskForLabelRemove.projectId, "task_updated", { taskId: params.tid });
  }
  return reply.status(204).send();
}

export async function bulkUpdateHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string };
  const body = request.body as BulkUpdateFieldsInput;
  const result = await tasksService.bulkUpdateTasks(
    request.server.prisma,
    params.pid,
    request.user!.id,
    body,
  );
  request.server.broadcast(params.pid, "task_updated", { bulk: true });
  return reply.send({ data: result });
}

export async function bulkDeleteHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string };
  const body = request.body as BulkDeleteInput;
  const result = await tasksService.bulkDeleteTasks(
    request.server.prisma,
    params.pid,
    body.taskIds,
    request.user!.id,
  );
  request.server.broadcast(params.pid, "task_deleted", { bulk: true });
  return reply.send({ data: result });
}

export async function listActivityHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string };
  const query = request.query as ActivityLogQueryInput;
  const result = await tasksService.listTaskActivity(
    request.server.prisma,
    params.tid,
    query,
  );
  return reply.send(result);
}

export async function duplicateTaskHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string };
  const task = await tasksService.duplicateTask(
    request.server.prisma,
    params.tid,
    request.user!.id,
  );
  request.server.broadcast(task.projectId, "task_created", { taskId: task.id });

  // Notify assignees (fire-and-forget)
  const assigneeIds = task.assignees.map((a: { userId: string }) => a.userId);
  if (assigneeIds.length > 0) {
    notify(request.server.prisma, request.server, {
      recipients: assigneeIds,
      type: "TASK_ASSIGNED",
      title: `You were assigned to "${task.title}"`,
      body: `${request.user!.displayName} duplicated a task and assigned you`,
      data: {
        taskId: task.id,
        projectId: task.projectId,
        actorId: request.user!.id,
        actorName: request.user!.displayName,
        taskTitle: task.title,
      },
      excludeUserId: request.user!.id,
    }).catch((err) => request.log.error(err, "Failed to send duplicate task notification"));
  }

  return reply.status(201).send({ data: task });
}

export async function addDependencyHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string };
  const body = request.body as TaskDependencyInput;
  const dependency = await tasksService.addDependency(
    request.server.prisma,
    params.tid,
    request.user!.id,
    body,
  );
  const task = await request.server.prisma.task.findUnique({
    where: { id: params.tid },
    select: { projectId: true },
  });
  if (task) {
    request.server.broadcast(task.projectId, "dependency_created", {
      taskId: params.tid,
      blockingTaskId: body.blockingTaskId,
    });
  }
  return reply.status(201).send({ data: dependency });
}

export async function removeDependencyHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string; depId: string };
  const result = await tasksService.removeDependency(
    request.server.prisma,
    params.tid,
    params.depId,
    request.user!.id,
  );
  const task = await request.server.prisma.task.findUnique({
    where: { id: params.tid },
    select: { projectId: true },
  });
  if (task) {
    request.server.broadcast(task.projectId, "dependency_deleted", {
      taskId: params.tid,
      blockingTaskId: result.blockingTaskId,
    });
  }
  return reply.status(204).send();
}
