import type { FastifyRequest, FastifyReply } from "fastify";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "../utils/errors.js";
import { assertProjectAccess } from "../utils/project-access.js";

type AllowedRole = "ADMIN" | "MEMBER" | "VIEWER";

export function authorize(...allowedRoles: AllowedRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      throw new UnauthorizedError();
    }

    const params = request.params as Record<string, string>;

    // Resolve workspaceId from route params
    let workspaceId: string | undefined = params.wid;
    let projectId: string | undefined;
    const referencedProjectIds = new Set<string>();

    // If no :wid, try resolving from project (:pid) or task (:tid)
    if (params.pid) {
      const project = await request.server.prisma.project.findUnique({
        where: { id: params.pid },
        select: { workspaceId: true },
      });
      if (!project) throw new NotFoundError("Project not found");
      if (workspaceId && workspaceId !== project.workspaceId) throw new NotFoundError("Project not found in this workspace");
      workspaceId = project.workspaceId;
      projectId = params.pid;
    }

    if (params.tid) {
      const task = await request.server.prisma.task.findUnique({
        where: { id: params.tid },
        select: { projectId: true, project: { select: { workspaceId: true } } },
      });
      if (!task) throw new NotFoundError("Task not found");
      if ((workspaceId && workspaceId !== task.project.workspaceId) || (projectId && projectId !== task.projectId)) {
        throw new NotFoundError("Task not found in this project");
      }
      workspaceId = task.project.workspaceId;
      projectId = task.projectId;
    }

    // Resolve from time entry :eid
    if (params.eid) {
      const timeEntry = await request.server.prisma.timeEntry.findUnique({
        where: { id: params.eid },
        select: { workspaceId: true, projectId: true, task: { select: { projectId: true } } },
      });
      if (!timeEntry) throw new NotFoundError("Time entry not found");
      if (workspaceId && workspaceId !== timeEntry.workspaceId) throw new NotFoundError("Time entry not found in this workspace");
      workspaceId = timeEntry.workspaceId;
      if (timeEntry.projectId) referencedProjectIds.add(timeEntry.projectId);
      if (timeEntry.task) referencedProjectIds.add(timeEntry.task.projectId);
    }

    // Resolve from group :gid
    if (!workspaceId && params.gid) {
      const group = await request.server.prisma.group.findUnique({
        where: { id: params.gid },
        select: { workspaceId: true },
      });
      if (!group) throw new NotFoundError("Group not found");
      workspaceId = group.workspaceId;
    }

    // Resolve from wiki space :sid
    if (!workspaceId && params.sid) {
      const wikiSpace = await request.server.prisma.wikiSpace.findUnique({
        where: { id: params.sid },
        select: { workspaceId: true },
      });
      if (!wikiSpace) throw new NotFoundError("Wiki space not found");
      workspaceId = wikiSpace.workspaceId;
    }

    // Resolve from wiki page :pgid
    if (!workspaceId && params.pgid) {
      const wikiPage = await request.server.prisma.wikiPage.findUnique({
        where: { id: params.pgid },
        select: { space: { select: { workspaceId: true } } },
      });
      if (!wikiPage) throw new NotFoundError("Wiki page not found");
      workspaceId = wikiPage.space.workspaceId;
    }

    // Resolve from wiki comment :cid
    if (!workspaceId && params.cid) {
      const wikiComment = await request.server.prisma.wikiPageComment.findUnique({
        where: { id: params.cid },
        select: { page: { select: { space: { select: { workspaceId: true } } } } },
      });
      if (!wikiComment) throw new NotFoundError("Wiki comment not found");
      workspaceId = wikiComment.page.space.workspaceId;
    }

    // Resolve from wiki version :vid
    if (!workspaceId && params.vid) {
      const wikiVersion = await request.server.prisma.wikiPageVersion.findUnique({
        where: { id: params.vid },
        select: { page: { select: { space: { select: { workspaceId: true } } } } },
      });
      if (!wikiVersion) throw new NotFoundError("Wiki version not found");
      workspaceId = wikiVersion.page.space.workspaceId;
    }

    // Resolve from wiki share :shid
    if (!workspaceId && params.shid) {
      const wikiShare = await request.server.prisma.wikiPageShare.findUnique({
        where: { id: params.shid },
        select: { page: { select: { space: { select: { workspaceId: true } } } } },
      });
      if (!wikiShare) throw new NotFoundError("Wiki share not found");
      workspaceId = wikiShare.page.space.workspaceId;
    }

    // Resolve from subtask or comment :id param
    if (!workspaceId && params.id) {
      // IDs are only unique within a table. Do not authorize a comment by an
      // unrelated subtask with the same ID (or vice versa).
      const subtask = request.routeOptions.url?.includes("/subtasks/")
        ? await request.server.prisma.subtask.findUnique({
        where: { id: params.id },
        select: { task: { select: { projectId: true, project: { select: { workspaceId: true } } } } },
      }) : null;
      if (subtask) {
        workspaceId = subtask.task.project.workspaceId;
        projectId = subtask.task.projectId;
      } else {
        const comment = request.routeOptions.url?.includes("/comments/")
          ? await request.server.prisma.comment.findUnique({
          where: { id: params.id },
          select: { task: { select: { projectId: true, project: { select: { workspaceId: true } } } } },
        }) : null;
        if (comment) {
          workspaceId = comment.task.project.workspaceId;
          projectId = comment.task.projectId;
        } else {
          throw new NotFoundError("Resource not found");
        }
      }
    }

    if (!workspaceId) {
      throw new ForbiddenError("Cannot determine workspace context");
    }

    const member = await request.server.prisma.workspaceMember.findUnique({
      where: {
        userId_workspaceId: {
          userId: request.user.id,
          workspaceId,
        },
      },
      select: {
        id: true,
        userId: true,
        workspaceId: true,
        role: true,
      },
    });

    if (!member) {
      throw new ForbiddenError("Not a member of this workspace");
    }

    if (!allowedRoles.includes(member.role as AllowedRole)) {
      throw new ForbiddenError("Insufficient permissions");
    }

    if (projectId) referencedProjectIds.add(projectId);
    for (const referencedProjectId of referencedProjectIds) {
      const access = await assertProjectAccess(request.server.prisma, referencedProjectId, request.user.id);
      if (access.workspaceId !== workspaceId) throw new NotFoundError("Project not found in this workspace");
    }

    request.workspaceMember = member;
  };
}
