import type { PrismaClient } from "@prisma/client";
import type { CreateCommentInput, UpdateCommentInput, CommentQueryInput } from "@pm/shared";
import { ForbiddenError, NotFoundError } from "../../utils/errors.js";
import { logActivity } from "../../utils/activity-log.js";
import {
  enqueueNotifications,
  type NotificationRequest,
} from "../notifications/notification-delivery.js";

export function parseMentions(body: string): string[] {
  const regex = /@\[([^\]]+)\]/g;
  const userIds: string[] = [];
  let match;
  while ((match = regex.exec(body)) !== null) {
    userIds.push(match[1]);
  }
  return [...new Set(userIds)];
}

// Keep the existing code-unit limit without cutting a valid surrogate pair.
function notificationExcerpt(body: string): string {
  const prefix = body.slice(0, 100);
  const last = prefix.charCodeAt(prefix.length - 1);
  const next = body.charCodeAt(100);
  return last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? prefix.slice(0, -1)
    : prefix;
}

export async function listComments(
  prisma: PrismaClient,
  taskId: string,
  query: CommentQueryInput,
) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true },
  });
  if (!task) throw new NotFoundError("Task not found");

  const take = query.limit + 1;

  // If cursor provided, validate it exists to avoid Prisma errors
  let validCursor = query.cursor;
  if (validCursor) {
    const cursorExists = await prisma.comment.findUnique({
      where: { id: validCursor },
      select: { id: true },
    });
    if (!cursorExists) validCursor = undefined;
  }

  const comments = await prisma.comment.findMany({
    where: { taskId },
    include: {
      author: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take,
    ...(validCursor
      ? { cursor: { id: validCursor }, skip: 1 }
      : {}),
  });

  const hasMore = comments.length > query.limit;
  const data = hasMore ? comments.slice(0, query.limit) : comments;
  const nextCursor = hasMore ? data[data.length - 1].id : undefined;

  return { data, nextCursor };
}

export async function createComment(
  prisma: PrismaClient,
  taskId: string,
  authorId: string,
  data: CreateCommentInput,
) {
  return prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        projectId: true,
        title: true,
        assignees: { select: { userId: true } },
      },
    });
    if (!task) throw new NotFoundError("Task not found");

    const comment = await tx.comment.create({
      data: { taskId, authorId, body: data.body },
      include: {
        author: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    });
    await logActivity(tx, {
      taskId,
      actorId: authorId,
      action: "comment_added",
      details: { commentId: comment.id },
    });

    const mentionedUserIds = parseMentions(data.body);
    const mentionSet = new Set(mentionedUserIds);
    const commentRecipients = task.assignees
      .map((assignee) => assignee.userId)
      .filter((id) => !mentionSet.has(id));
    const actorName = comment.author?.displayName ?? "Someone";
    const excerpt = notificationExcerpt(data.body);
    const notificationData = {
      taskId,
      projectId: task.projectId,
      commentId: comment.id,
      actorId: authorId,
      actorName,
      taskTitle: task.title,
    };
    const notifications: NotificationRequest[] = [];
    if (commentRecipients.length > 0) {
      notifications.push({
        recipients: commentRecipients,
        type: "COMMENT_ADDED",
        title: `New comment on "${task.title}"`,
        body: `${actorName}: ${excerpt}`,
        data: notificationData,
        excludeUserId: authorId,
      });
    }
    if (mentionedUserIds.length > 0) {
      notifications.push({
        recipients: mentionedUserIds,
        type: "COMMENT_MENTION",
        title: `${actorName} mentioned you in "${task.title}"`,
        body: excerpt,
        data: notificationData,
        excludeUserId: authorId,
      });
    }
    const notificationDeliveryIds = await enqueueNotifications(tx, notifications);
    return { comment, projectId: task.projectId, mentionedUserIds, notificationDeliveryIds };
  });
}

export async function updateComment(
  prisma: PrismaClient,
  commentId: string,
  actorId: string,
  actorRole: string,
  data: UpdateCommentInput,
) {
  const existing = await prisma.comment.findUnique({
    where: { id: commentId },
    include: { task: { select: { projectId: true } } },
  });
  if (!existing) throw new NotFoundError("Comment not found");

  // Only the author or an ADMIN can edit
  if (existing.authorId !== actorId && actorRole !== "ADMIN") {
    throw new ForbiddenError("You can only edit your own comments");
  }

  const comment = await prisma.comment.update({
    where: { id: commentId },
    data: { body: data.body },
    include: {
      author: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
    },
  });

  await logActivity(prisma, {
    taskId: existing.taskId,
    actorId,
    action: "comment_edited",
    details: { commentId },
  });

  return { comment, projectId: existing.task.projectId };
}

export async function deleteComment(
  prisma: PrismaClient,
  commentId: string,
  actorId: string,
  actorRole: string,
) {
  const existing = await prisma.comment.findUnique({
    where: { id: commentId },
    include: { task: { select: { projectId: true } } },
  });
  if (!existing) throw new NotFoundError("Comment not found");

  // Only the author or an ADMIN can delete
  if (existing.authorId !== actorId && actorRole !== "ADMIN") {
    throw new ForbiddenError("You can only delete your own comments");
  }

  await prisma.comment.delete({ where: { id: commentId } });

  await logActivity(prisma, {
    taskId: existing.taskId,
    actorId,
    action: "comment_deleted",
    details: { commentId },
  });

  return { taskId: existing.taskId, projectId: existing.task.projectId };
}
