-- Monotonic per-account revision of the workspace list returned by refresh
-- and invite acceptance. The counter moves in the same transaction as the
-- membership or list-visible workspace change it describes. Two snapshots
-- taken inside that transaction can still share one value.
--
-- Lock order matches utils/workspace-lock.ts: the workspace row is already
-- locked by the statement that fired the trigger, and user rows are locked
-- after it, in id order when one change touches several accounts.

ALTER TABLE "User" ADD COLUMN "membershipRevision" INTEGER NOT NULL DEFAULT 0;

-- One bump per affected account per statement. User rows are locked FOR NO
-- KEY UPDATE in id order before the counter moves. That waits on another
-- revision update without conflicting with the KEY SHARE lock a foreign-key
-- insert already holds, including the membership insert that fires this.
CREATE FUNCTION bump_listed_membership_revisions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM u.id
  FROM "User" u
  WHERE u.id IN (SELECT "userId" FROM changed)
  ORDER BY u.id
  FOR NO KEY UPDATE;
  UPDATE "User" u
  SET "membershipRevision" = u."membershipRevision" + 1
  WHERE u.id IN (SELECT "userId" FROM changed);
  RETURN NULL;
END;
$$;

CREATE FUNCTION bump_updated_membership_revisions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM u.id
  FROM "User" u
  WHERE u.id IN (
    SELECT "userId" FROM changed
    UNION
    SELECT "userId" FROM previous_rows
  )
  ORDER BY u.id
  FOR NO KEY UPDATE;
  UPDATE "User" u
  SET "membershipRevision" = u."membershipRevision" + 1
  WHERE u.id IN (
    SELECT "userId" FROM changed
    UNION
    SELECT "userId" FROM previous_rows
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER "WorkspaceMember_bump_membership_revision_insert"
AFTER INSERT ON "WorkspaceMember"
REFERENCING NEW TABLE AS changed
FOR EACH STATEMENT EXECUTE FUNCTION bump_listed_membership_revisions();

CREATE TRIGGER "WorkspaceMember_bump_membership_revision_delete"
AFTER DELETE ON "WorkspaceMember"
REFERENCING OLD TABLE AS changed
FOR EACH STATEMENT EXECUTE FUNCTION bump_listed_membership_revisions();

CREATE TRIGGER "WorkspaceMember_bump_membership_revision_update"
AFTER UPDATE ON "WorkspaceMember"
REFERENCING OLD TABLE AS previous_rows NEW TABLE AS changed
FOR EACH STATEMENT EXECUTE FUNCTION bump_updated_membership_revisions();

CREATE FUNCTION bump_workspace_list_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM u.id
  FROM "User" u
  WHERE u.id IN (
    SELECT wm."userId" FROM "WorkspaceMember" wm WHERE wm."workspaceId" = NEW.id
  )
  ORDER BY u.id
  FOR NO KEY UPDATE;
  UPDATE "User" u
  SET "membershipRevision" = u."membershipRevision" + 1
  WHERE u.id IN (
    SELECT wm."userId" FROM "WorkspaceMember" wm WHERE wm."workspaceId" = NEW.id
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER "Workspace_bump_membership_revision"
AFTER UPDATE OF name, slug, "logoUrl" ON "Workspace"
FOR EACH ROW
WHEN (
  OLD.name IS DISTINCT FROM NEW.name
  OR OLD.slug IS DISTINCT FROM NEW.slug
  OR OLD."logoUrl" IS DISTINCT FROM NEW."logoUrl"
)
EXECUTE FUNCTION bump_workspace_list_revision();

DO $pin$
DECLARE
  schema_name text := current_schema();
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'bump_listed_membership_revisions',
    'bump_updated_membership_revisions',
    'bump_workspace_list_revision'
  ] LOOP
    IF schema_name IS NULL OR to_regprocedure(format('%I.%I()', schema_name, fn)) IS NULL THEN
      RAISE EXCEPTION 'Migration 20261110190000_add_membership_revision: no function %() in the current schema %', fn, coalesce(schema_name, '(none)');
    END IF;
    EXECUTE format('ALTER FUNCTION %I.%I() SET search_path = %I, pg_temp', schema_name, fn, schema_name);
  END LOOP;
END
$pin$;
