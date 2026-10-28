import type { FastifyRequest, FastifyReply } from "fastify";
import * as teamFoldersService from "./team-folders.service.js";
import type {
  CreateTeamFolderInput,
  UpdateTeamFolderInput,
  AddTeamFolderMemberInput,
  AddTeamFolderGroupInput,
} from "@pm/shared";

export async function createTeamFolderHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const body = request.body as CreateTeamFolderInput;

  const teamFolder = await teamFoldersService.createTeamFolder(
    request.server.prisma,
    params.wid,
    request.user!.id,
    body,
  );

  return reply.status(201).send({ data: teamFolder });
}

export async function listTeamFoldersHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };

  const teamFolders = await teamFoldersService.listTeamFolders(
    request.server.prisma,
    params.wid,
    request.user!.id,
    request.workspaceMember!.role,
  );

  return reply.send({ data: teamFolders });
}

export async function getTeamFolderHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; tfid: string };

  const teamFolder = await teamFoldersService.getTeamFolder(
    request.server.prisma,
    params.wid,
    params.tfid,
    request.user!.id,
    request.workspaceMember!.role,
  );

  return reply.send({ data: teamFolder });
}

export async function updateTeamFolderHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; tfid: string };
  const body = request.body as UpdateTeamFolderInput;

  const teamFolder = await teamFoldersService.updateTeamFolder(
    request.server.prisma,
    params.wid,
    params.tfid,
    body,
  );

  return reply.send({ data: teamFolder });
}

export async function deleteTeamFolderHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; tfid: string };

  await teamFoldersService.deleteTeamFolder(
    request.server.prisma,
    request.server.storage,
    params.wid,
    params.tfid,
  );

  return reply.status(204).send();
}

export async function addMemberHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; tfid: string };
  const body = request.body as AddTeamFolderMemberInput;

  const member = await teamFoldersService.addMember(
    request.server.prisma,
    params.wid,
    params.tfid,
    body.userId,
  );

  return reply.status(201).send({ data: member });
}

export async function removeMemberHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; tfid: string; uid: string };

  await teamFoldersService.removeMember(
    request.server.prisma,
    params.wid,
    params.tfid,
    params.uid,
  );

  return reply.status(204).send();
}

export async function addGroupHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; tfid: string };
  const body = request.body as AddTeamFolderGroupInput;

  const tfGroup = await teamFoldersService.addGroupToTeamFolder(
    request.server.prisma,
    params.wid,
    params.tfid,
    body.groupId,
  );

  return reply.status(201).send({ data: tfGroup });
}

export async function removeGroupHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; tfid: string; gid: string };

  await teamFoldersService.removeGroupFromTeamFolder(
    request.server.prisma,
    params.wid,
    params.tfid,
    params.gid,
  );

  return reply.status(204).send();
}
