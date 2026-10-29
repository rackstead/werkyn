-- Durable scheduler jobs.
--
-- "RecurringTaskOccurrence" records each schedule date the recurring-task
-- scheduler has generated. The scheduler writes it in the same transaction as
-- the generated task and the advanced "nextRunDate", under a row lock on the
-- schedule, so a date is generated at most once across workers, crashes,
-- retries and edits that move "nextRunDate" back to an already generated date.
-- Deleting the generated task keeps the row (with a null "taskId"), so the
-- date is not generated again. Existing schedules get no rows: dates generated
-- before this migration are not known, and the stored "nextRunDate" already
-- points past them.
--
-- "RecurringTaskConfig"."lastRunDate" is the UTC date of the last scheduler
-- run that advanced or ended the schedule; edits never write it. Existing rows
-- get the date of their last write of any kind, which can only be later than
-- their last run. The scheduler compares it with today only, so the
-- approximation matters on the upgrade day alone.
--
-- "NotificationDelivery" is the outbox for notifications sent through
-- notify() (task, comment, template, file-share and due-date reminder
-- notifications). Its notifications are created in the same transaction that
-- sets "notifiedAt", so a retry never creates them twice; a failed attempt is
-- retried with backoff, and a delivered row is deleted. A row that exhausts
-- its attempts keeps "lastError" with a null "nextAttemptAt", so it leaves the
-- due-row index range.

-- AlterTable
ALTER TABLE "RecurringTaskConfig" ADD COLUMN     "lastRunDate" TEXT;

UPDATE "RecurringTaskConfig" SET "lastRunDate" = to_char("updatedAt", 'YYYY-MM-DD');

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "body" VARCHAR(1000),
    "data" JSONB,
    "recipientIds" TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "notificationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringTaskOccurrence" (
    "configId" TEXT NOT NULL,
    "occurrenceDate" TEXT NOT NULL,
    "taskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringTaskOccurrence_pkey" PRIMARY KEY ("configId","occurrenceDate")
);

-- CreateIndex
CREATE INDEX "NotificationDelivery_nextAttemptAt_idx" ON "NotificationDelivery"("nextAttemptAt");

-- CreateIndex
CREATE INDEX "RecurringTaskOccurrence_taskId_idx" ON "RecurringTaskOccurrence"("taskId");

-- AddForeignKey
ALTER TABLE "RecurringTaskOccurrence" ADD CONSTRAINT "RecurringTaskOccurrence_configId_fkey" FOREIGN KEY ("configId") REFERENCES "RecurringTaskConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringTaskOccurrence" ADD CONSTRAINT "RecurringTaskOccurrence_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
