import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  CreateWikiSpaceInput,
  UpdateWikiSpaceInput,
  CreateWikiPageInput,
  UpdateWikiPageInput,
  MoveWikiPageInput,
  WikiPageTreeQueryInput,
  WikiPageVersionQueryInput,
  CreateNamedVersionInput,
  CreateWikiCommentInput,
  UpdateWikiCommentInput,
  WikiCommentQueryInput,
  CreateWikiShareInput,
  UpdateWikiShareInput,
  ValidateWikiShareInput,
} from "@pm/shared";
import * as spacesService from "./wiki-spaces.service.js";
import * as pagesService from "./wiki-pages.service.js";
import * as versionsService from "./wiki-versions.service.js";
import * as locksService from "./wiki-locks.service.js";
import * as commentsService from "./wiki-comments.service.js";
import * as sharesService from "./wiki-shares.service.js";
import { setShareGrantCookie, shareGrantCookieName, shareSummary } from "../../utils/share-grants.js";

// ─── Spaces ─────────────────────────────────────────────

export async function createSpaceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const body = request.body as CreateWikiSpaceInput;

  const space = await spacesService.createSpace(
    request.server.prisma,
    wid,
    request.user!.id,
    body,
  );

  request.server.broadcastToWorkspace(wid, "wiki_space_created", {
    space,
  });

  return reply.status(201).send({ data: space });
}

export async function listSpacesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };

  const spaces = await spacesService.listSpaces(request.server.prisma, wid);
  return reply.send({ data: spaces });
}

export async function getSpaceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { sid } = request.params as { sid: string };

  const space = await spacesService.getSpace(request.server.prisma, sid);
  return reply.send({ data: space });
}

export async function updateSpaceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { sid } = request.params as { sid: string };
  const body = request.body as UpdateWikiSpaceInput;

  const space = await spacesService.updateSpace(
    request.server.prisma,
    request.workspaceMember!.workspaceId,
    request.user!.id,
    sid,
    body,
  );

  request.server.broadcastToWorkspace(
    request.workspaceMember!.workspaceId,
    "wiki_space_updated",
    { space },
  );

  return reply.send({ data: space });
}

export async function deleteSpaceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { sid } = request.params as { sid: string };

  const space = await spacesService.getSpace(request.server.prisma, sid);

  await spacesService.deleteSpace(
    request.server.prisma,
    request.workspaceMember!.workspaceId,
    request.user!.id,
    sid,
  );

  request.server.broadcastToWorkspace(
    request.workspaceMember!.workspaceId,
    "wiki_space_deleted",
    { spaceId: sid },
  );

  return reply.status(204).send();
}

// ─── Pages ──────────────────────────────────────────────

export async function createPageHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { sid } = request.params as { sid: string };
  const body = request.body as CreateWikiPageInput;

  const page = await pagesService.createPage(
    request.server.prisma,
    request.workspaceMember!.workspaceId,
    sid,
    request.user!.id,
    body,
  );

  request.server.broadcastToWorkspace(
    request.workspaceMember!.workspaceId,
    "wiki_page_created",
    { page },
  );

  return reply.status(201).send({ data: page });
}

export async function getPageTreeHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { sid } = request.params as { sid: string };
  const query = request.query as WikiPageTreeQueryInput;

  const pages = await pagesService.getPageTree(
    request.server.prisma,
    sid,
    query.parentId,
  );
  return reply.send({ data: pages });
}

export async function getPageHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { pgid } = request.params as { pgid: string };

  const page = await pagesService.getPage(request.server.prisma, pgid);
  return reply.send({ data: page });
}

export async function updatePageHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { pgid } = request.params as { pgid: string };
  const body = request.body as UpdateWikiPageInput;

  // Refuses (409) a stale expectedRevision or another user's edit lock, and
  // records the occasional auto-save version in the same transaction.
  const page = await pagesService.updatePage(
    request.server.prisma,
    pgid,
    request.user!.id,
    body,
  );

  request.server.broadcastToWorkspace(
    request.workspaceMember!.workspaceId,
    "wiki_page_updated",
    { page },
    request.user!.id,
  );

  return reply.send({ data: page });
}

export async function deletePageHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { pgid } = request.params as { pgid: string };

  const deleted = await pagesService.deletePage(
    request.server.prisma,
    request.workspaceMember!.workspaceId,
    request.user!.id,
    pgid,
  );

  request.server.broadcastToWorkspace(
    request.workspaceMember!.workspaceId,
    "wiki_page_deleted",
    { pageId: pgid, spaceId: deleted.spaceId },
  );

  return reply.status(204).send();
}

export async function movePageHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { pgid } = request.params as { pgid: string };
  const body = request.body as MoveWikiPageInput;

  const { page, previous } = await pagesService.movePage(
    request.server.prisma,
    request.workspaceMember!.workspaceId,
    request.user!.id,
    pgid,
    body,
  );

  request.server.broadcastToWorkspace(
    request.workspaceMember!.workspaceId,
    "wiki_page_moved",
    { page, previous },
  );

  return reply.send({ data: page });
}

export async function getBreadcrumbsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { pgid } = request.params as { pgid: string };

  const breadcrumbs = await pagesService.getBreadcrumbs(
    request.server.prisma,
    pgid,
  );
  return reply.send({ data: breadcrumbs });
}

// ─── Versions ───────────────────────────────────────────

export async function listVersionsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { pgid } = request.params as { pgid: string };
  const query = request.query as WikiPageVersionQueryInput;

  const result = await versionsService.listVersions(
    request.server.prisma,
    pgid,
    query.cursor,
    query.limit,
  );
  return reply.send(result);
}

export async function createNamedVersionHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { pgid } = request.params as { pgid: string };
  const body = request.body as CreateNamedVersionInput;

  const version = await versionsService.createNamedVersion(
    request.server.prisma,
    pgid,
    request.user!.id,
    body.name,
  );

  return reply.status(201).send({ data: version });
}

export async function getVersionHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { vid } = request.params as { vid: string };

  const version = await versionsService.getVersion(
    request.server.prisma,
    vid,
  );
  return reply.send({ data: version });
}

export async function restoreVersionHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { vid } = request.params as { vid: string };

  const page = await versionsService.restoreVersion(
    request.server.prisma,
    vid,
    request.user!.id,
  );

  request.server.broadcastToWorkspace(
    request.workspaceMember!.workspaceId,
    "wiki_page_updated",
    { page },
  );

  return reply.send({ data: page });
}

// ─── Locks ──────────────────────────────────────────────

export async function acquireLockHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { pgid } = request.params as { pgid: string };

  const lock = await locksService.acquireLock(
    request.server.prisma,
    pgid,
    request.user!.id,
  );

  request.server.broadcastToWorkspace(
    request.workspaceMember!.workspaceId,
    "wiki_page_locked",
    { pageId: pgid, lock },
    request.user!.id,
  );

  return reply.send({ data: lock });
}

export async function releaseLockHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { pgid } = request.params as { pgid: string };

  await locksService.releaseLock(
    request.server.prisma,
    pgid,
    request.user!.id,
  );

  request.server.broadcastToWorkspace(
    request.workspaceMember!.workspaceId,
    "wiki_page_unlocked",
    { pageId: pgid },
  );

  return reply.status(204).send();
}

export async function heartbeatLockHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { pgid } = request.params as { pgid: string };

  await locksService.heartbeatLock(
    request.server.prisma,
    pgid,
    request.user!.id,
  );

  return reply.status(204).send();
}

export async function checkLockHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { pgid } = request.params as { pgid: string };

  const lock = await locksService.checkLock(request.server.prisma, pgid);
  return reply.send({ data: lock });
}

// ─── Comments ───────────────────────────────────────────

export async function listCommentsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { pgid } = request.params as { pgid: string };
  const query = request.query as WikiCommentQueryInput;

  const comments = await commentsService.listComments(
    request.server.prisma,
    pgid,
    query.resolved,
  );
  return reply.send({ data: comments });
}

export async function createCommentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { pgid } = request.params as { pgid: string };
  const body = request.body as CreateWikiCommentInput;

  const { comment, workspaceId } = await commentsService.createComment(
    request.server.prisma,
    pgid,
    request.user!.id,
    body,
  );

  request.server.broadcastToWorkspace(
    workspaceId,
    "wiki_comment_created",
    { comment, pageId: pgid },
    request.user!.id,
  );

  return reply.status(201).send({ data: comment });
}

export async function updateCommentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { cid } = request.params as { cid: string };
  const body = request.body as UpdateWikiCommentInput;

  const { comment } = await commentsService.updateComment(
    request.server.prisma,
    cid,
    request.user!.id,
    request.workspaceMember!.role,
    body,
  );

  return reply.send({ data: comment });
}

export async function resolveCommentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { cid } = request.params as { cid: string };

  const { comment, workspaceId } = await commentsService.resolveComment(
    request.server.prisma,
    cid,
    request.user!.id,
  );

  request.server.broadcastToWorkspace(
    workspaceId,
    "wiki_comment_resolved",
    { comment },
  );

  return reply.send({ data: comment });
}

export async function deleteCommentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { cid } = request.params as { cid: string };

  await commentsService.deleteComment(
    request.server.prisma,
    cid,
    request.user!.id,
    request.workspaceMember!.role,
  );

  return reply.status(204).send();
}

// ─── Shares ─────────────────────────────────────────────

export async function getShareHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { pgid } = request.params as { pgid: string };

  const share = await sharesService.getShare(request.server.prisma, pgid);
  return reply.send({ data: share ? shareSummary(share) : null });
}

export async function createShareHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { pgid } = request.params as { pgid: string };
  const body = request.body as CreateWikiShareInput;

  const share = await sharesService.createShare(
    request.server.prisma,
    pgid,
    request.user!.id,
    body.password,
  );

  return reply.status(201).send({ data: shareSummary(share) });
}

export async function updateShareHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { shid } = request.params as { shid: string };
  const body = request.body as UpdateWikiShareInput;

  const share = await sharesService.updateShare(
    request.server.prisma,
    shid,
    body,
  );

  return reply.send({ data: shareSummary(share) });
}

export async function deleteShareHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { shid } = request.params as { shid: string };

  await sharesService.deleteShare(request.server.prisma, shid);
  return reply.status(204).send();
}

// ─── Public (unauthenticated) ───────────────────────────

export async function getPublicPageHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { token } = request.params as { token: string };

  const result = await sharesService.getPublicPage(
    request.server.prisma,
    token,
    request.cookies[shareGrantCookieName("wiki", token)],
  );
  return reply.send({ data: result });
}

export async function validatePublicPageHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { token } = request.params as { token: string };
  const body = request.body as ValidateWikiShareInput;

  const share = await sharesService.validateShareAccess(
    request.server.prisma,
    token,
    body.password,
  );
  setShareGrantCookie(reply, "wiki", token, share);

  return reply.send({ data: { valid: true } });
}
