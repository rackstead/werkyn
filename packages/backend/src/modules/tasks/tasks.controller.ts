import type { FastifyRequest, FastifyReply } from "fastify";
import * as tasksService from "./tasks.service.js";
import { deliverNotification } from "../notifications/notification-delivery.js";
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

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
]);

function postCommitDiagnostics(error: unknown) {
  try {
    const errorKind = error instanceof TypeError ? "type_error"
      : error instanceof Error ? "error" : "unknown";
    const descriptor = typeof error === "object" && error !== null
      ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
    const code = descriptor && "value" in descriptor ? descriptor.value : undefined;
    return {
      errorKind,
      ...(typeof code === "string" && NETWORK_ERROR_CODES.has(code) ? { errorCode: code } : {}),
    };
  } catch {
    return { errorKind: "unknown" };
  }
}

function afterTaskCommit(
  request: FastifyRequest,
  mutation: {
    operation: "update" | "move" | "assign" | "duplicate";
    projectId: string;
    taskId: string;
    event: "task_updated" | "task_moved" | "task_created";
    notificationDeliveryIds: string[];
  },
) {
  const { operation, projectId, taskId, event, notificationDeliveryIds } = mutation;
  try {
    request.server.broadcast(projectId, event, { taskId });
  } catch (error) {
    request.log.error(
      { stage: "task_broadcast", operation, taskId, ...postCommitDiagnostics(error) },
      "Could not broadcast committed task change",
    );
  }
  for (const id of notificationDeliveryIds) {
    void deliverNotification(request.server.prisma, request.server, id, { log: request.server.log })
      .catch((error) => request.log.error(
        { stage: "notification_delivery", operation, taskId, notificationDeliveryId: id, ...postCommitDiagnostics(error) },
        "Committed task notification remains queued for retry",
      ));
  }
}

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
  const { result: task, projectId, notificationDeliveryIds } = await tasksService.updateTaskWithNotifications(
    request.server.prisma, params.tid, request.user!.id,
    request.workspaceMember!.role, body, request.user!.displayName,
  );
  afterTaskCommit(request, { operation: "update", projectId, taskId: task.id, event: "task_updated", notificationDeliveryIds });
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
  const { result, projectId, notificationDeliveryIds } = await tasksService.moveTaskWithNotifications(
    request.server.prisma, params.tid, request.user!.id, body, request.user!.displayName,
  );
  afterTaskCommit(request, { operation: "move", projectId, taskId: params.tid, event: "task_moved", notificationDeliveryIds });
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
  const { result: assignee, projectId, notificationDeliveryIds } = await tasksService.addAssigneeWithNotifications(
    request.server.prisma, params.tid, request.user!.id,
    request.workspaceMember!.role, body, request.user!.displayName,
  );
  afterTaskCommit(request, { operation: "assign", projectId, taskId: params.tid, event: "task_updated", notificationDeliveryIds });
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
  const { result: task, projectId, notificationDeliveryIds } = await tasksService.duplicateTaskWithNotifications(
    request.server.prisma, params.tid, request.user!.id, request.user!.displayName,
  );
  afterTaskCommit(request, { operation: "duplicate", projectId, taskId: task.id, event: "task_created", notificationDeliveryIds });
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
