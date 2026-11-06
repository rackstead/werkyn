# Structural database constraints (R35)

The writers have validated references and values since DAT-005, DAT-012,
DAT-013 and the contract-validation fixes, and read-only reports list rows
stored before them. The database itself still accepted those rows. Two
migrations now enforce the rules that are clearly right and cheap to check.

There is no deployed installation with real data, so nothing is repaired.
Each migration first looks for stored rows that break its rules. If it finds
any, it stops before changing anything and reports, per rule, the number of
rows, up to ten row IDs, what the rule is, and which report or query lists
every row.

## Candidates

"App" is where the application already keeps the rule; "report" is the
existing read-only check that finds stored rows breaking it.

### Adopted

Migration `20261106120000_reference_integrity_constraints`. Report:
`reference-integrity-report` ([DAT-005](dat-005.md#detecting-and-repairing-legacy-data)),
whose checks have the same names as the rules below.

| Rule | Invariant | App | Constraint |
| --- | --- | --- | --- |
| `task_status_project` | A task's status column belongs to the task's project | task create, update, move, bulk update, duplicate, template instantiation, restore (`task-references.ts`, `restore-plan.ts`) | Composite FK `Task(statusId, projectId) -> StatusColumn(id, projectId)`, `ON DELETE RESTRICT`, next to `Task_statusId_fkey` |
| `recurring_template_project` | A recurring schedule uses a template of its own project | recurring create (template looked up in the project) | Composite FK `RecurringTaskConfig(templateId, projectId) -> TaskTemplate(id, projectId)`, `ON DELETE CASCADE`, next to `RecurringTaskConfig_templateId_fkey` |
| `time_entry_workspace` | A time entry's project is in the entry's workspace | time entry create/update (`assertEntryProjects`) | Composite FK `TimeEntry(projectId, workspaceId) -> Project(id, workspaceId)`, deferred (below) |
| `time_entry_task_project` | A time entry with a task and a project names the task's project | time entry create/update (`assertTaskInProject`) | Composite FK `TimeEntry(taskId, projectId) -> Task(id, projectId)`, deferred (below) |
| `task_dependency_project` | A dependency links two different tasks of one project | dependency add, restore | CHECK `TaskDependency_not_self` plus triggers reporting `TaskDependency_same_project` |
| `task_label_project` | A task's label belongs to the task's project | task create, bulk update, add label, duplicate, template instantiation, restore | Triggers reporting `TaskLabel_same_project` |
| `custom_field_value_project` | A value's field belongs to the task's project | value write, duplicate, restore | Triggers reporting `CustomFieldValue_same_project` |

Migration `20261106120100_value_range_constraints`. Report: the queries in
[Finding the rows](#finding-the-rows) below (the contract-validation doc
already listed the non-finite and `dueOffset` ones).

| Rule | Invariant | App | Constraint |
| --- | --- | --- | --- |
| `time_entry_hours` | Hours from 0.01 to 24, finite | `CreateTimeEntrySchema`/`UpdateTimeEntrySchema` | CHECK `TimeEntry_hours_range` |
| `user_rate_finite` | Rate finite and not negative | `SetUserRateSchema` (also caps new rates at `MAX_HOURLY_RATE`) | CHECK `UserRate_rate_finite` |
| `template_due_offset` | Due offset from 0 to 3650 days, or none | template schemas (`MAX_DUE_OFFSET_DAYS`) | CHECK `TaskTemplate_dueOffset_range` |
| `recurring_day_range` | `dayOfWeek` 0-6, `dayOfMonth` 1-31, or none | recurring schemas | CHECKs `RecurringTaskConfig_dayOfWeek_range`, `..._dayOfMonth_range` |
| `recurring_required_day` | WEEKLY/BIWEEKLY have `dayOfWeek`, MONTHLY has `dayOfMonth` | recurring create and update ([contract-validation](contract-validation.md#recurring-schedules)) | CHECK `RecurringTaskConfig_required_day` |
| `position_non_negative` | Positions of tasks, columns, custom fields, subtasks, wiki spaces and pages are not negative | every writer appends after the maximum or renumbers from 0; request schemas use `min(0)`; restore renumbers invalid positions | CHECK `<Table>_position_non_negative` on each of the six tables |

NaN compares greater than every number in PostgreSQL, Infinity included, so
the hours and rate checks also refuse non-finite values.

### Why these constraint types

- **Composite foreign keys** wherever both rows already carry the scoping
  column. They are added next to the existing single-column keys, which the
  Prisma relations keep using: a composite relation would make Prisma join on
  both columns, and reads of a legacy row (the "Unavailable status"
  placeholder of [DAT-005](dat-005.md#existing-rows)) would then fail instead
  of degrading. Each needs a unique index on the referenced `(id, scope)` pair:
  `StatusColumn(id, projectId)`, `TaskTemplate(id, projectId)`,
  `Task(id, projectId)` and `Project(id, workspaceId)`. The task index keeps
  `id` first, so it cannot serve a project's task list as an index-only scan
  (see the board-order index in [p02a.md](p02a.md)). The keys use
  `ON UPDATE RESTRICT`: ids never change, and a referenced column or template
  cannot move to another project.
- **Deferred time-entry keys.** A time entry keeps its single-column keys,
  which clear `taskId` or `projectId` when the task or project is deleted.
  The composite keys are `DEFERRABLE INITIALLY DEFERRED` so they are checked
  at commit, after those deletes have cleared the columns; checked
  immediately, the composite key could fire before the clearing one and refuse
  a legitimate delete, depending on trigger order. Rows with a NULL `taskId`
  or `projectId` are not checked (MATCH SIMPLE).
- **Triggers** only for TaskLabel, CustomFieldValue and TaskDependency. These
  rows link two project rows but carry no `projectId`, so no key can compare
  the two projects without adding a column that every writer and the restore
  would have to fill. Statement-level triggers (`<Table>_same_project_insert`
  and `_update`) check every row an INSERT or UPDATE statement wrote in one
  join over its transition table, and refuse the statement with SQLSTATE
  23514 and `<Table>_same_project` as the constraint name. Set-based checks
  keep bulk writes such as a restore fast: on the fixture, one statement
  inserting 50k task labels took 1.11-1.25 s with the statement trigger and
  1.09-1.14 s without it, where a per-row trigger took 1.78-1.81 s against
  1.08-1.15 s (four alternating runs each). The triggers read the projects
  without locking, which is race-free only because they cannot change: guard
  triggers (`Task_projectId_fixed`, `Label_projectId_fixed`,
  `CustomField_projectId_fixed`) refuse any change of `projectId` on tasks,
  labels and custom fields. The application never moves these rows between
  projects; a future "move task to another project" feature has to replace
  these guards. A missing task, label or field is left to the existing
  foreign keys, which are checked first.
- **CHECK** for single-row rules.

### Not adopted here (follow-ups)

| Candidate | Why not now |
| --- | --- |
| `task_assignee_access`, `subtask_assignee_access`, `chat_member_workspace` | They depend on mutable membership. Membership removal and ADMIN demotion clear assignments in the same transaction under the DAT-005 lock order. A database rule would need triggers on member deletes and role changes that join that lock order; it needs its own design and concurrency tests. |
| A time entry with a task but no project | Not covered by MATCH SIMPLE. A CHECK cannot be deferred and would refuse project deletes whose SET NULL runs before the task cascade. Needs a deferred constraint trigger. The report's `time_entry_task_project` still lists such rows. |
| Custom-field value type and options (`custom-field-value-report`) | The rules (`checkCustomFieldValue`) depend on the field's type and options, which change; option edits migrate values. Enforcing them needs a SQL port of the shared validator or a trigger on both tables. |
| Date-only text columns (`dueDate`, `startDate`, `date`, `effectiveFrom`, schedule dates) | A real-calendar-day check needs a SQL function, and the scheduler and template instantiation compute dates internally (see DAT-018); verify those writers first. |
| Rate at most 1,000,000,000 | The request schema caps new rates, but time reports deliberately keep pricing larger finite legacy rates and refuse only costs they cannot represent ([time-report-rounded-costs.md](time-report-rounded-costs.md), tested with rates up to 1e308). A cap in the database would contradict that decision. |
| Currency code `^[A-Z]{3}$` | Time reports deliberately read stored lower-case and malformed codes (`chf`, `ZZZ`, `1$X`; DAT-019, `time-report-rates` and `time-report-rounded-costs` tests). Left with that decision, as for the rate cap. |
| Enumerated strings (`Attachment.entityType`, `Task.reminder`, `NotificationPreference.dueDateReminderTiming`) | Validated by the request schemas, but no report exists for them; cheap follow-up. |
| `user_rate_workspace` | Not an invariant: a former member keeps rates for historical reports. |
| `task_template_reference` | Not an invariant: template lists may name deleted columns, labels or departed members; instantiation and the editor use the valid subset. |
| Unique ordering keys | The application tolerates repeated positions ([DAT-012](dat-012.md)) and renumbers row by row, which an immediate unique constraint would refuse midway. |
| `SsoConnector.position >= 0` | The SSO schema accepts negative positions; a check would change behavior. |
| `WikiPageShare.createdById` has no foreign key | Adding one needs a decision on what deleting the creator does to the share. |

## When a migration finds rows that break a rule

The migration is one transaction. It locks the tables it changes against
writes, checks every rule, and if any rule has rows it raises an error such as:

```
Migration 20261106120000_reference_integrity_constraints changed nothing: 2 rule(s) have stored rows that break them.
  task_status_project: 3 row(s) in "Task" break the rule that a task's status column belongs to the task's project; first IDs: a1, a2, a3
  task_label_project: 14 row(s) in "TaskLabel" break the rule that a task's label belongs to the task's project; first IDs: b01, ..., b10
Run the read-only report for every row and its proposed repair (each rule above is a check of the same name):
  DATABASE_URL=... node packages/backend/dist/scripts/reference-integrity-report.js
Repair the rows as docs/remediation/dat-005.md describes, then run
  prisma migrate resolve --rolled-back 20261106120000_reference_integrity_constraints
and deploy again. See docs/remediation/r35-constraints.md.
```

Nothing is created or changed (the precheck runs before any change, and the
migration is one transaction, so a later failure also undoes everything
before it). `prisma migrate deploy` exits with P3018 and
the container does not start; later deploys stop with P3009 until the
migration is marked rolled back. Repair the rows, run the `resolve` command
the message names and deploy again.

### Finding the rows

Reference rules: `reference-integrity-report` (above). Value rules:

```sql
-- time_entry_hours
SELECT id FROM "TimeEntry" WHERE NOT ("hours" >= 0.01 AND "hours" <= 24);
-- user_rate_finite
SELECT id FROM "UserRate" WHERE NOT ("rate" >= 0 AND "rate" < 'Infinity');
-- template_due_offset
SELECT id FROM "TaskTemplate" WHERE "dueOffset" NOT BETWEEN 0 AND 3650;
-- recurring_day_range
SELECT id FROM "RecurringTaskConfig" WHERE "dayOfWeek" NOT BETWEEN 0 AND 6 OR "dayOfMonth" NOT BETWEEN 1 AND 31;
-- recurring_required_day
SELECT id FROM "RecurringTaskConfig"
WHERE ("frequency" IN ('WEEKLY', 'BIWEEKLY') AND "dayOfWeek" IS NULL) OR ("frequency" = 'MONTHLY' AND "dayOfMonth" IS NULL);
-- position_non_negative (and likewise StatusColumn, CustomField, Subtask, WikiSpace, WikiPage)
SELECT id FROM "Task" WHERE "position" < 0;
```

Usual repairs: re-enter the hours or rate through the API, or delete the row;
set `dueOffset` to NULL or 3650; set the missing or out-of-range schedule day
through the API (an edit that sends the day is accepted); renumber positions
with a complete reorder of the column, field list, subtasks or wiki siblings.

## Effect on the application

None for valid requests: every rule was already enforced before the write.
A write that still broke a rule would now fail instead of storing the row:
composite keys as the existing 409 "The request conflicts with a related
record", checks and triggers as a 500 (both are logged). The read-side
tolerance for legacy rows (placeholder status, dropped cross-project labels,
skipped non-finite hours) is unchanged; on a migrated database it can only
meet rows written with the constraints bypassed.

Backup restore inserts each batch in table order (projects, columns, labels,
fields, tasks, then labels, values and dependencies of tasks), so every
immediate key and trigger finds the rows it references; the restore plan
already drops or remaps foreign references. Time entries are not restored, so
the deferred keys do not apply to it.

## Locks and timing

Measured on the performance fixture (`scripts/perf/seed.ts`, scale 1: 100k
tasks, 125k task labels, 180k custom-field values, 120k time entries), warm
cache, PostgreSQL 16:

| Migration | Duration (two runs) | Longest statements |
| --- | --- | --- |
| `20261106120000_reference_integrity_constraints` | 297 ms, 307 ms | precheck 148 ms, `Task(id, projectId)` index 61 ms, time-entry task key 51 ms |
| `20261106120100_value_range_constraints` | 84 ms, 75 ms | precheck 23 ms, hours check 10 ms, task position check 9 ms |

A probe session sent a task update, a read of a project's tasks and a task
label insert every few milliseconds during each deploy. Writes to the locked
tables waited for the running migration: a task update up to 289 ms and
301 ms. Reads never waited more than 2.6 ms (the second migration's CHECKs
take ACCESS EXCLUSIVE locks, so reads can wait for it too, up to its 80 ms).
Both migrations run before the server starts in the shipped entrypoint.
`NOT VALID` followed by `VALIDATE` would only shorten the locks if each ran in
its own migration (Prisma runs a migration as one transaction), which is not
worth it at these durations.

Afterwards, deleting the fixture's largest project (11,733 tasks, 2,847 time
entries, rolled back) took 1.12-1.27 s against 1.07-1.27 s before, plus
167-175 ms at commit for the deferred time-entry keys (one index probe per
deleted task and cleared entry).

## Tests

`packages/backend/tests/migrations/structural-constraints.test.mjs` (CI step
"Structural constraint upgrade") builds two disposable fixtures, one after the
other, in an empty database migrated to the migration before these two:

- A legacy fixture with rows that break every rule, written with raw SQL. The
  first migration refuses with the expected rule names, counts and the first
  ten IDs, and the schema and data are unchanged; the report it names lists
  the same rows. With those rows repaired, the first migration applies and
  the second refuses in the same way. With everything repaired both apply.
- Each migration is one transaction: Prisma sends the file as one
  multi-statement query (PostgreSQL refuses `LOCK TABLE` outside a
  transaction block, so these migrations could not run otherwise). The gate
  makes the last statement of each migration fail, after every other one has
  run, by creating its trigger or check beforehand; the catalog and data are
  unchanged afterwards and the migration applies once that object is gone.
- A clean populated fixture migrates with identical row data.
- After the migration, raw SQL that breaks each constraint (46 statements)
  is refused with the constraint's name, deferred keys also at commit, and
  the boundary values are accepted. Deleting a task, project, column,
  template or workspace keeps its behavior, including time entries losing
  their task or project.
- `prisma migrate diff --exit-code` from the migrated database to
  `schema.prisma` finds no drift: the composite keys and their indexes are
  declared as relations, and deferrability, CHECKs and triggers are outside
  Prisma's model, so `prisma migrate dev` does not try to drop them.

```bash
MIGRATION_TEST_DATABASE_URL=postgresql://.../<empty-db> \
  pnpm --filter @pm/backend exec node --import tsx --test tests/migrations/structural-constraints.test.mjs
```

The integration tests that check how reads tolerate legacy rows create those
rows with the constraints bypassed (`tests/integration/support/legacy-rows.mjs`).
