-- Reference integrity constraints (docs/remediation/r35-constraints.md).
--
-- The writers resolve every referenced ID inside the authorized project or
-- workspace since DAT-005 (docs/remediation/dat-005.md); the database now
-- enforces the same rules:
--
--   task_status_project         Task (statusId, projectId) -> StatusColumn (id, projectId)
--   recurring_template_project  RecurringTaskConfig (templateId, projectId) -> TaskTemplate (id, projectId)
--   time_entry_workspace        TimeEntry (projectId, workspaceId) -> Project (id, workspaceId)
--   time_entry_task_project     TimeEntry (taskId, projectId) -> Task (id, projectId)
--   task_dependency_project     TaskDependency CHECK (blockedTaskId <> blockingTaskId),
--                               and triggers: both tasks of a dependency share a project
--   task_label_project          triggers: a task's label belongs to the task's project
--   custom_field_value_project  triggers: a value's field belongs to the task's project
--
-- It never repairs data. If a stored row breaks a rule it stops before
-- changing anything and names each rule with its row count and up to ten
-- row IDs. Find every row and its proposed repair with the read-only report
-- (docs/remediation/dat-005.md), repair them, then run
--
--   prisma migrate resolve --rolled-back 20261106120000_reference_integrity_constraints
--
-- and deploy again.
--
-- Locks: the tables below are locked against writes (reads continue) for the
-- whole migration, which is one transaction. The shipped entrypoint applies
-- migrations before the server starts, so nothing waits there. Measured on the
-- performance fixture (100k tasks), see the doc.

LOCK TABLE "Project", "StatusColumn", "Label", "CustomField", "TaskTemplate",
  "Task", "TaskLabel", "CustomFieldValue", "TaskDependency",
  "RecurringTaskConfig", "TimeEntry"
  IN SHARE ROW EXCLUSIVE MODE;

DO $precheck$
DECLARE
  rule record;
  total bigint;
  sample text;
  found text := '';
  failed int := 0;
BEGIN
  FOR rule IN
    SELECT * FROM (VALUES
      ('task_status_project', 'Task',
       'a task''s status column belongs to the task''s project',
       $q$SELECT t.id FROM "Task" t JOIN "StatusColumn" s ON s.id = t."statusId"
          WHERE s."projectId" <> t."projectId"$q$),
      ('recurring_template_project', 'RecurringTaskConfig',
       'a recurring schedule uses a template of its own project',
       $q$SELECT rc.id FROM "RecurringTaskConfig" rc JOIN "TaskTemplate" tt ON tt.id = rc."templateId"
          WHERE tt."projectId" <> rc."projectId"$q$),
      ('time_entry_workspace', 'TimeEntry',
       'a time entry''s project belongs to the entry''s workspace',
       $q$SELECT e.id FROM "TimeEntry" e JOIN "Project" p ON p.id = e."projectId"
          WHERE p."workspaceId" <> e."workspaceId"$q$),
      ('time_entry_task_project', 'TimeEntry',
       'a time entry with both a task and a project names the task''s project',
       $q$SELECT e.id FROM "TimeEntry" e JOIN "Task" t ON t.id = e."taskId"
          WHERE e."projectId" IS NOT NULL AND t."projectId" <> e."projectId"$q$),
      ('task_dependency_project', 'TaskDependency',
       'a dependency links two different tasks of the same project',
       $q$SELECT d.id FROM "TaskDependency" d
          JOIN "Task" a ON a.id = d."blockedTaskId" JOIN "Task" b ON b.id = d."blockingTaskId"
          WHERE a."projectId" <> b."projectId" OR d."blockedTaskId" = d."blockingTaskId"$q$),
      ('task_label_project', 'TaskLabel',
       'a task''s label belongs to the task''s project',
       $q$SELECT tl.id FROM "TaskLabel" tl
          JOIN "Task" t ON t.id = tl."taskId" JOIN "Label" l ON l.id = tl."labelId"
          WHERE l."projectId" <> t."projectId"$q$),
      ('custom_field_value_project', 'CustomFieldValue',
       'a custom-field value''s field belongs to the task''s project',
       $q$SELECT v.id FROM "CustomFieldValue" v
          JOIN "Task" t ON t.id = v."taskId" JOIN "CustomField" f ON f.id = v."fieldId"
          WHERE f."projectId" <> t."projectId"$q$)
    ) AS r(key, tbl, description, query)
  LOOP
    EXECUTE format('SELECT count(*) FROM (%s) q', rule.query) INTO total;
    IF total > 0 THEN
      EXECUTE format('SELECT string_agg(id, '', '' ORDER BY id) FROM (SELECT id FROM (%s) q ORDER BY id LIMIT 10) s', rule.query)
        INTO sample;
      failed := failed + 1;
      found := found || format(E'\n  %s: %s row(s) in "%s" break the rule that %s; first IDs: %s',
        rule.key, total, rule.tbl, rule.description, sample);
    END IF;
  END LOOP;
  IF failed > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        E'Migration 20261106120000_reference_integrity_constraints changed nothing: %s rule(s) have stored rows that break them.%s\n'
        'Run the read-only report for every row and its proposed repair (each rule above is a check of the same name):\n'
        '  DATABASE_URL=... node packages/backend/dist/scripts/reference-integrity-report.js\n'
        'Repair the rows as docs/remediation/dat-005.md describes, then run\n'
        '  prisma migrate resolve --rolled-back 20261106120000_reference_integrity_constraints\n'
        'and deploy again. See docs/remediation/r35-constraints.md.',
        failed, found);
  END IF;
END
$precheck$;

-- ─── Same-project and same-workspace keys ────────────────

-- CreateIndex
CREATE UNIQUE INDEX "Project_id_workspaceId_key" ON "Project"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "StatusColumn_id_projectId_key" ON "StatusColumn"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_id_projectId_key" ON "Task"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskTemplate_id_projectId_key" ON "TaskTemplate"("id", "projectId");

-- These two sit next to the existing single-column keys, which reads and
-- Prisma relations keep using, and share their delete behavior.
-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_statusId_projectId_fkey" FOREIGN KEY ("statusId", "projectId") REFERENCES "StatusColumn"("id", "projectId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecurringTaskConfig" ADD CONSTRAINT "RecurringTaskConfig_templateId_projectId_fkey" FOREIGN KEY ("templateId", "projectId") REFERENCES "TaskTemplate"("id", "projectId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- A time entry keeps its single-column keys, which clear taskId or projectId
-- when the task or project is deleted. These two are checked at commit, after
-- those deletes have cleared the columns (an immediate check could run before
-- them and refuse the delete). Rows with a NULL taskId or projectId are not
-- checked (MATCH SIMPLE).
-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_taskId_projectId_fkey" FOREIGN KEY ("taskId", "projectId") REFERENCES "Task"("id", "projectId") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "Project"("id", "workspaceId") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- ─── Dependencies on the task itself ────────────────────

ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_not_self" CHECK ("blockedTaskId" <> "blockingTaskId");

-- ─── Same-project rows that link two project rows ────────
--
-- TaskLabel, CustomFieldValue and TaskDependency carry no projectId, so no
-- foreign key can compare the projects of the two rows they link. These
-- triggers compare them after each INSERT or UPDATE statement, for all of
-- its rows in one join (restore and bulk writes insert thousands at once; a
-- row trigger added about 13 us per row). They read the projectIds without
-- locking because those never change: the guards below refuse any change of
-- Task, Label or CustomField "projectId" (the application never moves these
-- rows between projects). A missing task, label or field is left to the
-- foreign keys, which are checked first.

CREATE FUNCTION check_task_label_project() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  task_id text;
  label_id text;
BEGIN
  SELECT n."taskId", n."labelId" INTO task_id, label_id
  FROM new_rows n JOIN "Task" t ON t.id = n."taskId" JOIN "Label" l ON l.id = n."labelId"
  WHERE l."projectId" <> t."projectId"
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'new row for relation "TaskLabel" violates constraint "TaskLabel_same_project": task % and label % belong to different projects', task_id, label_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'TaskLabel_same_project', TABLE = 'TaskLabel';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "TaskLabel_same_project_insert"
AFTER INSERT ON "TaskLabel" REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION check_task_label_project();

CREATE TRIGGER "TaskLabel_same_project_update"
AFTER UPDATE ON "TaskLabel" REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION check_task_label_project();

CREATE FUNCTION check_custom_field_value_project() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  task_id text;
  field_id text;
BEGIN
  SELECT n."taskId", n."fieldId" INTO task_id, field_id
  FROM new_rows n JOIN "Task" t ON t.id = n."taskId" JOIN "CustomField" f ON f.id = n."fieldId"
  WHERE f."projectId" <> t."projectId"
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'new row for relation "CustomFieldValue" violates constraint "CustomFieldValue_same_project": task % and field % belong to different projects', task_id, field_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'CustomFieldValue_same_project', TABLE = 'CustomFieldValue';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "CustomFieldValue_same_project_insert"
AFTER INSERT ON "CustomFieldValue" REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION check_custom_field_value_project();

CREATE TRIGGER "CustomFieldValue_same_project_update"
AFTER UPDATE ON "CustomFieldValue" REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION check_custom_field_value_project();

CREATE FUNCTION check_task_dependency_project() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  blocked_id text;
  blocking_id text;
BEGIN
  SELECT n."blockedTaskId", n."blockingTaskId" INTO blocked_id, blocking_id
  FROM new_rows n JOIN "Task" a ON a.id = n."blockedTaskId" JOIN "Task" b ON b.id = n."blockingTaskId"
  WHERE a."projectId" <> b."projectId"
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'new row for relation "TaskDependency" violates constraint "TaskDependency_same_project": tasks % and % belong to different projects', blocked_id, blocking_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'TaskDependency_same_project', TABLE = 'TaskDependency';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "TaskDependency_same_project_insert"
AFTER INSERT ON "TaskDependency" REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION check_task_dependency_project();

CREATE TRIGGER "TaskDependency_same_project_update"
AFTER UPDATE ON "TaskDependency" REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION check_task_dependency_project();

-- The project of a task, label or custom field is fixed when it is created.
CREATE FUNCTION refuse_project_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'update of relation "%" violates constraint "%_projectId_fixed": the project of % cannot change', TG_TABLE_NAME, TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_projectId_fixed', TABLE = TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "Task_projectId_fixed"
BEFORE UPDATE OF "projectId" ON "Task"
FOR EACH ROW WHEN (OLD."projectId" IS DISTINCT FROM NEW."projectId")
EXECUTE FUNCTION refuse_project_change();

CREATE TRIGGER "Label_projectId_fixed"
BEFORE UPDATE OF "projectId" ON "Label"
FOR EACH ROW WHEN (OLD."projectId" IS DISTINCT FROM NEW."projectId")
EXECUTE FUNCTION refuse_project_change();

CREATE TRIGGER "CustomField_projectId_fixed"
BEFORE UPDATE OF "projectId" ON "CustomField"
FOR EACH ROW WHEN (OLD."projectId" IS DISTINCT FROM NEW."projectId")
EXECUTE FUNCTION refuse_project_change();
