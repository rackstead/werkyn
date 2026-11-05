-- Trigram indexes for text search (docs/remediation/p02c.md).
--
-- Search filters with Prisma's `contains` and mode "insensitive", that is
-- "column" ILIKE '%term%'. A B-tree index cannot serve a pattern that starts
-- with a wildcard, so every search read the whole table (or every message of
-- the searched channels). pg_trgm's GIN operator class serves LIKE and ILIKE
-- with any wildcards: the index returns the rows that hold all trigrams of
-- the term and PostgreSQL rechecks the ILIKE on them, so results are exactly
-- those of the scan. A term that yields no trigram (one or two letters, or
-- only wildcards) matches every entry; the planner sees the term
-- (src/utils/text-search.ts keeps custom plans for search statements) and
-- scans as before.
--
-- Columns: task title and description (global search, task list and board
-- filter), chat message content (chat and global search), wiki page title
-- (global search) and file name (Drive search). Project names are not
-- indexed: a workspace has few projects.
--
-- pg_trgm is a trusted extension on PostgreSQL 13 and later, so CREATE
-- EXTENSION needs only the CREATE privilege on the database (the database
-- owner has it); PostgreSQL 12 and older need a superuser. It ships with
-- PostgreSQL's contrib modules: the official postgres images and the managed
-- services (Amazon RDS and Aurora, Google Cloud SQL, Azure Database for
-- PostgreSQL, Supabase, Neon) include it; Azure Flexible Server only after
-- it is added to the azure.extensions parameter, and distribution packages
-- may need the separate contrib package. Where the application role may not
-- create it, a superuser can run, in the Werkyn database before the upgrade:
--
--   CREATE EXTENSION IF NOT EXISTS pg_trgm;
--
-- The whole migration is one transaction: if CREATE EXTENSION fails, nothing
-- is created and the server does not start. Install the extension as above
-- (or grant the role CREATE on the database), then mark the migration rolled
-- back and deploy again:
--
--   prisma migrate resolve --rolled-back 20261105180000_search_trigram_indexes
--
-- An existing pg_trgm in another schema is kept; that schema must be on the
-- role's search_path, so that gin_trgm_ops resolves.
--
-- Lock impact: each CREATE INDEX holds a SHARE lock on its table while it
-- builds, so writes to that table (task edits, chat messages, file and wiki
-- changes) wait; reads do not. The shipped entrypoint applies migrations
-- before the server starts, so nothing waits there. On the P02 fixture
-- (100k tasks, 200k messages, 50k files, 20k pages) the five builds took
-- about 5 s and 48 MB in total; time and size grow about linearly with the
-- text indexed.
--
-- CREATE INDEX CONCURRENTLY is not used, for the reasons in
-- 20261030150000_index_task_board_order. Operators who apply migrations
-- while an older version keeps writing can create the extension and build
-- the indexes first, one statement at a time:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "Task_title_trgm_idx" ON "Task" USING GIN ("title" gin_trgm_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "Task_description_trgm_idx" ON "Task" USING GIN ("description" gin_trgm_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_content_trgm_idx" ON "ChatMessage" USING GIN ("content" gin_trgm_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "WikiPage_title_trgm_idx" ON "WikiPage" USING GIN ("title" gin_trgm_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "File_name_trgm_idx" ON "File" USING GIN ("name" gin_trgm_ops);
--
-- and check that pg_index.indisvalid is true for each (drop and rebuild one
-- that is not). IF NOT EXISTS below then skips them.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Task_title_trgm_idx" ON "Task" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Task_description_trgm_idx" ON "Task" USING GIN ("description" gin_trgm_ops);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChatMessage_content_trgm_idx" ON "ChatMessage" USING GIN ("content" gin_trgm_ops);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WikiPage_title_trgm_idx" ON "WikiPage" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "File_name_trgm_idx" ON "File" USING GIN ("name" gin_trgm_ops);
