-- Per-user cooldown on backup preview and restore uploads (R42 follow-up,
-- docs/remediation/r42-backup-limits.md).
--
-- One row per user at most, for a user who recently held a backup slot below
-- the minimum upload rate. "clearsAt" is when the wait they owe is paid off;
-- while enough of it is left, their previews and restores are answered 429.
-- Rows are removed with their user, and rows whose wait is over are pruned
-- whenever a row is written, so the table holds only users with a recent
-- slow upload. A new, empty table: nothing existing is changed.
CREATE TABLE "BackupUploadCooldown" (
    "userId" TEXT NOT NULL,
    "clearsAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupUploadCooldown_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "BackupUploadCooldown_clearsAt_idx" ON "BackupUploadCooldown"("clearsAt");

ALTER TABLE "BackupUploadCooldown" ADD CONSTRAINT "BackupUploadCooldown_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
