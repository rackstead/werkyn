-- A chat send stores its message, the channel ordering touch, the thread
-- auto-subscription and a delivery outbox row in one transaction. The outbox
-- row is retried until the message's notifications and realtime events have
-- been delivered, then deleted. "clientMessageId" is the sender's idempotency
-- key, so a retried send returns the original message instead of storing a
-- duplicate; "clientMessageHash" fingerprints the original request so a key
-- reused for a different message is rejected, even after an edit.
-- Existing messages get no outbox row: their side effects already ran.
-- A row that exhausts its attempts keeps "lastError" with a null
-- "nextAttemptAt", so it leaves the due-row index range.

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "clientMessageHash" CHAR(64),
ADD COLUMN     "clientMessageId" VARCHAR(128);

-- CreateTable
CREATE TABLE "ChatMessageDelivery" (
    "messageId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "mentionedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notifiedAt" TIMESTAMP(3),
    "notificationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessageDelivery_pkey" PRIMARY KEY ("messageId")
);

-- CreateIndex
CREATE INDEX "ChatMessageDelivery_nextAttemptAt_idx" ON "ChatMessageDelivery"("nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_userId_clientMessageId_key" ON "ChatMessage"("userId", "clientMessageId");

-- AddForeignKey
ALTER TABLE "ChatMessageDelivery" ADD CONSTRAINT "ChatMessageDelivery_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
