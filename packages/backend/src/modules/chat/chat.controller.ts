import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  CreateChannelInput,
  UpdateChannelInput,
  SendMessageInput,
  UpdateMessageInput,
  CreateDmInput,
  AddMembersInput,
  ChatMessageQueryInput,
  ToggleReactionInput,
  PinMessageInput,
  ArchiveChannelInput,
  SearchMessagesInput,
} from "@pm/shared";
import * as chatService from "./chat.service.js";
import { createNotifications } from "../notifications/notifications.service.js";
import { broadcastToChannel, broadcastToWorkspace, broadcastToUser } from "../realtime/realtime.service.js";

// ─── Channels ──────────────────────────────────────────

export async function listChannelsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const channels = await chatService.listChannels(
    request.server.prisma,
    wid,
    request.user!.id,
  );
  return reply.send({ data: channels });
}

export async function getChannelHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { channelId } = request.params as { channelId: string };
  const channel = await chatService.getChannel(
    request.server.prisma,
    channelId,
    request.user!.id,
  );
  return reply.send({ data: channel });
}

export async function createChannelHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const body = request.body as CreateChannelInput;

  const channel = await chatService.createChannel(
    request.server.prisma,
    wid,
    request.user!.id,
    body,
  );

  if (channel.type === "PUBLIC") {
    broadcastToWorkspace(wid, "chat_channel_created", { channel }, request.user!.id);
  } else {
    broadcastToChannel(channel.id, "chat_channel_created", { channel }, request.user!.id);
  }

  return reply.status(201).send({ data: channel });
}

export async function updateChannelHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { channelId } = request.params as { channelId: string };
  const body = request.body as UpdateChannelInput;

  const channel = await chatService.updateChannel(
    request.server.prisma,
    channelId,
    request.user!.id,
    request.workspaceMember!.role,
    body,
  );

  broadcastToChannel(channelId, "chat_channel_updated", { channel });

  return reply.send({ data: channel });
}

export async function deleteChannelHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid, channelId } = request.params as { wid: string; channelId: string };

  const channel = await chatService.deleteChannel(
    request.server.prisma,
    channelId,
    request.user!.id,
    request.workspaceMember!.role,
  );

  if (channel.type === "PUBLIC") {
    broadcastToWorkspace(wid, "chat_channel_deleted", { channelId }, request.user!.id);
  } else {
    broadcastToChannel(channelId, "chat_channel_deleted", { channelId }, request.user!.id);
  }

  return reply.status(204).send();
}

export async function joinChannelHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { channelId } = request.params as { channelId: string };

  await chatService.joinChannel(
    request.server.prisma,
    channelId,
    request.user!.id,
  );

  broadcastToChannel(channelId, "chat_member_added", {
    channelId,
    userId: request.user!.id,
  });

  return reply.status(204).send();
}

export async function leaveChannelHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { channelId } = request.params as { channelId: string };

  await chatService.leaveChannel(
    request.server.prisma,
    channelId,
    request.user!.id,
  );

  broadcastToChannel(channelId, "chat_member_removed", {
    channelId,
    userId: request.user!.id,
  });

  return reply.status(204).send();
}

// ─── Members ───────────────────────────────────────────

export async function listMembersHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { channelId } = request.params as { channelId: string };
  const members = await chatService.listMembers(
    request.server.prisma,
    channelId,
  );
  return reply.send({ data: members });
}

export async function addMembersHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { channelId } = request.params as { channelId: string };
  const body = request.body as AddMembersInput;

  await chatService.addMembers(
    request.server.prisma,
    channelId,
    request.user!.id,
    request.workspaceMember!.role,
    body.userIds,
  );

  for (const uid of body.userIds) {
    broadcastToChannel(channelId, "chat_member_added", {
      channelId,
      userId: uid,
    });
  }

  return reply.status(204).send();
}

export async function removeMemberHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { channelId, userId } = request.params as {
    channelId: string;
    userId: string;
  };

  await chatService.removeMembers(
    request.server.prisma,
    channelId,
    request.user!.id,
    request.workspaceMember!.role,
    userId,
  );

  broadcastToChannel(channelId, "chat_member_removed", {
    channelId,
    userId,
  });

  return reply.status(204).send();
}

// ─── Messages ──────────────────────────────────────────

export async function listMessagesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { channelId } = request.params as { channelId: string };
  const query = request.query as ChatMessageQueryInput;

  const result = await chatService.listMessages(
    request.server.prisma,
    channelId,
    query.cursor,
    query.limit,
  );
  return reply.send(result);
}

export async function sendMessageHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid, channelId } = request.params as { wid: string; channelId: string };
  const body = request.body as SendMessageInput;
  const userId = request.user!.id;
  const displayName = request.user!.displayName;

  const message = await chatService.sendMessage(
    request.server.prisma,
    channelId,
    userId,
    body.content,
    body.parentId,
  );

  broadcastToChannel(channelId, "chat_message_created", {
    message,
    channelId,
  });

  // Notification payloads include private message snippets. A mentioned global
  // user ID or stale membership must never become an alternate content reader.
  const currentMembers = await request.server.prisma.chatChannelMember.findMany({
    where: {
      channelId,
      user: { workspaces: { some: { workspaceId: wid } } },
    },
    select: { userId: true },
  });
  const recipientIds = new Set(currentMembers.map((member) => member.userId));

  // Mention notifications
  const mentionedIds = chatService.parseMentions(body.content);
  if (mentionedIds.length > 0) {
    const mentionNotifs = mentionedIds
      .filter((id) => id !== userId && recipientIds.has(id))
      .map((mentionedUserId) => ({
        userId: mentionedUserId,
        type: "CHAT_MENTION" as const,
        title: `${displayName} mentioned you in chat`,
        body: body.content.slice(0, 200),
        data: { channelId, messageId: message.id },
      }));
    const created = await createNotifications(request.server.prisma, mentionNotifs);
    for (const notif of created) {
      broadcastToUser(notif.userId, "notification_created", notif);
    }
  }

  // DM notifications
  const channel = await request.server.prisma.chatChannel.findUnique({
    where: { id: channelId },
    select: { type: true, members: { select: { userId: true } } },
  });
  if (channel?.type === "DM") {
    const dmNotifs = channel.members
      .filter((m) => m.userId !== userId && recipientIds.has(m.userId))
      .map((m) => ({
        userId: m.userId,
        type: "CHAT_DM_MESSAGE" as const,
        title: `${displayName} sent you a message`,
        body: body.content.slice(0, 200),
        data: { channelId, messageId: message.id },
      }));
    const created = await createNotifications(request.server.prisma, dmNotifs);
    for (const notif of created) {
      broadcastToUser(notif.userId, "notification_created", notif);
    }
  }

  // Thread subscription notifications
  if (body.parentId) {
    const subscribers = await chatService.getThreadSubscribers(
      request.server.prisma,
      body.parentId,
    );
    for (const subUserId of subscribers) {
      if (subUserId !== userId && recipientIds.has(subUserId)) {
        broadcastToUser(subUserId, "chat_thread_reply", {
          channelId,
          messageId: message.id,
          parentId: body.parentId,
        });
      }
    }
  }

  return reply.status(201).send({ data: message });
}

export async function updateMessageHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { messageId } = request.params as { messageId: string };
  const body = request.body as UpdateMessageInput;

  const message = await chatService.updateMessage(
    request.server.prisma,
    messageId,
    request.user!.id,
    body.content,
  );

  broadcastToChannel(message.channelId, "chat_message_updated", {
    message,
    channelId: message.channelId,
  });

  return reply.send({ data: message });
}

export async function deleteMessageHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { messageId } = request.params as { messageId: string };

  const { channelId } = await chatService.deleteMessage(
    request.server.prisma,
    messageId,
    request.user!.id,
    request.workspaceMember!.role,
  );

  broadcastToChannel(channelId, "chat_message_deleted", {
    messageId,
    channelId,
  });

  return reply.status(204).send();
}

export async function getThreadRepliesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { messageId } = request.params as { messageId: string };
  const query = request.query as ChatMessageQueryInput;

  const result = await chatService.getThreadReplies(
    request.server.prisma,
    messageId,
    query.cursor,
    query.limit,
  );
  return reply.send(result);
}

// ─── Unread ────────────────────────────────────────────

export async function markReadHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { channelId } = request.params as { channelId: string };

  await chatService.markRead(
    request.server.prisma,
    channelId,
    request.user!.id,
  );
  return reply.status(204).send();
}

export async function getUnreadCountsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };

  const counts = await chatService.getUnreadCounts(
    request.server.prisma,
    wid,
    request.user!.id,
  );
  return reply.send({ data: counts });
}

// ─── DMs ───────────────────────────────────────────────

export async function findOrCreateDmHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const body = request.body as CreateDmInput;

  const channel = await chatService.findOrCreateDm(
    request.server.prisma,
    wid,
    request.user!.id,
    body.userIds,
  );

  return reply.status(201).send({ data: channel });
}

// ─── Typing ────────────────────────────────────────────

export async function typingHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { channelId } = request.params as { channelId: string };

  broadcastToChannel(channelId, "chat_typing", {
    channelId,
    userId: request.user!.id,
    displayName: request.user!.displayName,
  }, request.user!.id);

  return reply.status(204).send();
}

// ─── Reactions ──────────────────────────────────────────

export async function toggleReactionHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { messageId } = request.params as { messageId: string };
  const body = request.body as ToggleReactionInput;

  const result = await chatService.toggleReaction(
    request.server.prisma,
    messageId,
    request.user!.id,
    body.emoji,
  );

  broadcastToChannel(result.channelId, "chat_reaction_updated", {
    messageId,
    channelId: result.channelId,
    userId: request.user!.id,
    emoji: body.emoji,
    action: result.action,
  });

  return reply.send({ data: { action: result.action } });
}

// ─── Pins ─────────────────────────────────────────────

export async function togglePinHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { messageId } = request.params as { messageId: string };
  const body = request.body as PinMessageInput;

  const result = await chatService.togglePin(
    request.server.prisma,
    messageId,
    request.user!.id,
    request.workspaceMember!.role,
    body.pinned,
  );

  const event = body.pinned ? "chat_message_pinned" : "chat_message_unpinned";
  broadcastToChannel(result.channelId, event, {
    message: result.message,
    channelId: result.channelId,
  });

  return reply.send({ data: result.message });
}

export async function listPinnedHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { channelId } = request.params as { channelId: string };

  const messages = await chatService.listPinnedMessages(
    request.server.prisma,
    channelId,
  );
  return reply.send({ data: messages });
}

// ─── Bookmarks ────────────────────────────────────────

export async function toggleBookmarkHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { messageId } = request.params as { messageId: string };

  const result = await chatService.toggleBookmark(
    request.server.prisma,
    messageId,
    request.user!.id,
  );

  return reply.send({ data: result });
}

export async function listBookmarksHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const query = request.query as { cursor?: string; limit?: number };

  const result = await chatService.listBookmarks(
    request.server.prisma,
    request.user!.id,
    wid,
    query.cursor,
    query.limit,
  );
  return reply.send(result);
}

// ─── Thread Subscriptions ─────────────────────────────

export async function getThreadSubscriptionHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { messageId } = request.params as { messageId: string };

  const result = await chatService.getThreadSubscription(
    request.server.prisma,
    messageId,
    request.user!.id,
  );
  return reply.send({ data: result });
}

export async function subscribeThreadHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { messageId } = request.params as { messageId: string };

  await chatService.subscribeThread(
    request.server.prisma,
    messageId,
    request.user!.id,
  );
  return reply.status(204).send();
}

export async function unsubscribeThreadHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { messageId } = request.params as { messageId: string };

  await chatService.unsubscribeThread(
    request.server.prisma,
    messageId,
    request.user!.id,
  );
  return reply.status(204).send();
}

// ─── Channel Archiving ────────────────────────────────

export async function archiveChannelHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid, channelId } = request.params as { wid: string; channelId: string };
  const body = request.body as ArchiveChannelInput;

  const channel = await chatService.archiveChannel(
    request.server.prisma,
    channelId,
    request.user!.id,
    request.workspaceMember!.role,
    body.archived,
  );

  const event = body.archived ? "chat_channel_archived" : "chat_channel_unarchived";
  if (channel.type === "PUBLIC") {
    broadcastToWorkspace(wid, event, { channel, channelId });
  } else {
    broadcastToChannel(channelId, event, { channel, channelId });
  }

  return reply.send({ data: channel });
}

// ─── Search ───────────────────────────────────────────

export async function searchMessagesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const { channelId } = request.params as { channelId?: string };
  const query = request.query as SearchMessagesInput;

  const result = await chatService.searchMessages(
    request.server.prisma,
    wid,
    request.user!.id,
    query.q,
    channelId,
    query.cursor,
    query.limit,
  );
  return reply.send(result);
}

export async function searchChannelMessagesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid, channelId } = request.params as { wid: string; channelId: string };
  const query = request.query as SearchMessagesInput;

  const result = await chatService.searchMessages(
    request.server.prisma,
    wid,
    request.user!.id,
    query.q,
    channelId,
    query.cursor,
    query.limit,
  );
  return reply.send(result);
}

// ─── Presence ─────────────────────────────────────────

export async function getPresenceHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const { getOnlineUsers } = await import("../realtime/realtime.service.js");
  const users = getOnlineUsers(wid);
  return reply.send({ data: users });
}
