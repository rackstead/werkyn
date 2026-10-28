-- Durable cleanup queue for stored blobs (originals, thumbnails and legacy
-- attachment uploads). Rows are written by the triggers below in the same
-- transaction that removes the owning database row, including every foreign
-- key cascade (parent folder, team folder, workspace, uploader, task, comment),
-- so a crash or storage failure after the commit cannot lose cleanup work.
-- services/blob-cleanup.ts deletes each blob idempotently and then its row.

-- CreateTable
CREATE TABLE "BlobCleanup" (
    "storagePath" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlobCleanup_pkey" PRIMARY KEY ("storagePath")
);

-- CreateIndex
CREATE INDEX "BlobCleanup_availableAt_idx" ON "BlobCleanup"("availableAt");

-- The worker re-checks that no live File still names a queued path.
-- CreateIndex
CREATE INDEX "File_storagePath_idx" ON "File"("storagePath");

-- CreateIndex
CREATE INDEX "File_thumbnailPath_idx" ON "File"("thumbnailPath");

-- A deleted File queues its original and thumbnail. A changed path queues the
-- path it no longer names (stored paths are otherwise immutable). A path that
-- is already queued (for example kept while a live File still named it)
-- becomes due now.
CREATE FUNCTION enqueue_file_blob_cleanup() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  paths TEXT[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    paths := ARRAY[OLD."storagePath", OLD."thumbnailPath"];
  ELSE
    paths := ARRAY[
      CASE WHEN OLD."storagePath" IS DISTINCT FROM NEW."storagePath"
        AND OLD."storagePath" IS DISTINCT FROM NEW."thumbnailPath"
        THEN OLD."storagePath" END,
      CASE WHEN OLD."thumbnailPath" IS DISTINCT FROM NEW."thumbnailPath"
        AND OLD."thumbnailPath" IS DISTINCT FROM NEW."storagePath"
        THEN OLD."thumbnailPath" END
    ];
  END IF;
  INSERT INTO "BlobCleanup" ("storagePath")
  SELECT DISTINCT path FROM unnest(paths) AS path
  WHERE path IS NOT NULL AND path <> ''
  ON CONFLICT ("storagePath") DO UPDATE
  SET "availableAt" = LEAST("BlobCleanup"."availableAt", CURRENT_TIMESTAMP);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "File_enqueue_blob_cleanup_on_delete"
AFTER DELETE ON "File"
FOR EACH ROW EXECUTE FUNCTION enqueue_file_blob_cleanup();

CREATE TRIGGER "File_enqueue_blob_cleanup_on_update"
AFTER UPDATE OF "storagePath", "thumbnailPath" ON "File"
FOR EACH ROW
WHEN (OLD."storagePath" IS DISTINCT FROM NEW."storagePath"
  OR OLD."thumbnailPath" IS DISTINCT FROM NEW."thumbnailPath")
EXECUTE FUNCTION enqueue_file_blob_cleanup();

-- A linked attachment ("fileId" set) shares its Drive file's blob, which the
-- File row owns. A row without "fileId" is a legacy direct upload that owns
-- its blob, or a SetNull leftover naming an already queued Drive blob.
CREATE FUNCTION enqueue_attachment_blob_cleanup() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."fileId" IS NULL AND OLD."storagePath" <> '' THEN
    INSERT INTO "BlobCleanup" ("storagePath")
    VALUES (OLD."storagePath")
    ON CONFLICT ("storagePath") DO UPDATE
    SET "availableAt" = LEAST("BlobCleanup"."availableAt", CURRENT_TIMESTAMP);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "Attachment_enqueue_blob_cleanup"
AFTER DELETE ON "Attachment"
FOR EACH ROW EXECUTE FUNCTION enqueue_attachment_blob_cleanup();

-- Attachment targets are polymorphic (no foreign key), so deleting a task or
-- comment, directly or through a project/workspace/task cascade, removes its
-- attachment rows here.
CREATE FUNCTION delete_entity_attachments() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "Attachment"
  WHERE "entityType" = TG_ARGV[0] AND "entityId" = OLD."id";
  RETURN NULL;
END;
$$;

CREATE TRIGGER "Task_delete_attachments"
AFTER DELETE ON "Task"
FOR EACH ROW EXECUTE FUNCTION delete_entity_attachments('task');

CREATE TRIGGER "Comment_delete_attachments"
AFTER DELETE ON "Comment"
FOR EACH ROW EXECUTE FUNCTION delete_entity_attachments('comment');

-- Attachments already orphaned by earlier task/comment deletions cannot be
-- listed or downloaded (their target check fails). Remove them now so their
-- legacy blobs are queued by the trigger above.
DELETE FROM "Attachment" a
WHERE a."entityType" = 'task'
  AND NOT EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = a."entityId");

DELETE FROM "Attachment" a
WHERE a."entityType" = 'comment'
  AND NOT EXISTS (SELECT 1 FROM "Comment" c WHERE c."id" = a."entityId");
