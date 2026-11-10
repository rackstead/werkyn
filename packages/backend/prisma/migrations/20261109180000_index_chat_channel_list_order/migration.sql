-- Order indexes for the channel list and the DM list.
--
-- The channel list pages by createdAt ascending then id. The DM list pages
-- by updatedAt descending then id (docs/remediation/chat-list-paging.md).
-- Without an index in that order, each page sorts the workspace's matching
-- rows before applying LIMIT. A backward scan of (updatedAt, id) serves the
-- descending DM order.
--
-- "id" is part of the order, so it is a key column. Notification visibility
-- looks a channel up by primary key, not by this order.
--
-- Lock impact: CREATE INDEX holds a SHARE lock on "ChatChannel" while it
-- builds, so channel inserts, updates and deletes wait (reads do not). The
-- shipped entrypoint applies migrations before the server starts, so nothing
-- waits there.
--
-- CREATE INDEX CONCURRENTLY is not used, for the reasons in
-- 20261030150000_index_task_board_order. Operators who apply migrations while
-- an older version keeps writing can build the indexes first:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatChannel_workspaceId_createdAt_id_idx"
--     ON "ChatChannel"("workspaceId", "createdAt", "id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatChannel_workspaceId_type_updatedAt_id_idx"
--     ON "ChatChannel"("workspaceId", "type", "updatedAt", "id");
--
-- and check that pg_index.indisvalid is true for each (drop and rebuild it if
-- not). IF NOT EXISTS below then makes this migration a no-op.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChatChannel_workspaceId_createdAt_id_idx" ON "ChatChannel"("workspaceId", "createdAt", "id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChatChannel_workspaceId_type_updatedAt_id_idx" ON "ChatChannel"("workspaceId", "type", "updatedAt", "id");
