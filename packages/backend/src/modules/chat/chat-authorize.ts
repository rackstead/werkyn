import type { FastifyReply, FastifyRequest } from "fastify";
import { authorize } from "../../middleware/authorize.js";
import { NotFoundError } from "../../utils/errors.js";
import { assertChannelAccess } from "./chat-access.js";

export function authorizeChat(...roles: ("ADMIN" | "MEMBER" | "VIEWER")[]) {
  const authorizeWorkspace = authorize(...roles);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await authorizeWorkspace(request, reply);
    const { wid, channelId, messageId } = request.params as {
      wid: string;
      channelId?: string;
      messageId?: string;
    };
    let resolvedChannelId = channelId;
    if (messageId) {
      const message = await request.server.prisma.chatMessage.findFirst({
        where: { id: messageId, channel: { workspaceId: wid } },
        select: { channelId: true },
      });
      if (!message) throw new NotFoundError("Message not found");
      resolvedChannelId = message.channelId;
    }
    if (resolvedChannelId) {
      await assertChannelAccess(
        request.server.prisma,
        { workspaceId: wid, userId: request.user!.id },
        resolvedChannelId,
      );
    }
  };
}
