import type { FastifyReply, FastifyRequest } from "fastify";
import type { UpdateRegistrationConfigInput } from "@pm/shared";
import * as registrationService from "./registration.service.js";

export async function getRegistrationConfigHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const config = await registrationService.getRegistrationConfig(
    request.server.prisma,
  );
  return reply.send({ data: config });
}

export async function updateRegistrationConfigHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const body = request.body as UpdateRegistrationConfigInput;
  const config = await registrationService.updateRegistrationConfig(
    request.server.prisma,
    body,
  );
  return reply.send({ data: config });
}
