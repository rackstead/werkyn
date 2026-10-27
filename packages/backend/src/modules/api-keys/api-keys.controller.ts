import type { FastifyRequest, FastifyReply } from "fastify";
import type { CreateApiKeyInput } from "@pm/shared";
import * as apiKeys from "./api-keys.service.js";

export async function listApiKeysHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const data = await apiKeys.listApiKeys(
    request.server.prisma,
    request.user!.id,
  );
  return reply.send({ data });
}

export async function createApiKeyHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const data = await apiKeys.createApiKey(
    request.server.prisma,
    request.user!.id,
    request.body as CreateApiKeyInput,
  );
  return reply.status(201).send({ data });
}

export async function revokeApiKeyHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { id } = request.params as { id: string };
  await apiKeys.revokeApiKey(request.server.prisma, request.user!.id, id);
  return reply.status(204).send();
}
