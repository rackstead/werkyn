-- This undeployed application has no real cleanup queue to repair. Interpret
-- legacy wall-clock values as UTC, explicitly and independently of the
-- migration connection's TimeZone. A mixed/non-UTC legacy queue cannot have
-- its intended instants inferred from TIMESTAMP alone; see
-- docs/remediation/blob-cleanup-timezones.md before adopting this migration
-- for a different existing installation.
BEGIN;

ALTER TABLE "BlobCleanup"
  ALTER COLUMN "availableAt" TYPE TIMESTAMPTZ(3)
    USING ("availableAt" AT TIME ZONE 'UTC'),
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3)
    USING ("createdAt" AT TIME ZONE 'UTC'),
  ALTER COLUMN "availableAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

COMMIT;
