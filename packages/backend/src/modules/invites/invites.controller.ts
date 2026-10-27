import type { FastifyRequest, FastifyReply } from "fastify";
import type { CreateInviteInput } from "@pm/shared";
import * as invitesService from "./invites.service.js";
import * as admissionService from "./admission.service.js";
import { getUserWorkspaces } from "../auth/auth.service.js";

export async function createInviteHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const body = request.body as CreateInviteInput;
  const invite = await invitesService.createInvite(
    request.server.prisma,
    params.wid,
    request.user!.id,
    body,
  );
  return reply.status(201).send({ data: invite });
}

export async function listInvitesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const invites = await invitesService.listInvites(
    request.server.prisma,
    params.wid,
  );
  return reply.send({ data: invites });
}

export async function revokeInviteHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { id: string };
  // The service rechecks the caller's ADMIN role under the workspace lock.
  await invitesService.revokeInvite(
    request.server.prisma,
    params.id,
    request.user!.id,
  );
  return reply.status(204).send();
}

export async function getInviteHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { token: string };
  const invite = await invitesService.getInviteByToken(
    request.server.prisma,
    params.token,
  );
  return reply.send({ data: invite });
}

export async function acceptInviteHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { token: string };
  const userId = request.user!.id;
  const result = await admissionService.admitWithInvite(request.server.prisma, {
    userId,
    token: params.token,
  });
  if (result.status === "denied") {
    throw admissionService.admissionDenialError(result.reason);
  }
  if (result.status === "joined") {
    // The requester's committed memberships, so the client can enter the
    // workspace without depending on a separate session refresh.
    const workspaces = await getUserWorkspaces(request.server.prisma, userId);
    return reply.send({ data: { ...result, userId, workspaces } });
  }
  // Not a member yet: verification or administrator approval is pending.
  return reply.status(202).send({ data: { ...result, userId } });
}

export async function listAdmissionRequestsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const requests = await admissionService.listAdmissionRequests(
    request.server.prisma,
    params.wid,
  );
  return reply.send({ data: requests });
}

export async function approveAdmissionRequestHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; rid: string };
  const result = await admissionService.approveAdmissionRequest(
    request.server.prisma,
    { workspaceId: params.wid, requestId: params.rid, actorId: request.user!.id },
  );
  return reply.send({ data: result });
}

export async function rejectAdmissionRequestHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; rid: string };
  await admissionService.rejectAdmissionRequest(request.server.prisma, {
    workspaceId: params.wid,
    requestId: params.rid,
    actorId: request.user!.id,
  });
  return reply.status(204).send();
}
