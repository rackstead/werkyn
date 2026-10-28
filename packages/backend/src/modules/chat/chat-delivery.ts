import type { NotificationType, Prisma, PrismaClient } from "@prisma/client";
import { broadcastToChannel, broadcastToUser } from "../realtime/realtime.service.js";
import {
  chatMessageInclude,
  chatMessageOmit,
  getThreadSubscribers,
  parseMentions,
} from "./chat.service.js";

// Delivers a sent chat message's side effects from its ChatMessageDelivery
// outbox row, which the send committed together with the message:
//
// - mention and DM notifications are created at most once: the row records
//   them in the same transaction that creates them;
// - realtime events (chat_message_created, notification_created,
//   chat_thread_reply) are repeated on every attempt until one succeeds. They
//   only make clients refetch, so a repeated event is harmless.
//
// The send request runs the first attempt right after its commit. A delivered
// message's row is deleted. Any failure leaves the row with a backoff, and
// processDueChatMessageDeliveries (scheduled in server.ts) retries it. A
// crashed attempt's lease expires and the row is picked up again.

const LEASE_MS = 60_000;
const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60 * 60_000;
export const MAX_DELIVERY_ATTEMPTS = 20;
const DEFAULT_BATCH_SIZE = 50;

interface DeliveryLogger {
  error(obj: unknown, msg?: string): void;
}

interface DeliveryOptions {
  now?: Date;
  log?: DeliveryLogger;
}

export type DeliveryResult = "completed" | "pending" | "skipped";

type DeliveryMessage = Prisma.ChatMessageGetPayload<{
  omit: typeof chatMessageOmit;
  include: typeof chatMessageInclude & {
    channel: { select: { workspaceId: true; type: true } };
  };
}>;

function retryDelay(attempts: number) {
  return Math.min(BASE_RETRY_MS * 2 ** Math.max(attempts - 1, 0), MAX_RETRY_MS);
}

function describeError(err: unknown): string {
  const errors = err instanceof AggregateError ? err.errors : [err];
  return errors
    .map((e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)))
    .join("\n")
    .slice(-2000);
}

// Channel members who are still workspace members. Notification and thread
// payloads carry message content, so stale memberships must not receive them.
async function currentRecipients(
  db: PrismaClient | Prisma.TransactionClient,
  channelId: string,
  workspaceId: string,
) {
  const members = await db.chatChannelMember.findMany({
    where: {
      channelId,
      user: { workspaces: { some: { workspaceId } } },
    },
    select: { userId: true },
  });
  return new Set(members.map((member) => member.userId));
}

// Creates the message's notifications unless an earlier attempt already did,
// and returns their ids.
async function ensureNotifications(prisma: PrismaClient, message: DeliveryMessage) {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<
      Array<{ notifiedAt: Date | null; notificationIds: string[]; mentionedUserIds: string[] }>
    >`SELECT "notifiedAt", "notificationIds", "mentionedUserIds" FROM "ChatMessageDelivery" WHERE "messageId" = ${message.id} FOR UPDATE`;
    if (!row) return [];
    if (row.notifiedAt) return row.notificationIds;
    // Mentions present both when sent and now: an edit before a delayed
    // delivery can withdraw a mention but cannot add one.
    const mentionedWhenSent = new Set(row.mentionedUserIds);

    const recipients = await currentRecipients(tx, message.channelId, message.channel.workspaceId);
    const senderName = message.user.displayName;
    const body = message.content.slice(0, 200);
    const data = { channelId: message.channelId, messageId: message.id };
    const drafts: Array<{ userId: string; type: NotificationType; title: string }> = [];

    for (const userId of parseMentions(message.content)) {
      if (userId !== message.userId && recipients.has(userId) && mentionedWhenSent.has(userId)) {
        drafts.push({ userId, type: "CHAT_MENTION", title: `${senderName} mentioned you in chat` });
      }
    }
    if (message.channel.type === "DM") {
      for (const userId of recipients) {
        if (userId !== message.userId) {
          drafts.push({ userId, type: "CHAT_DM_MESSAGE", title: `${senderName} sent you a message` });
        }
      }
    }

    let ids: string[] = [];
    if (drafts.length > 0) {
      const preferences = await tx.notificationPreference.findMany({
        where: { userId: { in: [...new Set(drafts.map((d) => d.userId))] } },
        select: { userId: true, chatMention: true, chatDmMessage: true },
      });
      const prefs = new Map(preferences.map((p) => [p.userId, p]));
      const allowed = drafts.filter((d) => {
        const pref = prefs.get(d.userId);
        if (!pref) return true;
        return d.type === "CHAT_MENTION" ? pref.chatMention : pref.chatDmMessage;
      });
      if (allowed.length > 0) {
        const created = await tx.notification.createManyAndReturn({
          data: allowed.map((d) => ({ ...d, body, data })),
          select: { id: true },
        });
        ids = created.map((n) => n.id);
      }
    }

    await tx.chatMessageDelivery.update({
      where: { messageId: message.id },
      data: { notifiedAt: new Date(), notificationIds: ids },
    });
    return ids;
  });
}

async function broadcastNotifications(prisma: PrismaClient, ids: string[]) {
  if (ids.length === 0) return;
  const notifications = await prisma.notification.findMany({
    where: { id: { in: ids } },
    orderBy: { createdAt: "asc" },
  });
  for (const notification of notifications) {
    broadcastToUser(notification.userId, "notification_created", notification);
  }
}

async function broadcastThreadReply(prisma: PrismaClient, message: DeliveryMessage, parentId: string) {
  const recipients = await currentRecipients(prisma, message.channelId, message.channel.workspaceId);
  const subscribers = await getThreadSubscribers(prisma, parentId);
  for (const userId of subscribers) {
    if (userId !== message.userId && recipients.has(userId)) {
      broadcastToUser(userId, "chat_thread_reply", {
        channelId: message.channelId,
        messageId: message.id,
        parentId,
      });
    }
  }
}

// Runs every side effect, even after one fails, so a broken realtime socket
// does not hold back notifications or the other way round.
async function runSideEffects(prisma: PrismaClient, messageId: string) {
  const loaded = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    omit: chatMessageOmit,
    include: {
      ...chatMessageInclude,
      channel: { select: { workspaceId: true, type: true } },
    },
  });
  // A message deleted before its delivery is no longer announced.
  if (!loaded || loaded.deletedAt) return;
  const message = loaded;
  const { channel: _channel, ...payload } = message;

  const errors: unknown[] = [];
  const attempt = async (step: () => unknown) => {
    try {
      await step();
    } catch (err) {
      errors.push(err);
    }
  };

  // A retry can run after a member lost access while their socket is still
  // subscribed, so only current members receive the content.
  await attempt(async () => {
    const readers = await currentRecipients(prisma, message.channelId, message.channel.workspaceId);
    broadcastToChannel(
      message.channelId,
      "chat_message_created",
      { message: payload, channelId: message.channelId },
      undefined,
      readers,
    );
  });
  let notificationIds: string[] | null = null;
  await attempt(async () => {
    notificationIds = await ensureNotifications(prisma, message);
  });
  if (notificationIds) {
    const ids: string[] = notificationIds;
    await attempt(() => broadcastNotifications(prisma, ids));
  }
  const parentId = message.parentId;
  if (parentId) {
    await attempt(() => broadcastThreadReply(prisma, message, parentId));
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "Chat message side effects failed");
  }
}

/**
 * Leases a due delivery for one attempt. The attempt number identifies the
 * claim: each claim increments it, so a later claim (after this lease expired)
 * makes this attempt's completion and failure writes no-ops.
 */
export async function claimChatMessageDelivery(
  prisma: PrismaClient,
  messageId: string,
  now: Date,
): Promise<number | null> {
  const row = await prisma.chatMessageDelivery.findUnique({
    where: { messageId },
    select: { attempts: true },
  });
  if (!row) return null;
  const attempt = row.attempts + 1;
  const claimed = await prisma.chatMessageDelivery.updateMany({
    where: {
      messageId,
      attempts: { equals: row.attempts, lt: MAX_DELIVERY_ATTEMPTS },
      nextAttemptAt: { lte: now },
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
    },
    data: {
      lockedUntil: new Date(now.getTime() + LEASE_MS),
      attempts: attempt,
    },
  });
  return claimed.count === 1 ? attempt : null;
}

/** Removes a delivered row, unless a later attempt has claimed it since. */
export async function completeChatMessageDelivery(
  prisma: PrismaClient,
  messageId: string,
  attempt: number,
) {
  const deleted = await prisma.chatMessageDelivery.deleteMany({
    where: { messageId, attempts: attempt },
  });
  return deleted.count === 1;
}

/** Releases a failed attempt for a retry, unless a later attempt owns the row. */
export async function failChatMessageDelivery(
  prisma: PrismaClient,
  messageId: string,
  attempt: number,
  err: unknown,
  now: Date,
) {
  const updated = await prisma.chatMessageDelivery.updateMany({
    where: { messageId, attempts: attempt },
    data: {
      lockedUntil: null,
      lastError: describeError(err),
      // An exhausted row is kept for inspection without a next attempt.
      nextAttemptAt:
        attempt >= MAX_DELIVERY_ATTEMPTS
          ? null
          : new Date(now.getTime() + retryDelay(attempt)),
    },
  });
  return updated.count === 1;
}

/**
 * Runs one delivery attempt for a message if it is due and not leased by
 * another attempt. It never throws: a failure is recorded on the outbox row
 * for a later retry.
 */
export async function deliverChatMessage(
  prisma: PrismaClient,
  messageId: string,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  const now = options.now ?? new Date();
  let attempt: number | null;
  try {
    attempt = await claimChatMessageDelivery(prisma, messageId, now);
  } catch (err) {
    options.log?.error({ err, messageId }, "Could not claim chat message delivery");
    return "pending";
  }
  if (attempt === null) return "skipped";

  try {
    await runSideEffects(prisma, messageId);
    await completeChatMessageDelivery(prisma, messageId, attempt);
    return "completed";
  } catch (err) {
    try {
      await failChatMessageDelivery(prisma, messageId, attempt, err, now);
      const finalAttempt = attempt >= MAX_DELIVERY_ATTEMPTS;
      options.log?.error(
        { err, messageId, attempt, finalAttempt },
        finalAttempt
          ? "Chat message delivery failed for the last time"
          : "Chat message delivery failed; it will be retried",
      );
    } catch (recordErr) {
      // The lease expires and the row is retried anyway.
      options.log?.error({ err, recordErr, messageId }, "Could not record chat message delivery failure");
    }
    return "pending";
  }
}

/** Retries every due, unleased delivery. */
export async function processDueChatMessageDeliveries(
  prisma: PrismaClient,
  options: DeliveryOptions & { limit?: number } = {},
) {
  const now = options.now ?? new Date();
  const due = await prisma.chatMessageDelivery.findMany({
    where: {
      attempts: { lt: MAX_DELIVERY_ATTEMPTS },
      nextAttemptAt: { lte: now },
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
    },
    orderBy: { nextAttemptAt: "asc" },
    take: options.limit ?? DEFAULT_BATCH_SIZE,
    select: { messageId: true },
  });
  const results = { completed: 0, pending: 0, skipped: 0 };
  for (const { messageId } of due) {
    results[await deliverChatMessage(prisma, messageId, { ...options, now })] += 1;
  }
  return results;
}
