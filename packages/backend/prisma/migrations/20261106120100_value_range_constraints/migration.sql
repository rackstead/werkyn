-- Value range constraints (docs/remediation/r35-constraints.md).
--
-- The request schemas and writers already keep these values in range
-- (docs/remediation/contract-validation.md, dat-012.md, dat-013.md); the
-- database now refuses anything else:
--
--   time_entry_hours        TimeEntry.hours from 0.01 to 24 (no NaN or infinity)
--   user_rate_finite        UserRate.rate is finite and not negative
--   template_due_offset     TaskTemplate.dueOffset from 0 to 3650 days, or NULL
--   recurring_day_range     RecurringTaskConfig.dayOfWeek 0-6 and dayOfMonth 1-31, or NULL
--   recurring_required_day  WEEKLY/BIWEEKLY schedules have a dayOfWeek, MONTHLY ones a dayOfMonth
--   position_non_negative   Task, StatusColumn, CustomField, Subtask, WikiSpace and WikiPage positions are >= 0
--
-- It never repairs data. If a stored row breaks a rule it stops before
-- changing anything and names each rule with its row count and up to ten
-- row IDs. The doc lists the query that finds every row of each rule and the
-- usual repair. Repair them, then run
--
--   prisma migrate resolve --rolled-back 20261106120100_value_range_constraints
--
-- and deploy again.
--
-- Locks: adding a CHECK takes an ACCESS EXCLUSIVE lock on its table (reads
-- wait too) until the migration commits. The shipped entrypoint applies
-- migrations before the server starts, so nothing waits there. Measured on
-- the performance fixture (100k tasks), see the doc.

LOCK TABLE "TimeEntry", "UserRate", "TaskTemplate", "RecurringTaskConfig",
  "Task", "StatusColumn", "CustomField", "Subtask", "WikiSpace", "WikiPage"
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
      ('time_entry_hours', 'TimeEntry', 'hours are from 0.01 to 24',
       $q$SELECT id FROM "TimeEntry" WHERE NOT ("hours" >= 0.01 AND "hours" <= 24)$q$),
      ('user_rate_finite', 'UserRate', 'a rate is finite and not negative',
       $q$SELECT id FROM "UserRate" WHERE NOT ("rate" >= 0 AND "rate" < 'Infinity')$q$),
      ('template_due_offset', 'TaskTemplate', 'a due offset is from 0 to 3650 days',
       $q$SELECT id FROM "TaskTemplate" WHERE "dueOffset" NOT BETWEEN 0 AND 3650$q$),
      ('recurring_day_range', 'RecurringTaskConfig', 'dayOfWeek is 0 to 6 and dayOfMonth 1 to 31',
       $q$SELECT id FROM "RecurringTaskConfig"
          WHERE "dayOfWeek" NOT BETWEEN 0 AND 6 OR "dayOfMonth" NOT BETWEEN 1 AND 31$q$),
      ('recurring_required_day', 'RecurringTaskConfig',
       'a WEEKLY or BIWEEKLY schedule has a dayOfWeek and a MONTHLY one a dayOfMonth',
       $q$SELECT id FROM "RecurringTaskConfig"
          WHERE ("frequency" IN ('WEEKLY', 'BIWEEKLY') AND "dayOfWeek" IS NULL)
             OR ("frequency" = 'MONTHLY' AND "dayOfMonth" IS NULL)$q$),
      ('position_non_negative', 'Task', 'a position is not negative',
       $q$SELECT id FROM "Task" WHERE "position" < 0$q$),
      ('position_non_negative', 'StatusColumn', 'a position is not negative',
       $q$SELECT id FROM "StatusColumn" WHERE "position" < 0$q$),
      ('position_non_negative', 'CustomField', 'a position is not negative',
       $q$SELECT id FROM "CustomField" WHERE "position" < 0$q$),
      ('position_non_negative', 'Subtask', 'a position is not negative',
       $q$SELECT id FROM "Subtask" WHERE "position" < 0$q$),
      ('position_non_negative', 'WikiSpace', 'a position is not negative',
       $q$SELECT id FROM "WikiSpace" WHERE "position" < 0$q$),
      ('position_non_negative', 'WikiPage', 'a position is not negative',
       $q$SELECT id FROM "WikiPage" WHERE "position" < 0$q$)
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
        E'Migration 20261106120100_value_range_constraints changed nothing: %s rule(s) have stored rows that break them.%s\n'
        'docs/remediation/r35-constraints.md lists the query that finds every row of each rule and its usual repair.\n'
        'Repair the rows, then run\n'
        '  prisma migrate resolve --rolled-back 20261106120100_value_range_constraints\n'
        'and deploy again.',
        failed, found);
  END IF;
END
$precheck$;

-- NaN is greater than every number, Infinity included, in PostgreSQL, so
-- neither check admits a non-finite value. Rates have no upper bound here:
-- the request schema caps new rates at 1,000,000,000, and time reports keep
-- handling larger finite legacy rates (docs/remediation/time-report-rounded-costs.md).
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_hours_range" CHECK ("hours" >= 0.01 AND "hours" <= 24);
ALTER TABLE "UserRate" ADD CONSTRAINT "UserRate_rate_finite" CHECK ("rate" >= 0 AND "rate" < 'Infinity');
ALTER TABLE "TaskTemplate" ADD CONSTRAINT "TaskTemplate_dueOffset_range" CHECK ("dueOffset" BETWEEN 0 AND 3650);
ALTER TABLE "RecurringTaskConfig"
  ADD CONSTRAINT "RecurringTaskConfig_dayOfWeek_range" CHECK ("dayOfWeek" BETWEEN 0 AND 6),
  ADD CONSTRAINT "RecurringTaskConfig_dayOfMonth_range" CHECK ("dayOfMonth" BETWEEN 1 AND 31),
  ADD CONSTRAINT "RecurringTaskConfig_required_day" CHECK (
    ("frequency" NOT IN ('WEEKLY', 'BIWEEKLY') OR "dayOfWeek" IS NOT NULL)
    AND ("frequency" <> 'MONTHLY' OR "dayOfMonth" IS NOT NULL)
  );
ALTER TABLE "Task" ADD CONSTRAINT "Task_position_non_negative" CHECK ("position" >= 0);
ALTER TABLE "StatusColumn" ADD CONSTRAINT "StatusColumn_position_non_negative" CHECK ("position" >= 0);
ALTER TABLE "CustomField" ADD CONSTRAINT "CustomField_position_non_negative" CHECK ("position" >= 0);
ALTER TABLE "Subtask" ADD CONSTRAINT "Subtask_position_non_negative" CHECK ("position" >= 0);
ALTER TABLE "WikiSpace" ADD CONSTRAINT "WikiSpace_position_non_negative" CHECK ("position" >= 0);
ALTER TABLE "WikiPage" ADD CONSTRAINT "WikiPage_position_non_negative" CHECK ("position" >= 0);
