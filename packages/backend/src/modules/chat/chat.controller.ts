import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  CreateChannelInput,
  UpdateChannelInput,
  SendMessageInput,
  UpdateMessageInput,
  CreateDmInput,
  AddMembersInput,
  ChatMessageQueryInput,
  ChatBookmarkQueryInput,
  ToggleReactionInput,
  PinMessageInput,
  ArchiveChannelInput,
  SearchMessagesInput,
} from "@pm/shared";
import * as chatService from "./chat.service.js";
import { deliverChatMessage } from "./chat-delivery.js";
import { broadcastToChannel, broadcastToWorkspace } from "../realtime/realtime.service.js";
import { ValidationError } from "../../utils/errors.js";

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

function readClientMessageId(request: FastifyRequest) {
  const header = request.headers["idempotency-key"];
  if (header === undefined) return undefined;
  if (typeof header !== "string" || !chatService.CLIENT_MESSAGE_ID_PATTERN.test(header)) {
    throw new ValidationError(
      "Idempotency-Key must be 1-128 letters, digits, '.', '_', ':' or '-'",
    );
  }
  return header;
}

export async function sendMessageHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { channelId } = request.params as { channelId: string };
  const body = request.body as SendMessageInput;

  const { message, replayed } = await chatService.sendMessage(
    request.server.prisma,
    channelId,
    request.user!.id,
    body.content,
    body.parentId,
    readClientMessageId(request),
  );

  // The message and its delivery outbox row are committed: the send has
  // succeeded. Notifications and realtime events are delivered from the
  // outbox; a failure there is recorded and retried in the background rather
  // than reported as a failed send. A replay retries a delivery that is due.
  await deliverChatMessage(request.server.prisma, message.id, { log: request.log });

  return reply.status(replayed ? 200 : 201).send({ data: message });
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
  const query = request.query as ChatBookmarkQueryInput;

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
