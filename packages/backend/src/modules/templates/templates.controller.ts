import type { FastifyRequest, FastifyReply } from "fastify";
import * as templatesService from "./templates.service.js";
import { deliverNotification } from "../notifications/notification-delivery.js";
import type { CreateTemplateInput, UpdateTemplateInput, InstantiateTemplateInput } from "@pm/shared";

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
  const { task, notificationDeliveryIds } = await templatesService.createTaskFromTemplateWithNotifications(
    request.server.prisma,
    params.pid,
    params.templateId,
    request.user!.id,
    request.workspaceMember!.role,
    request.user!.displayName,
    body,
  );
  try {
    request.server.broadcast(params.pid, "task_created", { taskId: task.id });
  } catch (error) {
    request.log.error(
      { stage: "template_broadcast", taskId: task.id, ...postCommitDiagnostics(error) },
      "Could not broadcast committed template task",
    );
  }
  for (const id of notificationDeliveryIds) {
    void deliverNotification(request.server.prisma, request.server, id, { log: request.server.log })
      .catch((error) => request.log.error(
        { stage: "notification_delivery", taskId: task.id, notificationDeliveryId: id, ...postCommitDiagnostics(error) },
        "Committed template task notification remains queued for retry",
      ));
  }

  return reply.status(201).send({ data: task });
}
