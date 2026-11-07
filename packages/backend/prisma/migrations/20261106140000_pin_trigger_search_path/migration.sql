-- Pin the search_path of the R35 trigger functions
-- (docs/remediation/r35-constraints.md).
--
-- The functions that 20261106120000_reference_integrity_constraints created
-- name "Task", "Label" and "CustomField" without a schema, so they looked the
-- tables up through the search_path of the session that wrote the row:
--
--   - pg_restore empties the search_path, so a data-only restore into a
--     migrated database failed with: relation "Task" does not exist.
--   - A temporary table is searched before the schema by default, so a
--     session that created a temporary "Task", "Label" or "CustomField" made
--     the same-project check read that table instead, and could store a row
--     that links two projects.
--
-- Each function now runs with the search_path set to the schema this
-- migration runs in (the schema of DATABASE_URL, "public" unless the URL sets
-- `schema`), where that migration created the functions and their tables, and
-- then pg_temp. pg_catalog stays first, as it is implicitly. The table names
-- therefore always resolve to that schema, and a temporary table of the same
-- name is never read. The function bodies are unchanged: the schema is only
-- known when the migration runs, and writing it into each body would repeat
-- them in dynamic SQL without resolving the names any differently.
--
-- Running it again sets the same values. It changes no table or data, takes
-- no table lock, and is outside Prisma's model (no drift).

DO $pin$
DECLARE
  schema_name text := current_schema();
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'check_task_label_project',
    'check_custom_field_value_project',
    'check_task_dependency_project',
    'refuse_project_change'
  ] LOOP
    IF schema_name IS NULL OR to_regprocedure(format('%I.%I()', schema_name, fn)) IS NULL THEN
      RAISE EXCEPTION 'Migration 20261106140000_pin_trigger_search_path: no function %() in the current schema %', fn, coalesce(schema_name, '(none)');
    END IF;
    EXECUTE format('ALTER FUNCTION %I.%I() SET search_path = %I, pg_temp', schema_name, fn, schema_name);
  END LOOP;
END
$pin$;
