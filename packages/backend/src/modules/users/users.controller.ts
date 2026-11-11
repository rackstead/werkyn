import type { FastifyRequest, FastifyReply } from "fastify";
import * as usersService from "./users.service.js";

export async function getMeHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const user = await usersService.getMe(
    request.server.prisma,
    request.user!.id,
  );
  return reply.send({ data: user });
}

export async function updateProfileHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { id: string };
  const body = request.body as {
    displayName?: string;
    avatarUrl?: string | null;
    jobTitle?: string | null;
    phone?: string | null;
    timezone?: string | null;
  };

  const user = await usersService.updateProfile(
    request.server.prisma,
    request.server.storage,
    params.id,
    request.user!.id,
    body,
  );

  return reply.send({ data: user });
}

export async function updateMeHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const body = request.body as {
    displayName?: string;
    avatarUrl?: string | null;
    jobTitle?: string | null;
    phone?: string | null;
    timezone?: string | null;
  };

  const user = await usersService.updateProfile(
    request.server.prisma,
    request.server.storage,
    request.user!.id,
    request.user!.id,
    body,
  );

  return reply.send({ data: user });
}

export async function changePasswordHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { id: string };
  const body = request.body as {
    currentPassword: string;
    newPassword: string;
  };

  const result = await usersService.changePassword(
    request.server.prisma,
    params.id,
    request.user!.id,
    body,
  );

  return reply.send(result);
}
