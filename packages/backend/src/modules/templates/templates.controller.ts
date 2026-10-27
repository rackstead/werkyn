import type { FastifyRequest, FastifyReply } from "fastify";
import * as templatesService from "./templates.service.js";
import { notify } from "../../utils/notify.js";
import type { CreateTemplateInput, UpdateTemplateInput, InstantiateTemplateInput } from "@pm/shared";

export async function listTemplatesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string };
  const templates = await templatesService.listTemplates(
    request.server.prisma,
    params.pid,
  );
  return reply.send({ data: templates });
}

export async function getTemplateHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string; templateId: string };
  const template = await templatesService.getTemplate(
    request.server.prisma,
    params.pid,
    params.templateId,
  );
  return reply.send({ data: template });
}

export async function createTemplateHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string };
  const body = request.body as CreateTemplateInput;
  const template = await templatesService.createTemplate(
    request.server.prisma,
    params.pid,
    body,
  );
  return reply.status(201).send({ data: template });
}

export async function updateTemplateHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string; templateId: string };
  const body = request.body as UpdateTemplateInput;
  const template = await templatesService.updateTemplate(
    request.server.prisma,
    params.pid,
    params.templateId,
    body,
  );
  return reply.send({ data: template });
}

export async function deleteTemplateHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string; templateId: string };
  await templatesService.deleteTemplate(
    request.server.prisma,
    params.pid,
    params.templateId,
  );
  return reply.status(204).send();
}

export async function createTaskFromTemplateHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string; templateId: string };
  const body = request.body as InstantiateTemplateInput;
  const task = await templatesService.createTaskFromTemplate(
    request.server.prisma,
    params.pid,
    params.templateId,
    request.user!.id,
    request.workspaceMember!.role,
    body,
  );
  request.server.broadcast(params.pid, "task_created", { taskId: task.id });

  // Notify assignees (fire-and-forget)
  const assigneeIds = task.assignees.map((a: { userId: string }) => a.userId);
  if (assigneeIds.length > 0) {
    notify(request.server.prisma, request.server, {
      recipients: assigneeIds,
      type: "TASK_ASSIGNED",
      title: `You were assigned to "${task.title}"`,
      body: `${request.user!.displayName} created a task from a template`,
      data: {
        taskId: task.id,
        projectId: params.pid,
        actorId: request.user!.id,
        actorName: request.user!.displayName,
        taskTitle: task.title,
      },
      excludeUserId: request.user!.id,
    }).catch((err) => request.log.error(err, "Failed to send template task notification"));
  }

  return reply.status(201).send({ data: task });
}
