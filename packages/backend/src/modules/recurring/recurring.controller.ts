import type { FastifyRequest, FastifyReply } from "fastify";
import * as recurringService from "./recurring.service.js";
import type { CreateRecurringInput, UpdateRecurringInput } from "@pm/shared";

export async function listRecurringHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string };
  const configs = await recurringService.listRecurringConfigs(
    request.server.prisma,
    params.pid,
  );
  return reply.send({ data: configs });
}

export async function createRecurringHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string };
  const body = request.body as CreateRecurringInput;
  const config = await recurringService.createRecurringConfig(
    request.server.prisma,
    params.pid,
    body,
  );
  return reply.status(201).send({ data: config });
}

export async function updateRecurringHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string; configId: string };
  const body = request.body as UpdateRecurringInput;
  const config = await recurringService.updateRecurringConfig(
    request.server.prisma,
    params.pid,
    params.configId,
    body,
  );
  return reply.send({ data: config });
}

export async function deleteRecurringHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { pid: string; configId: string };
  await recurringService.deleteRecurringConfig(
    request.server.prisma,
    params.pid,
    params.configId,
  );
  return reply.status(204).send();
}
