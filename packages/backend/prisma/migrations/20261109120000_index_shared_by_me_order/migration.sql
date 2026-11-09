-- Page order for shared-by-me.
--
-- Member shares: WHERE "sharedById" = $1 AND "workspaceId" = $2
-- AND "createdAt" <= $cursor ORDER BY "createdAt" DESC, id LIMIT n.
-- Link files join FileShareLink in that same order, then the link-file id.
-- These indexes let a page start at the cursor and stop after n rows instead
-- of sorting every share the caller can still read.
--
-- Lock impact: CREATE INDEX holds a SHARE lock on the table while it builds,
-- so new shares wait and reads do not. The shipped entrypoint applies
-- migrations before the server starts. The fixture used to check the plan had
-- 2,000 shares and 2,000 link files; a later page read the index from the
-- cursor (8 and 68 buffer hits) rather than sorting the whole set.
--
-- CREATE INDEX CONCURRENTLY is not used, for the reasons in
-- 20261030150000_index_task_board_order. Operators who apply migrations while
-- an older version keeps writing can build the indexes first:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "FileShare_shared_by_me_idx"
--     ON "FileShare"("sharedById", "workspaceId", "createdAt" DESC);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "FileShareLink_shared_by_me_idx"
--     ON "FileShareLink"("createdById", "workspaceId", "createdAt" DESC);
--
-- and check that pg_index.indisvalid is true for both. IF NOT EXISTS below
-- then makes this migration a no-op.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FileShare_shared_by_me_idx" ON "FileShare"("sharedById", "workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FileShareLink_shared_by_me_idx" ON "FileShareLink"("createdById", "workspaceId", "createdAt" DESC);
