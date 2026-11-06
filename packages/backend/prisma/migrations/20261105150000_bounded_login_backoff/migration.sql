-- Per-account failed sign-in backoff with bounded storage (docs/remediation/r31-login-backoff.md).
--
-- "LoginAttempt" kept one row per submitted address, including addresses
-- without an account, so attacker-chosen addresses grew it without limit
-- until the daily cleanup. Its rows are short-lived counters, not account
-- data: dropping them only forgets recent failures and lifts any lock they
-- held.
--
-- "LoginThrottle" keeps at most one row per slot. The server maps every
-- submitted address (with or without an account) to a slot with a keyed
-- hash, modulo LOGIN_BACKOFF_SLOTS, and a trusted browser's device id to a
-- lane in a second range starting at 16777216, so the table never holds more
-- rows than twice that setting and never stores an address. Slots are
-- non-negative. "admissions" numbers the slot's admitted attempts; a
-- sign-in's outcome clears or uncounts only its own and earlier admissions
-- ("clearedThrough"), so attempts admitted after it keep their count.
-- "generation" is new each time a row is created, so an outcome for a row
-- that was pruned meanwhile never changes the row created after it.
--
-- Stop older servers before applying: they still read "LoginAttempt" and
-- would answer sign-ins with 500 until replaced. The shipped entrypoint
-- applies migrations before the server starts.
DROP TABLE "LoginAttempt";

CREATE TABLE "LoginThrottle" (
    "slot" INTEGER NOT NULL,
    "failures" INTEGER NOT NULL,
    "lastFailureAt" TIMESTAMP(3) NOT NULL,
    "admissions" BIGINT NOT NULL DEFAULT 0,
    "clearedThrough" BIGINT NOT NULL DEFAULT 0,
    "generation" BIGSERIAL NOT NULL,

    CONSTRAINT "LoginThrottle_pkey" PRIMARY KEY ("slot"),
    CONSTRAINT "LoginThrottle_slot_check" CHECK ("slot" >= 0),
    CONSTRAINT "LoginThrottle_failures_check" CHECK ("failures" >= 0)
);

CREATE INDEX "LoginThrottle_lastFailureAt_idx" ON "LoginThrottle"("lastFailureAt");
