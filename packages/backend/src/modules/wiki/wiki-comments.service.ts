import type { PrismaClient, Prisma } from "@prisma/client";
import type { CreateWikiCommentInput, UpdateWikiCommentInput } from "@pm/shared";
import { NotFoundError, ForbiddenError } from "../../utils/errors.js";
import { assertWikiJson } from "./wiki-json.js";

const commentInclude = {
  author: { select: { id: true, displayName: true, avatarUrl: true } },
  resolvedBy: { select: { id: true, displayName: true, avatarUrl: true } },
} satisfies Prisma.WikiPageCommentInclude;

export function parseMentions(body: string): string[] {
  const regex = /@\[([^\]]+)\]/g;
  const userIds: string[] = [];
  let match;
  while ((match = regex.exec(body)) !== null) {
    userIds.push(match[1]);
  }
  return [...new Set(userIds)];
}

export async function createComment(
  prisma: PrismaClient,
  pageId: string,
  authorId: string,
  data: CreateWikiCommentInput,
) {
  assertWikiJson(data.selectionStart, "selectionStart");
  assertWikiJson(data.selectionEnd, "selectionEnd");
  const page = await prisma.wikiPage.findUnique({
    where: { id: pageId },
    select: { id: true, spaceId: true, space: { select: { workspaceId: true } } },
  });
  if (!page) throw new NotFoundError("Wiki page not found");

  const comment = await prisma.wikiPageComment.create({
    data: {
      pageId,
      authorId,
      body: data.body,
      highlightId: data.highlightId,
      selectionStart: data.selectionStart as Prisma.InputJsonValue,
      selectionEnd: data.selectionEnd as Prisma.InputJsonValue,
    },
    include: commentInclude,
  });

  const mentionedUserIds = parseMentions(data.body);
  return { comment, workspaceId: page.space.workspaceId, mentionedUserIds };
}

export async function listComments(
  prisma: PrismaClient,
  pageId: string,
  resolved?: boolean,
) {
  return prisma.wikiPageComment.findMany({
    where: {
      pageId,
      ...(resolved !== undefined ? { resolved } : {}),
    },
    orderBy: { createdAt: "asc" },
    include: commentInclude,
  });
}

export async function updateComment(
  prisma: PrismaClient,
  commentId: string,
  actorId: string,
  actorRole: string,
  data: UpdateWikiCommentInput,
) {
  const existing = await prisma.wikiPageComment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      authorId: true,
      pageId: true,
      page: { select: { space: { select: { workspaceId: true } } } },
    },
  });
  if (!existing) throw new NotFoundError("Comment not found");

  if (existing.authorId !== actorId && actorRole !== "ADMIN") {
    throw new ForbiddenError("You can only edit your own comments");
  }

  const comment = await prisma.wikiPageComment.update({
    where: { id: commentId },
    data: { body: data.body },
    include: commentInclude,
  });

  return { comment, workspaceId: existing.page.space.workspaceId };
}

export async function resolveComment(
  prisma: PrismaClient,
  commentId: string,
  actorId: string,
) {
  const existing = await prisma.wikiPageComment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      pageId: true,
      page: { select: { space: { select: { workspaceId: true } } } },
    },
  });
  if (!existing) throw new NotFoundError("Comment not found");

  const comment = await prisma.wikiPageComment.update({
    where: { id: commentId },
    data: {
      resolved: true,
      resolvedById: actorId,
      resolvedAt: new Date(),
    },
    include: commentInclude,
  });

  return { comment, workspaceId: existing.page.space.workspaceId };
}

export async function deleteComment(
  prisma: PrismaClient,
  commentId: string,
  actorId: string,
  actorRole: string,
) {
  const existing = await prisma.wikiPageComment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      authorId: true,
      pageId: true,
      page: { select: { space: { select: { workspaceId: true } } } },
    },
  });
  if (!existing) throw new NotFoundError("Comment not found");

  if (existing.authorId !== actorId && actorRole !== "ADMIN") {
    throw new ForbiddenError("You can only delete your own comments");
  }

  await prisma.wikiPageComment.delete({ where: { id: commentId } });
  return { workspaceId: existing.page.space.workspaceId, pageId: existing.pageId };
}
