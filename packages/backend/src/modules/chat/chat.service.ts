import type { PrismaClient, Prisma } from "@prisma/client";
import { ForbiddenError, NotFoundError } from "../../utils/errors.js";
import { assertChannelAccess, assertWorkspaceRecipients } from "./chat-access.js";

// ─── Channels ──────────────────────────────────────────

export async function listChannels(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
) {
  // Public channels + private/DM channels user is a member of
  const channels = await prisma.chatChannel.findMany({
    where: {
      workspaceId,
      OR: [
        { type: "PUBLIC" },
        { members: { some: { userId } } },
      ],
    },
    include: {
      _count: { select: { members: true } },
      members: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return channels;
}

export async function getChannel(
  prisma: PrismaClient,
  channelId: string,
  userId: string,
) {
  const channel = await prisma.chatChannel.findUnique({
    where: { id: channelId },
    include: {
      _count: { select: { members: true } },
      members: {
        where: { userId },
        select: { id: true },
      },
    },
  });
  if (!channel) throw new NotFoundError("Channel not found");

  const isMember = channel.members.length > 0;

  // Private/DM channels require membership
  if (channel.type !== "PUBLIC" && !isMember) {
    throw new ForbiddenError("Not a member of this channel");
  }

  const { members: _, ...rest } = channel;
  return { ...rest, isMember };
}

export async function createChannel(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  data: { name: string; description?: string; type: "PUBLIC" | "PRIVATE" },
) {
  const channel = await prisma.chatChannel.create({
    data: {
      workspaceId,
      name: data.name,
      description: data.description,
      type: data.type,
      createdById: userId,
      members: {
        create: { userId },
      },
    },
    include: {
      _count: { select: { members: true } },
    },
  });
  return channel;
}

export async function updateChannel(
  prisma: PrismaClient,
  channelId: string,
  userId: string,
  role: string,
  data: { name?: string; description?: string },
) {
  const channel = await prisma.chatChannel.findUnique({
    where: { id: channelId },
    select: { createdById: true, type: true },
  });
  if (!channel) throw new NotFoundError("Channel not found");
  if (channel.type === "DM") throw new ForbiddenError("Cannot update DM channels");
  if (channel.createdById !== userId && role !== "ADMIN") {
    throw new ForbiddenError("Only the channel creator or admin can update");
  }

  return prisma.chatChannel.update({
    where: { id: channelId },
    data,
    include: { _count: { select: { members: true } } },
  });
}

export async function deleteChannel(
  prisma: PrismaClient,
  channelId: string,
  userId: string,
  role: string,
) {
  const channel = await prisma.chatChannel.findUnique({
    where: { id: channelId },
    select: { createdById: true, type: true },
  });
  if (!channel) throw new NotFoundError("Channel not found");
  if (channel.type === "DM") throw new ForbiddenError("Cannot delete DM channels");
  if (channel.createdById !== userId && role !== "ADMIN") {
    throw new ForbiddenError("Only the channel creator or admin can delete");
  }

  await prisma.chatChannel.delete({ where: { id: channelId } });
  return channel;
}

export async function joinChannel(
  prisma: PrismaClient,
  channelId: string,
  userId: string,
) {
  const channel = await prisma.chatChannel.findUnique({
    where: { id: channelId },
    select: { type: true },
  });
  if (!channel) throw new NotFoundError("Channel not found");
  if (channel.type !== "PUBLIC") {
    throw new ForbiddenError("Can only join public channels");
  }

  await prisma.chatChannelMember.upsert({
    where: { channelId_userId: { channelId, userId } },
    update: {},
    create: { channelId, userId },
  });
}

export async function leaveChannel(
  prisma: PrismaClient,
  channelId: string,
  userId: string,
) {
  const channel = await prisma.chatChannel.findUnique({
    where: { id: channelId },
    select: { type: true },
  });
  if (!channel) throw new NotFoundError("Channel not found");
  if (channel.type === "DM") {
    throw new ForbiddenError("Cannot leave DM channels");
  }

  await prisma.chatChannelMember.deleteMany({
    where: { channelId, userId },
  });
}

// ─── DMs ───────────────────────────────────────────────

export async function findOrCreateDm(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  targetUserIds: string[],
) {
  const allUserIds = [...new Set([userId, ...targetUserIds])].sort();
  await assertWorkspaceRecipients(prisma, workspaceId, allUserIds);

  // Find existing DM with exact same member set
  const existingChannels = await prisma.chatChannel.findMany({
    where: {
      workspaceId,
      type: "DM",
      members: { some: { userId } },
    },
    include: {
      members: { select: { userId: true } },
      _count: { select: { members: true } },
    },
  });

  for (const ch of existingChannels) {
    const memberIds = ch.members.map((m) => m.userId).sort();
    if (
      memberIds.length === allUserIds.length &&
      memberIds.every((id, i) => id === allUserIds[i])
    ) {
      const { members: _, ...rest } = ch;
      return rest;
    }
  }

  // Create new DM
  const channel = await prisma.chatChannel.create({
    data: {
      workspaceId,
      type: "DM",
      createdById: userId,
      members: {
        create: allUserIds.map((uid) => ({ userId: uid })),
      },
    },
    include: {
      _count: { select: { members: true } },
    },
  });
  return channel;
}

export async function listDms(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
) {
  return prisma.chatChannel.findMany({
    where: {
      workspaceId,
      type: "DM",
      members: { some: { userId } },
    },
    include: {
      members: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true },
          },
        },
      },
      _count: { select: { members: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
}

// ─── Messages ──────────────────────────────────────────

export async function listMessages(
  prisma: PrismaClient,
  channelId: string,
  cursor?: string,
  limit = 50,
) {
  const messages = await prisma.chatMessage.findMany({
    where: {
      channelId,
      parentId: null, // Only top-level messages
    },
    include: {
      user: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
      _count: { select: { replies: true } },
      reactions: {
        select: { id: true, emoji: true, userId: true },
        orderBy: { createdAt: "asc" as const },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = messages.length > limit;
  if (hasMore) messages.pop();

  return {
    data: messages,
    nextCursor: hasMore ? messages[messages.length - 1]?.id : undefined,
  };
}

export async function sendMessage(
  prisma: PrismaClient,
  channelId: string,
  userId: string,
  content: string,
  parentId?: string,
) {
  // Verify membership
  const membership = await prisma.chatChannelMember.findUnique({
    where: { channelId_userId: { channelId, userId } },
  });
  if (!membership) throw new ForbiddenError("Not a member of this channel");

  // Check if channel is archived
  const channel = await prisma.chatChannel.findUnique({
    where: { id: channelId },
    select: { archivedAt: true },
  });
  if (channel?.archivedAt) throw new ForbiddenError("Cannot send messages to an archived channel");

  // If replying, verify parent exists in same channel
  if (parentId) {
    const parent = await prisma.chatMessage.findUnique({
      where: { id: parentId },
      select: { channelId: true },
    });
    if (!parent || parent.channelId !== channelId) {
      throw new NotFoundError("Parent message not found in this channel");
    }
  }

  const message = await prisma.chatMessage.create({
    data: {
      channelId,
      userId,
      content,
      parentId,
    },
    include: {
      user: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
      _count: { select: { replies: true } },
      reactions: {
        select: { id: true, emoji: true, userId: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  // Touch channel updatedAt for sorting
  await prisma.chatChannel.update({
    where: { id: channelId },
    data: { updatedAt: new Date() },
  });

  // Auto-subscribe to thread if replying
  if (parentId) {
    await prisma.chatThreadSubscription.upsert({
      where: { messageId_userId: { messageId: parentId, userId } },
      update: {},
      create: { messageId: parentId, userId },
    });
  }

  return message;
}

export async function updateMessage(
  prisma: PrismaClient,
  messageId: string,
  userId: string,
  content: string,
) {
  const message = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { userId: true, deletedAt: true },
  });
  if (!message) throw new NotFoundError("Message not found");
  if (message.deletedAt) throw new NotFoundError("Message has been deleted");
  if (message.userId !== userId) {
    throw new ForbiddenError("Can only edit your own messages");
  }

  return prisma.chatMessage.update({
    where: { id: messageId },
    data: { content, editedAt: new Date() },
    include: {
      user: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
      _count: { select: { replies: true } },
      reactions: {
        select: { id: true, emoji: true, userId: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
}

export async function deleteMessage(
  prisma: PrismaClient,
  messageId: string,
  userId: string,
  role: string,
) {
  const message = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { userId: true, deletedAt: true, channelId: true },
  });
  if (!message) throw new NotFoundError("Message not found");
  if (message.deletedAt) throw new NotFoundError("Message already deleted");
  if (message.userId !== userId && role !== "ADMIN") {
    throw new ForbiddenError("Can only delete your own messages");
  }

  await prisma.chatMessage.update({
    where: { id: messageId },
    data: { deletedAt: new Date() },
  });

  return { channelId: message.channelId };
}

export async function getThreadReplies(
  prisma: PrismaClient,
  parentId: string,
  cursor?: string,
  limit = 50,
) {
  const messages = await prisma.chatMessage.findMany({
    where: { parentId },
    include: {
      user: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
      reactions: {
        select: { id: true, emoji: true, userId: true },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = messages.length > limit;
  if (hasMore) messages.pop();

  return {
    data: messages,
    nextCursor: hasMore ? messages[messages.length - 1]?.id : undefined,
  };
}

// ─── Unread ────────────────────────────────────────────

export async function markRead(
  prisma: PrismaClient,
  channelId: string,
  userId: string,
) {
  await prisma.chatChannelMember.updateMany({
    where: { channelId, userId },
    data: { lastReadAt: new Date() },
  });
}

export async function getUnreadCounts(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
) {
  const memberships = await prisma.chatChannelMember.findMany({
    where: {
      userId,
      channel: { workspaceId },
    },
    select: {
      channelId: true,
      lastReadAt: true,
    },
  });

  if (memberships.length === 0) return [];

  const counts = await Promise.all(
    memberships.map(async (m) => {
      const count = await prisma.chatMessage.count({
        where: {
          channelId: m.channelId,
          createdAt: { gt: m.lastReadAt },
          deletedAt: null,
          userId: { not: userId },
        },
      });
      return { channelId: m.channelId, count };
    }),
  );

  return counts.filter((c) => c.count > 0);
}

// ─── Members ───────────────────────────────────────────

export async function addMembers(
  prisma: PrismaClient,
  channelId: string,
  userId: string,
  role: string,
  memberIds: string[],
) {
  const channel = await prisma.chatChannel.findUnique({
    where: { id: channelId },
    select: { createdById: true, type: true, workspaceId: true },
  });
  if (!channel) throw new NotFoundError("Channel not found");
  if (channel.type === "DM") throw new ForbiddenError("Cannot add members to DM channels");
  if (channel.type === "PRIVATE" && channel.createdById !== userId && role !== "ADMIN") {
    throw new ForbiddenError("Only the channel creator or admin can add members");
  }

  await assertWorkspaceRecipients(prisma, channel.workspaceId, memberIds);

  await prisma.chatChannelMember.createMany({
    data: memberIds.map((uid) => ({ channelId, userId: uid })),
    skipDuplicates: true,
  });
}

export async function removeMembers(
  prisma: PrismaClient,
  channelId: string,
  userId: string,
  role: string,
  targetUserId: string,
) {
  const channel = await prisma.chatChannel.findUnique({
    where: { id: channelId },
    select: { createdById: true, type: true },
  });
  if (!channel) throw new NotFoundError("Channel not found");
  if (channel.type === "DM") throw new ForbiddenError("Cannot remove members from DM channels");
  if (channel.createdById !== userId && role !== "ADMIN" && targetUserId !== userId) {
    throw new ForbiddenError("Only the channel creator or admin can remove members");
  }

  await prisma.chatChannelMember.deleteMany({
    where: { channelId, userId: targetUserId },
  });
}

export async function listMembers(
  prisma: PrismaClient,
  channelId: string,
) {
  return prisma.chatChannelMember.findMany({
    where: { channelId },
    include: {
      user: {
        select: { id: true, displayName: true, avatarUrl: true, email: true },
      },
    },
    orderBy: { joinedAt: "asc" },
  });
}

// ─── Reactions ────────────────────────────────────────

export async function toggleReaction(
  prisma: PrismaClient,
  messageId: string,
  userId: string,
  emoji: string,
) {
  const message = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { channelId: true, deletedAt: true },
  });
  if (!message) throw new NotFoundError("Message not found");
  if (message.deletedAt) throw new NotFoundError("Message has been deleted");

  const existing = await prisma.chatReaction.findUnique({
    where: { messageId_userId_emoji: { messageId, userId, emoji } },
  });

  if (existing) {
    await prisma.chatReaction.delete({ where: { id: existing.id } });
    return { action: "removed" as const, channelId: message.channelId };
  }

  await prisma.chatReaction.create({
    data: { messageId, userId, emoji },
  });
  return { action: "added" as const, channelId: message.channelId };
}

// ─── Mentions ─────────────────────────────────────────

export function parseMentions(content: string): string[] {
  const regex = /@\[([^\]]+)\]/g;
  const ids = new Set<string>();
  let match;
  while ((match = regex.exec(content)) !== null) {
    ids.add(match[1]);
  }
  return Array.from(ids);
}

// ─── Pins ─────────────────────────────────────────────

export async function togglePin(
  prisma: PrismaClient,
  messageId: string,
  userId: string,
  role: string,
  pinned: boolean,
) {
  const message = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { channelId: true, deletedAt: true, pinnedAt: true },
  });
  if (!message) throw new NotFoundError("Message not found");
  if (message.deletedAt) throw new NotFoundError("Message has been deleted");

  const updated = await prisma.chatMessage.update({
    where: { id: messageId },
    data: pinned
      ? { pinnedAt: new Date(), pinnedById: userId }
      : { pinnedAt: null, pinnedById: null },
    include: {
      user: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
      _count: { select: { replies: true } },
      reactions: {
        select: { id: true, emoji: true, userId: true },
        orderBy: { createdAt: "asc" as const },
      },
    },
  });

  return { message: updated, channelId: message.channelId };
}

export async function listPinnedMessages(
  prisma: PrismaClient,
  channelId: string,
) {
  return prisma.chatMessage.findMany({
    where: { channelId, pinnedAt: { not: null }, deletedAt: null },
    include: {
      user: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
      _count: { select: { replies: true } },
      reactions: {
        select: { id: true, emoji: true, userId: true },
        orderBy: { createdAt: "asc" as const },
      },
    },
    orderBy: { pinnedAt: "desc" },
  });
}

// ─── Bookmarks ────────────────────────────────────────

export async function toggleBookmark(
  prisma: PrismaClient,
  messageId: string,
  userId: string,
) {
  const message = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { id: true, deletedAt: true },
  });
  if (!message) throw new NotFoundError("Message not found");
  if (message.deletedAt) throw new NotFoundError("Message has been deleted");

  const existing = await prisma.chatBookmark.findUnique({
    where: { userId_messageId: { userId, messageId } },
  });

  if (existing) {
    await prisma.chatBookmark.delete({ where: { id: existing.id } });
    return { action: "removed" as const };
  }

  await prisma.chatBookmark.create({ data: { userId, messageId } });
  return { action: "added" as const };
}

export async function listBookmarks(
  prisma: PrismaClient,
  userId: string,
  workspaceId: string,
  cursor?: string,
  limit = 20,
) {
  const bookmarks = await prisma.chatBookmark.findMany({
    where: {
      userId,
      message: {
        channel: {
          workspaceId,
          OR: [{ type: "PUBLIC" }, { members: { some: { userId } } }],
        },
        deletedAt: null,
      },
    },
    include: {
      message: {
        include: {
          user: {
            select: { id: true, displayName: true, avatarUrl: true },
          },
          channel: {
            select: { id: true, name: true, type: true },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = bookmarks.length > limit;
  if (hasMore) bookmarks.pop();

  return {
    data: bookmarks,
    nextCursor: hasMore ? bookmarks[bookmarks.length - 1]?.id : undefined,
  };
}

// ─── Thread Subscriptions ─────────────────────────────

export async function getThreadSubscription(
  prisma: PrismaClient,
  messageId: string,
  userId: string,
) {
  const sub = await prisma.chatThreadSubscription.findUnique({
    where: { messageId_userId: { messageId, userId } },
  });
  return { subscribed: !!sub };
}

export async function subscribeThread(
  prisma: PrismaClient,
  messageId: string,
  userId: string,
) {
  await prisma.chatThreadSubscription.upsert({
    where: { messageId_userId: { messageId, userId } },
    update: {},
    create: { messageId, userId },
  });
}

export async function unsubscribeThread(
  prisma: PrismaClient,
  messageId: string,
  userId: string,
) {
  await prisma.chatThreadSubscription.deleteMany({
    where: { messageId, userId },
  });
}

export async function getThreadSubscribers(
  prisma: PrismaClient,
  messageId: string,
) {
  const subs = await prisma.chatThreadSubscription.findMany({
    where: { messageId },
    select: { userId: true },
  });
  return subs.map((s) => s.userId);
}

// ─── Channel Archiving ────────────────────────────────

export async function archiveChannel(
  prisma: PrismaClient,
  channelId: string,
  userId: string,
  role: string,
  archived: boolean,
) {
  const channel = await prisma.chatChannel.findUnique({
    where: { id: channelId },
    select: { createdById: true, type: true },
  });
  if (!channel) throw new NotFoundError("Channel not found");
  if (channel.type === "DM") throw new ForbiddenError("Cannot archive DM channels");
  if (channel.createdById !== userId && role !== "ADMIN") {
    throw new ForbiddenError("Only the channel creator or admin can archive");
  }

  return prisma.chatChannel.update({
    where: { id: channelId },
    data: archived
      ? { archivedAt: new Date(), archivedById: userId }
      : { archivedAt: null, archivedById: null },
    include: { _count: { select: { members: true } } },
  });
}

// ─── Search ───────────────────────────────────────────

export async function searchMessages(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  query: string,
  channelId?: string,
  cursor?: string,
  limit = 20,
) {
  const where: Prisma.ChatMessageWhereInput = {
    deletedAt: null,
    content: { contains: query, mode: "insensitive" },
  };

  if (channelId) {
    await assertChannelAccess(prisma, { workspaceId, userId }, channelId);
    where.channelId = channelId;
    where.channel = { workspaceId };
  } else {
    // Search across all channels user is a member of
    where.channel = {
      workspaceId,
      members: { some: { userId } },
    };
  }

  const messages = await prisma.chatMessage.findMany({
    where,
    include: {
      user: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
      channel: {
        select: { id: true, name: true, type: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = messages.length > limit;
  if (hasMore) messages.pop();

  return {
    data: messages,
    nextCursor: hasMore ? messages[messages.length - 1]?.id : undefined,
  };
}
