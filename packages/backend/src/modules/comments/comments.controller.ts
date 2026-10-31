import type { FastifyRequest, FastifyReply } from "fastify";
import * as commentsService from "./comments.service.js";
import { deliverNotification } from "../notifications/notification-delivery.js";
import type { CreateCommentInput, UpdateCommentInput, CommentQueryInput } from "@pm/shared";

export async function listCommentsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string };
  const query = request.query as CommentQueryInput;
  const result = await commentsService.listComments(
    request.server.prisma,
    params.tid,
    query,
  );
  return reply.send(result);
}

export async function createCommentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { tid: string };
  const body = request.body as CreateCommentInput;
  const { comment, projectId, notificationDeliveryIds } = await commentsService.createComment(
    request.server.prisma,
    params.tid,
    request.user!.id,
    body,
  );
  try {
    request.server.broadcast(projectId, "comment_created", {
      taskId: params.tid,
      commentId: comment.id,
    });
  } catch {
    request.log.error({ commentId: comment.id }, "Could not broadcast committed comment");
  }
  for (const id of notificationDeliveryIds) {
    void deliverNotification(request.server.prisma, request.server, id, { log: request.server.log })
      .catch(() => request.log.error(
        { commentId: comment.id, notificationDeliveryId: id },
        "Committed comment notification remains queued for retry",
      ));
  }
  return reply.status(201).send({ data: comment });
}

export async function updateCommentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { id: string };
  const body = request.body as UpdateCommentInput;
  const { comment, projectId } = await commentsService.updateComment(
    request.server.prisma,
    params.id,
    request.user!.id,
    request.workspaceMember!.role,
    body,
  );
  request.server.broadcast(projectId, "comment_updated", {
    taskId: comment.taskId,
    commentId: comment.id,
  });
  return reply.send({ data: comment });
}

export async function deleteCommentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { id: string };
  const { taskId, projectId } = await commentsService.deleteComment(
    request.server.prisma,
    params.id,
    request.user!.id,
    request.workspaceMember!.role,
  );
  request.server.broadcast(projectId, "comment_deleted", {
    taskId,
    commentId: params.id,
  });
  return reply.status(204).send();
}
