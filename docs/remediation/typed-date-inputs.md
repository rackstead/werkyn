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
- Escape discards a typed edit and does not reach the panel or dialog. The
  input carries `data-pending-edit` while an edit is pending, and `Dialog`
  leaves such an Escape to it. With nothing typed, Escape closes the panel or
  dialog as before.
- A date chosen in the browser's picker is committed at once, as before; so is
  the picker's Clear.
- Null is committed only by an explicit clear, or by an input emptied part by
  part when it loses focus. A typed date equal to the saved one sends nothing.
- A clear button next to the input takes `clearProps`. Focus moving to it (a
  click, or Tab) keeps the typed edit, and using it discards that edit and
  sends only null. Leaving the button any other way, or pressing Escape there,
  settles the edit as a blur of the input would.
- A newer saved value (a refetch, another user) replaces the input unless
  something is being typed.

Users of these rules:

- `DatePicker`, used by the task panel's start date, due date and custom date
  fields and by the new-task dialog, with its clear button.
- The List's bulk due date, with its Clear button. It applies a typed date on
  Enter or blur. Previously a year-first browser applied 2027-03-01 to every
  selected task while 2027-03-15 was being typed.
- The List's inline due date and custom date cells. They keep the editor open
  while typing, commit once on Enter or blur, and support deliberate clearing
  by emptying every part or using the browser picker's Clear. Escape discards
  the pending edit; a second Escape exits the editor.

Inline cells for the same identity, task and field share their pending save
queue across row and route remounts and send committed edits in order. A quick
correction back to the old date is
therefore saved even before the task has refetched. Failed saves can be
retried; a newer server date received during a failed save is shown when the
editor reopens. A successful local write takes precedence over snapshots
already seen while it was pending. Already committed edits continue saving if the row or route
unmounts. Other inline field types keep their existing save behavior.
Queues are removed once no mounted cell or pending save remains. Pending
edits are not dispatched after an identity transition.

Clicking a side panel's backdrop blurs the focused field before dismissing
the panel. A complete typed date is therefore committed before its input
unmounts; an unfinished edit keeps the stored value, as on any other blur.

The List's due-date and custom-field filters keep filtering as a date is typed.
They use the corrected `committedDate()`, so a half-typed part no longer drops
the filter.

## Limits

Unchanged: the time report range, which already waits for complete dates, and
the date inputs of the recurring schedule's start and end, a form that submits
with a button. That form still reads a half-typed date as empty when
submitted. The share-link expiry form now refuses a half-typed date; see
[share-expiry-typed-date.md](share-expiry-typed-date.md).

## Tests

`date-input.test.tsx` and `date-picker.test.tsx` replay the values Chromium
141 reports while 2027-03-15 is typed over 2026-11-20 in three part orders:
month/day/year (en-US), day/month/year (de-DE) and year/month/day (ja-JP).
They check that:

- the date is saved once, on blur or Enter, never null;
- focus leaving a half-typed part (including Chromium's completion of it) or a
  partial year keeps the saved date;
- focus moving between parts does not end the edit;
- Escape discards the edit and keeps the panel or dialog open;
- a picked date and the picker's Clear save at once;
- an input emptied part by part saves null on blur;
- the clear button discards a date being typed, after a click or after Tab
  moved to it, and focus moving on past it saves the date.

`date-inputs.test.tsx` checks due and custom inline cells in all three part
orders, Enter/blur, incomplete dates, Escape, deliberate clearing, required
custom fields and picker changes, as well as the bulk input and Clear.
Delayed-response cases cover correction back to the old value, stale refetches,
request ordering, failed-write retries and queued edits surviving unmount.
Remount cases verify that a new edit cannot overtake an older queued edit;
identity-transition cases verify that the queue cannot cross accounts.
`slideover.test.tsx` verifies that backdrop dismissal settles complete,
incomplete and deliberately cleared date edits before the panel unmounts.

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
