import type { FastifyRequest, FastifyReply } from "fastify";
import * as customFieldsService from "./custom-fields.service.js";
import type {
  CreateCustomFieldInput,
  UpdateCustomFieldInput,
  ReorderCustomFieldsInput,
  SetCustomFieldValueInput,
} from "@pm/shared";
import { logActivity } from "../../utils/activity-log.js";

export async function listCustomFieldsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string };
  const fields = await customFieldsService.listCustomFields(
    request.server.prisma,
    params.pid,
  );
  return reply.send({ data: fields });
}

export async function createCustomFieldHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string };
  const body = request.body as CreateCustomFieldInput;
  const field = await customFieldsService.createCustomField(
    request.server.prisma,
    params.pid,
    body,
  );
  request.server.broadcast(params.pid, "custom_field_created", { fieldId: field.id });
  return reply.status(201).send({ data: field });
}

export async function updateCustomFieldHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string; id: string };
  const body = request.body as UpdateCustomFieldInput;
  const user = request.user as { id: string };
  const { field, migratedValues, clearedValues } = await customFieldsService.updateCustomField(
    request.server.prisma,
    params.pid,
    params.id,
    body,
    user.id,
  );
  request.server.broadcast(params.pid, "custom_field_updated", { fieldId: field.id });
  if (migratedValues + clearedValues > 0) {
    // Renamed or removed options rewrote task values.
    request.server.broadcast(params.pid, "task_updated", { bulk: true });
  }
  return reply.send({ data: field, meta: { migratedValues, clearedValues } });
}

export async function deleteCustomFieldHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string; id: string };
  await customFieldsService.deleteCustomField(
    request.server.prisma,
    params.pid,
    params.id,
  );
  request.server.broadcast(params.pid, "custom_field_deleted", { fieldId: params.id });
  return reply.status(204).send();
}

export async function reorderCustomFieldsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string };
  const body = request.body as ReorderCustomFieldsInput;
  const fields = await customFieldsService.reorderCustomFields(
    request.server.prisma,
    params.pid,
    body,
  );
  request.server.broadcast(params.pid, "custom_field_updated", { reordered: true });
  return reply.send({ data: fields });
}

export async function setFieldValueHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string; tid: string; fieldId: string };
  const body = request.body as SetCustomFieldValueInput;
  const user = request.user as { id: string };

  const result = await customFieldsService.setFieldValue(
    request.server.prisma,
    params.pid,
    params.tid,
    params.fieldId,
    body,
    user.id,
  );

  await logActivity(request.server.prisma, {
    taskId: params.tid,
    actorId: user.id,
    action: "custom_field_changed",
    // The stored value: an empty value is recorded as null (cleared).
    details: { fieldId: params.fieldId, value: result ? result.value : null },
  });

  request.server.broadcast(params.pid, "task_updated", { taskId: params.tid });
  return reply.send({ data: result });
}
