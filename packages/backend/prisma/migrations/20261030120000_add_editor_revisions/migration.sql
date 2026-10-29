-- Optimistic revisions for durable editor saves.
--
-- "WikiPage"."revision" is incremented by every write of a page's title,
-- content or icon (a save or a version restore). "Task"."descriptionRevision"
-- is incremented by every description write. An editor sends the revision its
-- document is based on; a save based on an older revision is refused with 409
-- instead of overwriting the newer content. Requests without a revision keep
-- the previous last-writer-wins behaviour.
--
-- Existing rows start at 0. A constant default makes both columns a catalog
-- change only; no table is rewritten.
ALTER TABLE "WikiPage" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Task" ADD COLUMN "descriptionRevision" INTEGER NOT NULL DEFAULT 0;
