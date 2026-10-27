import type { FastifyRequest, FastifyReply } from "fastify";
import * as subtasksService from "./subtasks.service.js";
import type { CreateSubtaskInput, UpdateSubtaskInput, BulkUpdateTasksInput } from "@pm/shared";

export async function listSubtasksHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string };
  const subtasks = await subtasksService.listSubtasks(
    request.server.prisma,
    params.tid,
  );
  return reply.send({ data: subtasks });
}

export async function createSubtaskHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string };
  const body = request.body as CreateSubtaskInput;
  const { subtask, projectId } = await subtasksService.createSubtask(
    request.server.prisma,
    params.tid,
    request.user!.id,
    body,
  );
  request.server.broadcast(projectId, "subtask_created", {
    taskId: params.tid,
    subtaskId: subtask.id,
  });
  return reply.status(201).send({ data: subtask });
}

export async function updateSubtaskHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { id: string };
  const body = request.body as UpdateSubtaskInput;
  const { subtask, projectId } = await subtasksService.updateSubtask(
    request.server.prisma,
    params.id,
    request.user!.id,
    body,
  );
  request.server.broadcast(projectId, "subtask_updated", {
    taskId: subtask.taskId,
    subtaskId: subtask.id,
  });
  return reply.send({ data: subtask });
}

export async function toggleSubtaskHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { id: string };
  const { subtask, projectId } = await subtasksService.toggleSubtask(
    request.server.prisma,
    params.id,
    request.user!.id,
  );
  request.server.broadcast(projectId, "subtask_toggled", {
    taskId: subtask.taskId,
    subtaskId: subtask.id,
  });
  return reply.send({ data: subtask });
}

export async function reorderSubtasksHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string };
  const body = request.body as BulkUpdateTasksInput;
  const projectId = await subtasksService.reorderSubtasks(
    request.server.prisma,
    params.tid,
    body.orderedIds,
    request.user!.id,
  );
  request.server.broadcast(projectId, "subtask_updated", {
    taskId: params.tid,
  });
  return reply.send({ success: true });
}

export async function deleteSubtaskHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { id: string };
  const { taskId, projectId } = await subtasksService.deleteSubtask(
    request.server.prisma,
    params.id,
    request.user!.id,
  );
  request.server.broadcast(projectId, "subtask_deleted", {
    taskId,
    subtaskId: params.id,
  });
  return reply.status(204).send();
}
