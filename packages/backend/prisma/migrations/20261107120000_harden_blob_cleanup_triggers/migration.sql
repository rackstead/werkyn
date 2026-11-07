-- Cleanup must use the owning schema even when the caller has temporary
-- tables of the same name or an empty search_path. Keep pg_temp explicit
-- and last so pg_catalog retains its implicit first position.
--
-- Cast the two non-text operands to text before operator resolution:
-- pg_catalog then has an exact match, ahead of operators in the app schema.
-- No table or stored row is changed. The precheck and changes are atomic.
BEGIN;

DO $check$
DECLARE
  schema_name text := current_schema();
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'enqueue_file_blob_cleanup',
    'enqueue_attachment_blob_cleanup',
    'delete_entity_attachments',
    'refuse_project_change'
  ] LOOP
    IF schema_name IS NULL OR to_regprocedure(format('%I.%I()', schema_name, fn)) IS NULL THEN
      RAISE EXCEPTION 'Migration 20261107120000_harden_blob_cleanup_triggers: no function %() in the current schema %', fn, coalesce(schema_name, '(none)');
    END IF;
  END LOOP;
END
$check$;

CREATE OR REPLACE FUNCTION refuse_project_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'update of relation "%" violates constraint "%_projectId_fixed": the project of % cannot change', TG_TABLE_NAME, TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME::text || '_projectId_fixed', TABLE = TG_TABLE_NAME;
END;
$$;

CREATE OR REPLACE FUNCTION delete_entity_attachments() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "Attachment"
  WHERE "entityType"::text = TG_ARGV[0] AND "entityId" = OLD."id";
  RETURN NULL;
END;
$$;

DO $pin$
DECLARE
  schema_name text := current_schema();
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'enqueue_file_blob_cleanup',
    'enqueue_attachment_blob_cleanup',
    'delete_entity_attachments',
    'refuse_project_change'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %I.%I() SET search_path = %I, pg_temp', schema_name, fn, schema_name);
  END LOOP;
END
$pin$;

COMMIT;
