import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import {
  deliverNotification,
  enqueueNotification,
  type NotificationDeliveryResult,
  type NotificationRequest,
} from "../modules/notifications/notification-delivery.js";

/**
 * Queues a notification in the durable outbox and runs its first delivery
 * attempt. Recipients are filtered (actor, project access, preferences) when
 * the notifications are created. A failed attempt is recorded and retried by
 * the notification delivery worker, so the result is "pending" rather than a
 * rejection; the promise rejects only when the outbox row cannot be written.
 */
export async function notify(
  prisma: PrismaClient,
  fastify: Pick<FastifyInstance, "broadcastToUser" | "log">,
  options: NotificationRequest,
): Promise<NotificationDeliveryResult> {
  const id = await enqueueNotification(prisma, options);
  if (!id) return "skipped";
  return deliverNotification(prisma, fastify, id, { log: fastify.log });
}
