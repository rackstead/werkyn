import type { FastifyRequest, FastifyReply } from "fastify";
import type { WorkspaceSearchInput, UpdateWorkspaceSettingsInput, ActivityLogQueryInput, UpdateDashboardPreferenceInput } from "@pm/shared";
import * as workspacesService from "./workspaces.service.js";
import * as chatService from "../chat/chat.service.js";
import * as dashboardPreferenceService from "./dashboard-preference.service.js";

export async function createWorkspaceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const body = request.body as { name: string; slug: string };
  const workspace = await workspacesService.createWorkspace(
    request.server.prisma,
    request.user!.id,
    body,
  );
  return reply.status(201).send({ data: workspace });
}

export async function listWorkspacesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const workspaces = await workspacesService.listWorkspaces(
    request.server.prisma,
    request.user!.id,
  );
  return reply.send({ data: workspaces });
}

export async function getWorkspaceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const workspace = await workspacesService.getWorkspace(
    request.server.prisma,
    params.wid,
    request.user!.id,
  );
  return reply.send({ data: workspace });
}

export async function updateWorkspaceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const body = request.body as { name?: string; slug?: string; logoUrl?: string | null };
  const workspace = await workspacesService.updateWorkspace(
    request.server.prisma,
    params.wid,
    body,
  );
  return reply.send({ data: workspace });
}

export async function deleteWorkspaceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  await workspacesService.deleteWorkspace(request.server.prisma, params.wid);
  return reply.status(204).send();
}

export async function listMembersHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const members = await workspacesService.listMembers(
    request.server.prisma,
    params.wid,
  );
  return reply.send({ data: members });
}

export async function updateMemberRoleHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; uid: string };
  const body = request.body as { role: "ADMIN" | "MEMBER" | "VIEWER" };
  const member = await workspacesService.updateMemberRole(
    request.server.prisma,
    params.wid,
    params.uid,
    request.user!.id,
    body,
  );
  return reply.send({ data: member });
}

export async function removeMemberHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; uid: string };
  await workspacesService.removeMember(
    request.server.prisma,
    params.wid,
    params.uid,
    request.user!.id,
    request.workspaceMember!.role,
  );
  return reply.status(204).send();
}

export async function getDashboardHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const result = await workspacesService.getDashboard(
    request.server.prisma,
    params.wid,
    request.user!.id,
    request.workspaceMember!.role,
  );
  return reply.send(result);
}

export async function getMyTasksHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const result = await workspacesService.getMyTasks(
    request.server.prisma,
    params.wid,
    request.user!.id,
    request.workspaceMember!.role,
  );
  return reply.send(result);
}

export async function getWorkspaceSettingsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const settings = await workspacesService.getWorkspaceSettings(
    request.server.prisma,
    params.wid,
  );
  return reply.send({ data: settings });
}

export async function updateWorkspaceSettingsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const body = request.body as UpdateWorkspaceSettingsInput;
  const settings = await workspacesService.updateWorkspaceSettings(
    request.server.prisma,
    params.wid,
    request.user!.id,
    body,
  );
  return reply.send({ data: settings });
}

export async function listWorkspaceActivityHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const query = request.query as ActivityLogQueryInput;
  const result = await workspacesService.listWorkspaceActivity(
    request.server.prisma,
    params.wid,
    query,
    request.user!.id,
    request.workspaceMember!.role,
  );
  return reply.send(result);
}

export async function searchHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const query = request.query as WorkspaceSearchInput;
  const [taskResult, wikiPages, chatMessagesResult] = await Promise.all([
    workspacesService.searchTasks(
      request.server.prisma,
      params.wid,
      request.user!.id,
      request.workspaceMember!.role,
      query.q,
      query.limit,
    ),
    workspacesService.searchWikiPages(
      request.server.prisma,
      params.wid,
      query.q,
      10,
    ),
    chatService.searchMessages(
      request.server.prisma,
      params.wid,
      request.user!.id,
      query.q,
      undefined,
      undefined,
      10,
    ),
  ]);
  return reply.send({ data: taskResult.data, wikiPages, chatMessages: chatMessagesResult.data });
}

export async function getDashboardPreferenceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const pref = await dashboardPreferenceService.getDashboardPreference(
    request.server.prisma,
    request.user!.id,
    params.wid,
  );
  return reply.send({ data: pref });
}

export async function updateDashboardPreferenceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const body = request.body as UpdateDashboardPreferenceInput;
  const pref = await dashboardPreferenceService.updateDashboardPreference(
    request.server.prisma,
    request.user!.id,
    params.wid,
    body,
  );
  return reply.send({ data: pref });
}
