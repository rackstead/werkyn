# Request contract validation (DAT-016, DAT-017, SEC-020)

The shared request schemas in `packages/shared/src/schemas` now check values,
not only their shape.

## Calendar dates

Every date-only input (task, subtask and template due and start dates, the
task list `dueBefore`/`dueAfter` filters, time entry dates, time entry and
report ranges, rate `effectiveFrom`, and schedule `startDate`/`endDate`) uses
`dateOnly()` from `common.ts`. A value must be `YYYY-MM-DD`, name a real day
(`2026-02-31`, `2027-02-29` and `2026-13-01` are rejected) and fall in the
years 1900 to 2999. Years 0000-0099 used to reach `Date.UTC`, which reads
them as 1900-1999. Invalid dates return HTTP 400 with the field name.

## Recurring schedules

A schedule edit must leave the schedule with the day its frequency needs, the
same rule as on create: WEEKLY and BIWEEKLY need `dayOfWeek`, MONTHLY needs
`dayOfMonth`. Omitted fields keep their stored values, so switching a WEEKLY
schedule to BIWEEKLY keeps its weekday, while switching a DAILY schedule to
MONTHLY without `dayOfMonth`, or clearing the day a frequency needs, returns
400. Edits that do not touch frequency or day (pausing, the end date) still work
on rows saved before this check without their day, and sending the day repairs
such a row.

## Text

`singleLineText()` (names, titles, search terms) rejects every C0 control
character except TAB. `multilineText()` (descriptions, comment bodies) also
allows line feed and carriage return. U+0000 in particular used to reach
PostgreSQL, which cannot store it, and fail with a 500. The chat, SSO, mail
and backup schemas are owned by other work and are not changed here; a NUL
in those fields is still stopped by the database and reported as a 400 (see
below).

## Numbers

Rates must be finite and at most 1,000,000,000 per hour (`1e400` in JSON
parses as Infinity and used to reach Prisma). Hours must be finite.
Positions, invite `maxUses`, workspace `maxMembers` and page numbers stay
within PostgreSQL's integer range, and a template `dueOffset` is at most 3650
days. Custom field number values must be finite.

## Errors from the database

The global error handler maps Prisma errors to generic responses and never
returns Prisma's message, which quotes the query, its arguments, source file
paths and database error text. Unique conflicts return 409, missing records
404, foreign key conflicts 409, values the column or database cannot accept
(including PostgreSQL data exceptions such as U+0000 in text or JSON) 400,
and everything else 500 with "An unexpected error occurred". The full error
is still logged.

## Legacy non-finite values in time reports

`TimeEntry.hours` and `UserRate.rate` are `double precision` columns, which can
hold NaN and ±Infinity through direct database writes. Prisma cannot read
those values and used to fail the whole report. The report now leaves such
entries out and counts them in `summary.skippedEntries`; a non-finite rate
prices nothing, so the dates it covers count as unrated. The bound used for
"finite" is ±1e308 because Prisma sends query numbers with 16 significant
digits; the few finite values beyond it are treated the same way. Other reads
of such rows (the time entry list, rate list) still fail, now with a generic
500. Find affected rows with:

```sql
SELECT id FROM "TimeEntry" WHERE hours IN ('NaN', 'Infinity', '-Infinity');
SELECT id FROM "UserRate" WHERE rate IN ('NaN', 'Infinity', '-Infinity');
```

## Compatibility

Clients that sent impossible dates, control characters, schedule edits without
the required day, or out-of-range numbers now receive 400 instead of a stored
value or a 500. Stored values are not migrated: a row that already holds such a
value keeps it until an edit sends the field again.

## Tests

```sh
pnpm --dir packages/shared test
TEST_DATABASE_URL=<disposable-url> pnpm --dir packages/backend exec node --import tsx --test tests/integration/contract-validation.test.mjs
```
