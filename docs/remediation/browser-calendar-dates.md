# Browser calendar dates

The dashboard Upcoming Dates and My Tasks widgets use the browser's local
calendar date for today, as the existing timesheet and time-tracking widget do.
They reuse `formatDateISO` and `parseDateISO` from the existing time utilities;
those utilities and their callers keep their behavior and import paths.

Upcoming Dates includes noncompleted tasks due from today through the seventh
following civil day, inclusive. Adding days uses calendar fields, so a daylight
saving transition does not shorten that window. Today/Tomorrow labels and task
click destinations remain unchanged.

My Tasks compares date-only deadlines with local today. The overdue group and
ordinary-row color use the same predicate: a deadline before today on a
noncompleted task. A task due today is not overdue merely because midnight has
passed. Completed tasks remain visible and clickable in their project group.
Labels parse valid calendar dates locally instead of converting UTC midnight
to the preceding day west of UTC. A historical invalid date uses its stored
text as a display fallback; this does not validate or repair legacy rows.

Both create and edit expiry controls in the file-sharing dialog use local
today as the date input's minimum. Submission still interprets a selected date
at local 23:59:59 and serializes that instant to ISO. Clearing still omits expiry
on create and sends null on edit. The minimum is a browser input constraint;
the API contract and stored expiry instants are unchanged.

These calculations update when the existing components render. No midnight
timer or subscription is added. API date-only validation still accepts real
dates in 1900–2999 ([contract-validation.md](contract-validation.md)). Existing
rate defaults and the rate dialog use UTC today; recurrence also explicitly
uses UTC ([dat-007.md](dat-007.md)). This browser correction does not change
rates, recurrence, financial policy, schemas or persisted dates.

`calendar-dates.test.tsx` renders the two actual dashboard widgets and
`share-file-dates.test.tsx` renders the real sharing dialog, with query/mutation
boundaries stubbed. The existing timezone harness verifies the actual process
zone for UTC, Tokyo, Sydney and Los Angeles. Cases cover both UTC date
boundaries, spring/fall DST windows, inclusive endpoints, local labels,
due-today/overdue consistency, completed/click controls, both input minima and
unchanged expiry/clearing payloads. These are component-boundary checks, not an
external-browser or live API test.
