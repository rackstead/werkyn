-- Wiki uploads are queued for cleanup only once no current page and no
-- version still names them. These tables are that check: one row per path
-- per page or version, filled from content by the triggers below. Page and
-- version JSON is not rewritten. The sweep looks a path up by the primary
-- key (storagePath first), so it does not read every wiki body and does not
-- scan every wiki row.
--
-- The one-time backfill records paths that are already stored. It does not
-- queue or delete anything. Blobs that were never named by a row stay
-- untracked; this is not a disk scan.
--
-- Lock impact: the new tables are empty, then the triggers take a brief
-- share lock on WikiPage and WikiPageVersion while they are created. The
-- backfill reads those tables. The shipped entrypoint applies migrations
-- before the server starts. CREATE INDEX CONCURRENTLY is not used, for the
-- reasons in 20261030150000_index_task_board_order.

-- Prefix case only. The captured path is the bytes' relative name.
CREATE FUNCTION wiki_media_storage_paths(doc jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = pg_catalog
AS $fn$
  SELECT COALESCE(array_agg(DISTINCT capture ORDER BY capture), ARRAY[]::text[])
  FROM (
    SELECT matched[1] AS capture
    FROM regexp_matches(
      doc::text,
      '/[sS][tT][oO][rR][aA][gG][eE]/([A-Za-z0-9_-]{1,128}/uploads/wiki/[A-Za-z0-9_-]{1,128}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[^"\\[:space:]/?#]{1,255})?)',
      'g'
    ) AS matched
  ) AS found
$fn$;

-- CreateTable
CREATE TABLE "WikiPageMedia" (
    "storagePath" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,

    CONSTRAINT "WikiPageMedia_pkey" PRIMARY KEY ("storagePath","pageId")
);

-- CreateTable
CREATE TABLE "WikiVersionMedia" (
    "storagePath" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,

    CONSTRAINT "WikiVersionMedia_pkey" PRIMARY KEY ("storagePath","versionId")
);

-- CreateIndex
CREATE INDEX "WikiPageMedia_pageId_idx" ON "WikiPageMedia"("pageId");

-- CreateIndex
CREATE INDEX "WikiVersionMedia_versionId_idx" ON "WikiVersionMedia"("versionId");

-- AddForeignKey
ALTER TABLE "WikiPageMedia" ADD CONSTRAINT "WikiPageMedia_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "WikiPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WikiVersionMedia" ADD CONSTRAINT "WikiVersionMedia_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "WikiPageVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- True when a current page or a version still names this exact path.
CREATE FUNCTION wiki_media_still_referenced(path text)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
STRICT
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM "WikiPageMedia" WHERE "storagePath" = path
  ) OR EXISTS (
    SELECT 1 FROM "WikiVersionMedia" WHERE "storagePath" = path
  )
$fn$;

-- Keeps the reference rows in step with content, in the same transaction.
-- A save that names a path consumes its BlobCleanup row and does not delete
-- the bytes. A save or delete that leaves the path on zero pages and zero
-- versions queues it for the sweeper, due now. Cascades (space, workspace,
-- user) run this too, because they delete the pages and versions.
CREATE FUNCTION sync_wiki_media_refs() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  holder_id text;
  old_paths text[] := ARRAY[]::text[];
  new_paths text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."content" IS NOT DISTINCT FROM NEW."content" THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    holder_id := OLD.id;
    IF OLD."content" IS NOT NULL THEN
      old_paths := COALESCE(wiki_media_storage_paths(OLD."content"), ARRAY[]::text[]);
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    holder_id := NEW.id;
    IF NEW."content" IS NOT NULL THEN
      new_paths := COALESCE(wiki_media_storage_paths(NEW."content"), ARRAY[]::text[]);
    END IF;
  ELSE
    holder_id := NEW.id;
    IF OLD."content" IS NOT NULL THEN
      old_paths := COALESCE(wiki_media_storage_paths(OLD."content"), ARRAY[]::text[]);
    END IF;
    IF NEW."content" IS NOT NULL THEN
      new_paths := COALESCE(wiki_media_storage_paths(NEW."content"), ARRAY[]::text[]);
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'WikiPage' THEN
    DELETE FROM "WikiPageMedia" WHERE "pageId" = holder_id;
    IF TG_OP <> 'DELETE' THEN
      INSERT INTO "WikiPageMedia" ("storagePath", "pageId")
      SELECT DISTINCT path, holder_id
      FROM unnest(new_paths) AS path
      ORDER BY path;
    END IF;
  ELSIF TG_TABLE_NAME = 'WikiPageVersion' THEN
    DELETE FROM "WikiVersionMedia" WHERE "versionId" = holder_id;
    IF TG_OP <> 'DELETE' THEN
      INSERT INTO "WikiVersionMedia" ("storagePath", "versionId")
      SELECT DISTINCT path, holder_id
      FROM unnest(new_paths) AS path
      ORDER BY path;
    END IF;
  ELSE
    RAISE EXCEPTION 'sync_wiki_media_refs cannot track %', TG_TABLE_NAME;
  END IF;

  -- Existing queue rows, in path order, before this statement inserts more.
  PERFORM 1
  FROM "BlobCleanup"
  WHERE "storagePath" IN (SELECT unnest(old_paths || new_paths))
  ORDER BY "storagePath"
  FOR UPDATE;

  INSERT INTO "BlobCleanup" ("storagePath")
  SELECT path
  FROM (
    SELECT DISTINCT path
    FROM unnest(old_paths) AS path
    WHERE path <> ALL(new_paths)
      AND NOT wiki_media_still_referenced(path)
  ) AS dropped
  ORDER BY path
  ON CONFLICT ("storagePath") DO UPDATE
  SET "availableAt" = LEAST("BlobCleanup"."availableAt", CURRENT_TIMESTAMP);

  -- The save names these paths. Drop the queue row; leave the bytes.
  DELETE FROM "BlobCleanup"
  WHERE "storagePath" IN (SELECT unnest(new_paths));

  RETURN NULL;
END;
$fn$;

DO $pin$
DECLARE
  schema_name text := current_schema();
BEGIN
  IF schema_name IS NULL
    OR to_regprocedure(format('%I.wiki_media_storage_paths(jsonb)', schema_name)) IS NULL
    OR to_regprocedure(format('%I.wiki_media_still_referenced(text)', schema_name)) IS NULL
    OR to_regprocedure(format('%I.sync_wiki_media_refs()', schema_name)) IS NULL
  THEN
    RAISE EXCEPTION 'Migration 20261110143000_wiki_media_blob_refs: wiki media functions are missing from schema %', coalesce(schema_name, '(none)');
  END IF;
  EXECUTE format(
    'ALTER FUNCTION %I.wiki_media_storage_paths(jsonb) SET search_path = pg_catalog',
    schema_name
  );
  EXECUTE format(
    'ALTER FUNCTION %I.wiki_media_still_referenced(text) SET search_path = %I, pg_temp',
    schema_name, schema_name
  );
  EXECUTE format(
    'ALTER FUNCTION %I.sync_wiki_media_refs() SET search_path = %I, pg_temp',
    schema_name, schema_name
  );
END
$pin$;

CREATE TRIGGER "WikiPage_sync_media_refs"
AFTER INSERT OR DELETE OR UPDATE OF "content" ON "WikiPage"
FOR EACH ROW EXECUTE FUNCTION sync_wiki_media_refs();

CREATE TRIGGER "WikiPageVersion_sync_media_refs"
AFTER INSERT OR DELETE OR UPDATE OF "content" ON "WikiPageVersion"
FOR EACH ROW EXECUTE FUNCTION sync_wiki_media_refs();

INSERT INTO "WikiPageMedia" ("storagePath", "pageId")
SELECT DISTINCT path, page.id
FROM "WikiPage" AS page
CROSS JOIN LATERAL unnest(wiki_media_storage_paths(page."content")) AS path
ON CONFLICT DO NOTHING;

INSERT INTO "WikiVersionMedia" ("storagePath", "versionId")
SELECT DISTINCT path, version.id
FROM "WikiPageVersion" AS version
CROSS JOIN LATERAL unnest(wiki_media_storage_paths(version."content")) AS path
ON CONFLICT DO NOTHING;
