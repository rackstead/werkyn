import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { CHANNEL_LIST_MEMBER_LIMIT, CHANNEL_MEMBER_PAGE_DEFAULT } from "@pm/shared";
import { ConflictError, ForbiddenError, NotFoundError } from "../../utils/errors.js";
import { assertChannelAccess, assertWorkspaceRecipients } from "./chat-access.js";
import { revokeChannelAccess } from "../realtime/realtime.service.js";
import { isLockTimeoutError, isStatementCanceledError } from "../../utils/retryable-database-errors.js";
import { withSearchPlans } from "../../utils/text-search.js";

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
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const members = await memberPreviews(prisma, channels.map((c) => c.id));
  return channels.map((channel) => ({
    ...channel,
    members: members.get(channel.id) ?? [],
  }));
}

/**
 * The first CHANNEL_LIST_MEMBER_LIMIT members (by join time, then ID) of each
 * channel. `_count.members` stays the full count; a DM has at most eight
 * members, so its preview is complete.
 *
 * The recursive query takes one member per channel and step from the
 * ("channelId", "joinedAt", "id") index, so it reads at most the limit per
 * channel. A plain LATERAL ... LIMIT is not enough: PostgreSQL estimates every
 * channel at the average membership and, next to many small channels, reads
 * and sorts all members of a large one.
 */
async function memberPreviews(prisma: PrismaClient, channelIds: string[]) {
  const byChannel = new Map<string, MemberPreview[]>();
  if (channelIds.length === 0) return byChannel;
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      channelId: string;
      userId: string;
      lastReadAt: Date;
      joinedAt: Date;
      displayName: string;
      avatarUrl: string | null;
    }>
  >`
    WITH RECURSIVE preview AS (
      SELECT m.*, 1 AS step
      FROM unnest(${channelIds}::text[]) AS c("id")
      CROSS JOIN LATERAL (
        SELECT cm."id", cm."channelId", cm."userId", cm."lastReadAt", cm."joinedAt"
        FROM "ChatChannelMember" cm
        WHERE cm."channelId" = c."id"
        ORDER BY cm."joinedAt", cm."id"
        LIMIT 1
      ) m
      UNION ALL
      SELECT m.*, p.step + 1
      FROM preview p
      CROSS JOIN LATERAL (
        SELECT cm."id", cm."channelId", cm."userId", cm."lastReadAt", cm."joinedAt"
        FROM "ChatChannelMember" cm
        WHERE cm."channelId" = p."channelId"
          AND (cm."joinedAt", cm."id") > (p."joinedAt", p."id")
        ORDER BY cm."joinedAt", cm."id"
        LIMIT 1
      ) m
      WHERE p.step < ${CHANNEL_LIST_MEMBER_LIMIT}
    )
    SELECT p."id", p."channelId", p."userId", p."lastReadAt", p."joinedAt",
           u."displayName", u."avatarUrl"
    FROM preview p
    JOIN "User" u ON u."id" = p."userId"
    ORDER BY p."channelId", p."joinedAt", p."id"`;
  for (const { displayName, avatarUrl, ...member } of rows) {
    const list = byChannel.get(member.channelId) ?? [];
    list.push({ ...member, user: { id: member.userId, displayName, avatarUrl } });
    byChannel.set(member.channelId, list);
  }
  return byChannel;
}

interface MemberPreview {
  id: string;
  channelId: string;
  userId: string;
  lastReadAt: Date;
  joinedAt: Date;
  user: { id: string; displayName: string; avatarUrl: string | null };
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
  revokeChannelAccess(userId, channelId);
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
  if (cursor) {
    const scopedCursor = await prisma.chatMessage.findFirst({
      where: { id: cursor, channelId, parentId: null },
      select: { id: true },
    });
    if (!scopedCursor) return { data: [], nextCursor: undefined };
  }

  const messages = await prisma.chatMessage.findMany({
    where: {
      channelId,
      parentId: null, // Only top-level messages
    },
    omit: chatMessageOmit,
    include: {
      user: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
      reactions: {
        select: { id: true, emoji: true, userId: true },
        orderBy: { createdAt: "asc" as const },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = messages.length > limit;
  if (hasMore) messages.pop();

  return {
    data: await withReplyCounts(prisma, messages),
    nextCursor: hasMore ? messages[messages.length - 1]?.id : undefined,
  };
}

/**
 * Adds `_count.replies` (every reply, as the `_count` include counts) to a
 * list of messages. Counted here for the listed messages only: for a list,
 * Prisma's `_count` include joins a count of every thread in the table.
 */
async function withReplyCounts<T extends { id: string }>(
  prisma: PrismaClient,
  messages: T[],
) {
  if (messages.length === 0) return [];
  const counts = await prisma.$queryRaw<{ parentId: string; replies: number }[]>`
    SELECT "parentId", count(*)::int AS "replies" FROM "ChatMessage"
    WHERE "parentId" = ANY(${messages.map((m) => m.id)})
    GROUP BY "parentId"`;
  const byParent = new Map(counts.map((c) => [c.parentId, c.replies]));
  return messages.map((m) => ({
    ...m,
    _count: { replies: byParent.get(m.id) ?? 0 },
  }));
}

// Idempotency bookkeeping stays server-side: the sender's key and the
// fingerprint of the original request (a hash of the pre-edit text) are never
// returned or broadcast to readers.
export const chatMessageOmit = {
  clientMessageId: true,
  clientMessageHash: true,
} as const satisfies Prisma.ChatMessageOmit;

export const chatMessageInclude = {
  user: {
    select: { id: true, displayName: true, avatarUrl: true },
  },
  _count: { select: { replies: true } },
  reactions: {
    select: { id: true, emoji: true, userId: true },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.ChatMessageInclude;

// A key the sender reuses for a retry of the same logical send.
export const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

// Keep the parent rows before memberships: channel/workspace deletion starts
// at those parents and then cascades. Workspace KEY SHARE remains compatible
// with membership writers' existing workspace NO KEY UPDATE mutex.
async function lockSendAdmission(
  tx: Prisma.TransactionClient,
  channelId: string,
  userId: string,
) {
  const admissionStarted = performance.now();
  try {
    const settings = await tx.$queryRaw<{ name: string; timeoutMs: number }[]>`
      SELECT name, setting::integer AS "timeoutMs" FROM pg_settings
      WHERE name IN ('statement_timeout', 'lock_timeout')
    `;
    const previousStatement = settings.find((setting) => setting.name === "statement_timeout")!.timeoutMs;
    const previousLock = settings.find((setting) => setting.name === "lock_timeout")!.timeoutMs;
    const deadline = admissionStarted + Math.min(previousStatement || 5_000, 5_000);
    const boundNextLock = async () => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new ConflictError("The request conflicted with a concurrent change; try again");
      await tx.$executeRaw`
        SELECT set_config('statement_timeout', ${`${remaining}ms`}, true),
               set_config('lock_timeout', ${`${Math.min(previousLock || remaining, remaining)}ms`}, true)
      `;
    };
    await boundNextLock();
    const workspaces = await tx.$queryRaw<{ id: string }[]>`
      SELECT w.id FROM "Workspace" w
      JOIN "ChatChannel" c ON c."workspaceId" = w.id
      WHERE c.id = ${channelId} FOR KEY SHARE OF w
    `;
    if (!workspaces[0]) throw new ForbiddenError("Not a member of this channel");
    await boundNextLock();
    const channels = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "ChatChannel"
      WHERE id = ${channelId} AND "workspaceId" = ${workspaces[0].id}
      FOR NO KEY UPDATE
    `;
    if (!channels[0]) throw new ForbiddenError("Not a member of this channel");
    await boundNextLock();
    const members = await tx.$queryRaw<{ role: string }[]>`
      SELECT role::text AS role FROM "WorkspaceMember"
      WHERE "workspaceId" = ${workspaces[0].id} AND "userId" = ${userId}
      FOR SHARE
    `;
    if (!members[0]) throw new ForbiddenError("Not a member of this channel");
    if (members[0].role !== "ADMIN" && members[0].role !== "MEMBER") {
      throw new ForbiddenError("Insufficient permissions");
    }
    await boundNextLock();
    const channelMembers = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "ChatChannelMember"
      WHERE "channelId" = ${channelId} AND "userId" = ${userId}
      FOR KEY SHARE
    `;
    if (!channelMembers[0]) throw new ForbiddenError("Not a member of this channel");
    // Do not change later statement behavior or leak settings into the pool.
    // On failure PostgreSQL rolls these LOCAL settings back with the transaction.
    await tx.$executeRaw`
      SELECT set_config('statement_timeout', ${`${previousStatement}ms`}, true),
             set_config('lock_timeout', ${`${previousLock}ms`}, true)
    `;
  } catch (error) {
    if (isLockTimeoutError(error) || isStatementCanceledError(error)) {
      throw new ConflictError("The request conflicted with a concurrent change; try again");
    }
    throw error;
  }
}

function clientMessageHash(channelId: string, parentId: string | undefined, content: string) {
  return createHash("sha256")
    .update(JSON.stringify([channelId, parentId ?? null, content]))
    .digest("hex");
}

// Returns the message an earlier send with this key stored, after checking
// that the retry describes the same original request.
async function findKeyedMessage(
  prisma: Prisma.TransactionClient,
  userId: string,
  clientMessageId: string,
  requestHash: string,
) {
  const stored = await prisma.chatMessage.findUnique({
    where: { userId_clientMessageId: { userId, clientMessageId } },
    include: chatMessageInclude,
  });
  if (!stored) return null;
  const { clientMessageId: _key, clientMessageHash, ...message } = stored;
  if (clientMessageHash !== requestHash) {
    throw new ConflictError("This idempotency key was already used for a different message");
  }
  return message;
}

function isClientMessageIdConflict(err: unknown) {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
    return false;
  }
  return JSON.stringify(err.meta?.target ?? "").includes("clientMessageId");
}

/**
 * Stores a message together with every write the send requires: the channel
 * ordering touch, the author's thread subscription and the delivery outbox
 * row. Either all of them commit or none do. Notifications and realtime events
 * are delivered from the outbox afterwards (see chat-delivery.ts).
 *
 * With a clientMessageId, a retry of a send that already committed returns the
 * stored message with replayed=true instead of storing a duplicate.
 */
export async function sendMessage(
  prisma: PrismaClient,
  channelId: string,
  userId: string,
  content: string,
  parentId?: string,
  clientMessageId?: string,
) {
  const requestHash = clientMessageId
    ? clientMessageHash(channelId, parentId, content)
    : undefined;
  try {
    return await prisma.$transaction(async (tx) => {
      await lockSendAdmission(tx, channelId, userId);
      if (clientMessageId && requestHash) {
        const existing = await findKeyedMessage(tx, userId, clientMessageId, requestHash);
        if (existing) return { message: existing, replayed: true };
      }

      // Touch updatedAt for sorting. The archived guard and the row lock make
      // a concurrent archive either precede this send or wait for it.
      const touched = await tx.chatChannel.updateMany({
        where: { id: channelId, archivedAt: null },
        data: { updatedAt: new Date() },
      });
      if (touched.count === 0) {
        throw new ForbiddenError("Cannot send messages to an archived channel");
      }

      // If replying, verify parent exists in same channel
      if (parentId) {
        const parent = await tx.chatMessage.findUnique({
          where: { id: parentId },
          select: { channelId: true },
        });
        if (!parent || parent.channelId !== channelId) {
          throw new NotFoundError("Parent message not found in this channel");
        }
      }

      const created = await tx.chatMessage.create({
        data: {
          channelId,
          userId,
          content,
          parentId,
          clientMessageId,
          clientMessageHash: requestHash,
        },
        omit: chatMessageOmit,
        include: chatMessageInclude,
      });

      // Auto-subscribe to thread if replying
      if (parentId) {
        await tx.chatThreadSubscription.createMany({
          data: [{ messageId: parentId, userId }],
          skipDuplicates: true,
        });
      }

      await tx.chatMessageDelivery.create({
        data: {
          messageId: created.id,
          nextAttemptAt: new Date(),
          mentionedUserIds: parseMentions(content),
        },
      });

      return { message: created, replayed: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (err) {
    // A concurrent send with the same key committed first.
    if (clientMessageId && requestHash && isClientMessageIdConflict(err)) {
      // The failed transaction released its admission locks. Re-admit before
      // exposing the winner, since membership may have changed in between.
      return prisma.$transaction(async (tx) => {
        await lockSendAdmission(tx, channelId, userId);
        const existing = await findKeyedMessage(tx, userId, clientMessageId, requestHash);
        if (existing) return { message: existing, replayed: true };
        throw err;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    }
    throw err;
  }
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
    omit: chatMessageOmit,
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
  if (cursor) {
    const scopedCursor = await prisma.chatMessage.findFirst({
      where: { id: cursor, parentId },
      select: { id: true },
    });
    if (!scopedCursor) return { data: [], nextCursor: undefined };
  }

  const messages = await prisma.chatMessage.findMany({
    where: { parentId },
    omit: chatMessageOmit,
    include: {
      user: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
      reactions: {
        select: { id: true, emoji: true, userId: true },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
  revokeChannelAccess(targetUserId, channelId);
}

export async function listMembers(
  prisma: PrismaClient,
  channelId: string,
  cursor?: string,
  limit = CHANNEL_MEMBER_PAGE_DEFAULT,
) {
  // A cursor must be a member of this channel; any other ID gives an empty
  // page, like the other cursor lists.
  if (cursor) {
    const scopedCursor = await prisma.chatChannelMember.findFirst({
      where: { id: cursor, channelId },
      select: { id: true },
    });
    if (!scopedCursor) return { data: [], nextCursor: null };
  }

  const members = await prisma.chatChannelMember.findMany({
    where: { channelId },
    include: {
      user: {
        select: { id: true, displayName: true, avatarUrl: true, email: true },
      },
    },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = members.length > limit;
  if (hasMore) members.pop();
  return {
    data: members,
    nextCursor: hasMore ? members[members.length - 1].id : null,
  };
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
    omit: chatMessageOmit,
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
  const pinned = await prisma.chatMessage.findMany({
    where: { channelId, pinnedAt: { not: null }, deletedAt: null },
    omit: chatMessageOmit,
    include: {
      user: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
      reactions: {
        select: { id: true, emoji: true, userId: true },
        orderBy: { createdAt: "asc" as const },
      },
    },
    orderBy: { pinnedAt: "desc" },
  });
  return withReplyCounts(prisma, pinned);
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
  const where: Prisma.ChatBookmarkWhereInput = {
    userId,
    message: {
      channel: {
        workspaceId,
        OR: [{ type: "PUBLIC" }, { members: { some: { userId } } }],
      },
      deletedAt: null,
    },
  };
  // A cursor must be one of the listed bookmarks; any other ID gives an empty
  // page, as it did before the ID tie-breaker.
  if (cursor) {
    const scopedCursor = await prisma.chatBookmark.findFirst({
      where: { AND: [where, { id: cursor }] },
      select: { id: true },
    });
    if (!scopedCursor) return { data: [], nextCursor: undefined };
  }

  const bookmarks = await prisma.chatBookmark.findMany({
    where,
    include: {
      message: {
        omit: chatMessageOmit,
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
    // The unique ID breaks createdAt ties, so Prisma applies LIMIT to the page.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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

export const chatSearchPlan = {
  /**
   * A one-channel search in a channel with at most this many messages
   * (deleted ones included) reads the channel's messages, newest first, as
   * it did before the trigram index. The index's posting lists span every
   * channel of every workspace, so for a term made of common trigrams the
   * planner's index plan read far more than such a channel holds
   * (docs/remediation/p02c.md).
   */
  smallChannelMessages: 20_000,
};

/**
 * Turns bitmap and sequential scans off for the search transaction when the
 * channel is small, so the plan reads the channel through its
 * ("channelId", "createdAt") index instead of the trigram index. The count
 * reads at most smallChannelMessages + 1 index entries.
 */
function smallChannelPlan(prisma: PrismaClient, channelId: string) {
  const limit = chatSearchPlan.smallChannelMessages;
  return prisma.$queryRaw`
    SELECT set_config('enable_bitmapscan', CASE WHEN small THEN 'off' ELSE current_setting('enable_bitmapscan') END, true),
           set_config('enable_seqscan', CASE WHEN small THEN 'off' ELSE current_setting('enable_seqscan') END, true)
    FROM (SELECT count(*) <= ${limit} AS small FROM (
      SELECT 1 FROM "ChatMessage" WHERE "channelId" = ${channelId} LIMIT ${limit + 1}
    ) bounded) channel`;
}

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

  // Keep cursor eligibility in the same statement as the matching page.
  const cursorEligibility: Prisma.ChatMessageWhereInput | undefined = cursor
    ? {
        channel: {
          workspace: {
            chatChannels: {
              some: {
                messages: {
                  some: { AND: [where, { id: cursor }] },
                },
              },
            },
          },
        },
      }
    : undefined;

  const [messages] = await withSearchPlans(prisma, [
    prisma.chatMessage.findMany({
      where: cursorEligibility ? { AND: [where, cursorEligibility] } : where,
      omit: chatMessageOmit,
      include: {
        user: {
          select: { id: true, displayName: true, avatarUrl: true },
        },
        channel: {
          select: { id: true, name: true, type: true },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
  ], channelId ? [smallChannelPlan(prisma, channelId)] : []);

  const hasMore = messages.length > limit;
  if (hasMore) messages.pop();

  return {
    data: messages,
    nextCursor: hasMore ? messages[messages.length - 1]?.id : undefined,
  };
}
