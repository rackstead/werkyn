-- Equality index for the avatar cleanup sweep. avatarUrl is unbounded text,
-- so this is a hash index: it stores a hash, not the URL, and a long value
-- still fits. The sweep looks up one exact URL at a time.
--
-- Lock impact: CREATE INDEX holds a SHARE lock on "User" while it builds, so
-- user inserts, updates and deletes wait (reads do not). The shipped
-- entrypoint applies migrations before the server starts, so nothing waits
-- there. CREATE INDEX CONCURRENTLY is not used, for the reasons in
-- 20261030150000_index_task_board_order.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_avatarUrl_hash_idx" ON "User" USING HASH ("avatarUrl");
