# Typed dates

Typing a new date over a saved one in the project List's inline due date
editor saved the task with no due date. Chromium reports every intermediate
state of a date input as its value:

- `""` while a part is half typed: the first digit of a month or day typed over
  a date ("0" on the way to 03), or one part deleted. The input then reports
  bad input (`validity.badInput`); it is not empty.
- dates that mix typed and old parts: 2026-03-20, 2026-03-01 and 2026-03-15
  on the way from 2026-11-20 to 2027-03-15 (month/day/year order);
- partial years such as 0002-03-15.

`committedDate()` in `lib/date-input.ts` read every `""` as a cleared date.
Inputs that save on change therefore saved null at the first digit, or a date
the user never typed, and sent a request for each step.

## Behaviour

`committedDate()` reads `""` as cleared only when the input does not report
bad input. It checks the input it is given or, when none is given, the
focused date input.

`useDateInput` / `DateInput` (`components/shared/date-input.tsx`) commit a
date input as follows:

- A typed date is committed once, on Enter or when the input loses focus, and
  only when it is complete. Nothing is sent while typing.
- Focus leaving a half-typed edit keeps the saved date and shows it again.
  Chromium completes a half-typed part as focus leaves (a month "0" becomes
  01); that change is not treated as typed. A partial year is also kept back.
- Escape discards a typed edit and is kept from the panel; with nothing typed,
  Escape closes the panel as before.
- A date chosen in the browser's picker is committed at once, as before; so is
  the picker's Clear.
- Null is committed only by an explicit clear, or by an input emptied part by
  part when it loses focus. A typed date equal to the saved one sends nothing.
- A newer saved value (a refetch, another user) replaces the input unless
  something is being typed.

Users of these rules:

- `DatePicker`, used by the task panel's start date, due date and custom date
  fields and by the new-task dialog. Its clear button keeps focus in the
  input, so a date being typed is discarded rather than saved just before the
  clear.
- The List's bulk due date. It applies a typed date on Enter or blur.
  Previously a year-first browser applied 2027-03-01 to every selected task
  while 2027-03-15 was being typed.

The List's due-date and custom-field filters keep filtering as a date is typed.
They use the corrected `committedDate()`, so a half-typed part no longer drops
the filter.

## Limits

The List's inline due date and custom date cells (`columns.tsx`) still save
on change and close at the first complete date. With the corrected
`committedDate()` they no longer save null while typing. They do still save the
first complete intermediate date, for example 2026-03-20 when 03152027 is typed
over 2026-11-20, or 2026-11-01 when the day comes first. One Backspace no
longer clears them; on main it did, through the same `""`. They have no clear
control of their own, so clearing there is left to the browser picker's clear
control where it has one; the task panel's clear button and the bulk Clear
still clear. Using `DateInput` in those cells completes the fix.

Unchanged: the time report range, which already waits for complete dates, and
the date inputs of forms that submit with a button (share-link expiry,
recurring schedule start and end). Those forms still read a half-typed date
as empty when submitted.

## Tests

`date-input.test.tsx` and `date-picker.test.tsx` replay the values Chromium
141 reports while 2027-03-15 is typed over 2026-11-20 in three part orders:
month/day/year (en-US), day/month/year (de-DE) and year/month/day (ja-JP).
They check that:

- the date is saved once, on blur or Enter, never null;
- focus leaving a half-typed part (including Chromium's completion of it) or a
  partial year keeps the saved date;
- focus moving between parts does not end the edit;
- Escape discards the edit and keeps the panel open;
- a picked date and the picker's Clear save at once;
- an input emptied part by part saves null on blur;
- the clear button discards a date being typed.

`date-inputs.test.tsx` checks the List cell's half-typed guard and the bulk
input.

`packages/backend/tests/browser/date-input-typing.mjs` runs the production
build against the API and PostgreSQL in Chromium under the en-US, de-DE and
ja-JP languages (set through the environment, which decides the order of the
date parts on Linux). In each language it types into the task panel's due,
target and start dates (Tab or Enter), types half edits and leaves, types and
presses Escape, uses Clear, empties an input part by part, picks a date, uses
the bulk due date and uses the List cells. It records every write request. It fails on
any null that was not a clear and on any extra save; for the List cells it
reports the saved value. Run it from `packages/backend` after `pnpm build`:

```sh
TEST_DATABASE_URL=postgresql://…/werkyn_audit_… PLAYWRIGHT_MODULE=playwright \
  node --import tsx tests/browser/date-input-typing.mjs
```
