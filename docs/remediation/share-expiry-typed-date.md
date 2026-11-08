# Share link expiry and half-typed dates

The Drive share dialog read its expiry date input's `value` when Create or
Save was pressed. While a date is being typed, Chromium reports that value
as `""` (a part half typed, or one part deleted) or as a partial year such as
`0020-03-14` (see [typed-date-inputs.md](typed-date-inputs.md)). So:

- **Create** treated `""` as "no expiry" and made a public link that never
  expires. A partial year made a link that had already expired.
- **Save** (Change expiration) sent `expiresAt: null` and showed "Expiration
  removed". This happened for a half-typed date, for one Backspace, and for
  Save pressed without typing, because the field opened empty.

In each case the user believed they had set an expiry. In real Chromium
(en-US, de-DE and ja-JP part orders), main sent `expiresAt: null` for each
of those Save cases and stored year-0020 expiries.

## Behaviour

### The date field (`useDateField`)

`useDateField` (`components/shared/date-input.tsx`) is the date input of a
form that is sent with a button. It reads the input with the same rules as
`DateInput`. Its `dateInputContent()` in `lib/date-input.ts` is built on
`committedDate()`, and gives one of three results:

- empty;
- a complete date (years 1900–2999);
- incomplete: a part half typed or deleted, or a year outside that range.

`DateInput` itself commits on Enter or blur and reverts a half-typed edit. That
suits fields that save themselves. In a form it would turn a half-typed expiry
back into the earlier value at the press on Create, which is the bug again.

Chromium behaves in three ways that shape this:

- It fires no input event while the parts of an empty date input are typed.
  The value stays `""` until every part has one.
- A lone month "0" is not even bad input until focus leaves the input.
- When focus leaves the input, it completes a half-typed part (month "0"
  becomes 01). It also dispatches the click to a button that was disabled at
  mousedown and enabled by that completion.

So the field is read again on every key and on blur, and `read()` reads the
input itself when the form is sent. The submit button takes `submitProps`. A
click whose own press changed what the input holds sends nothing: the
completed date is now shown, and a second click sends it. This is why Create
and Save are marked `aria-disabled` rather than `disabled` while the date is
incomplete. A disabled button gets no press, so the check could not run, but
it still gets that click.

A click can also come with no press and leave focus in the input:
`element.click()`, as some assistive technology and automation send it.
Nothing has settled the input then, and a lone month "0" in an empty input
still reads as empty, so Create made a link with no expiry. `read()`
therefore settles the input itself before reading it: it moves focus out of
the input, and Chromium marks or completes the half-typed part. If that
changed what the input holds, the click sends nothing. This follow-up came
from finding M1 of the PR #211 review.

That blur leaves focus on `document.body` when the activation did not focus
the button. If the settled value is incomplete, focus returns to the date
input and the "Enter a complete date." alert stays, so Tab is not required
to reach the field. A keyboard activation that already focused the button
is left there. A successful Create or Save does not move focus onto the
input.

A double-click on Save, or on Remove expiration, used to send the same
request twice: the second click came before the mutation reported it was
pending. The dialog now sends a given request once while it is in flight.
After a failure, the same request can be sent again.

### Create

- Create sends an expiry only when the date is complete and not before local
  today. While the date is incomplete or in the past, Create refuses (it is
  marked disabled), and the note under the input says why: "Enter a complete
  date." or "Choose today or a later date."
- A link without an expiry needs the date input to be empty. The note then
  says so: "No expiration: the link works until you disable or remove it."
  A "Clear date" button empties a half-typed or complete date, including the
  half-typed parts that Chromium keeps showing.
- "Create another link" now opens the same form, so every new link shows the
  expiry choice. It used to create a link at once, with whatever the expiry
  and password fields of another link's editor held.
- The success message states what the server stored: "Share link created.
  It never expires." or "… It expires on <date>.". Errors are shown.

### Change an existing link's expiry

- The editor opens with the link's current expiry as a local date, or empty.
  Save sends only a complete date that is not before today and differs from
  the current one. An empty, half-typed or unchanged input sends nothing.
- Removing the expiry takes the "Remove expiration" button, shown when the
  link has an expiry. It sends `expiresAt: null` and discards any typed date.
- The message states the stored expiry from the server's response ("This link
  now never expires.", "… now expires on <date>."). Failures are shown, and
  the editor stays open.
- A link whose expiry has passed is labelled "Expired <date>".
- In a dialog for several files, the dialog's own copies of the links take
  the server's response after each change: expiry, password and enabled.
  Before, they kept their old values.

### Time zones

A chosen date `D` means the end of `D` in the browser's zone: local
`D T23:59:59`, sent as UTC. The input's minimum is local today, and the editor
shows a stored expiry as its local date. Tests run the dialog in UTC, Tokyo,
Sydney, Los Angeles, Kiritimati (UTC+14), Pago Pago (UTC−11) and New York.
For New York they cover the 2026 spring and fall days and the 2027 spring day.
At 2026-11-01T10:30Z, Kiritimati is already on 2 November and Pago Pago is
still on 31 October; each zone's minimum is its own today. Local today is
accepted; the day before it is refused.

## API

The share link and invitation schemas use a new `futureExpiry()`
(`packages/shared/src/schemas/common.ts`). It accepts an `isoDateTime()` that
is still in the future when the request is checked, and no later than
`LATEST_EXPIRY`, 3000-01-02T00:00:00.000Z. That is the end of 2999-12-31,
the last date a date-only input accepts, in every zone (UTC−12 ends it at
3000-01-01T11:59:59Z), rounded up to UTC midnight.

| Request | `expiresAt` omitted | `null` | `""`, malformed, not in the future, or after `LATEST_EXPIRY` |
|---|---|---|---|
| `POST /api/workspaces/:wid/files/share-links` | link never expires (unchanged) | 400 (unchanged) | 400 |
| `PATCH /api/workspaces/:wid/file-share-links/:lid` | expiry unchanged (unchanged) | expiry removed (unchanged) | 400, nothing changed |
| `POST /api/workspaces/:wid/invites` | invitation never expires (unchanged) | 400 (unchanged) | 400 |

The only change visible to API clients is that an expiry in the past, or
after `LATEST_EXPIRY`, is now refused with 400 ("Expiration must be in the
future", "Expiration must be no later than 3000-01-02T00:00:00.000Z"):

- On main, a past expiry made a link or invitation that never worked, and
  updating a link to a past expiry ended it at once. To end a link now, set
  `enabled: false` or delete it; to end an invitation, revoke it.
- `""` and malformed values were already refused by `isoDateTime()`.
- `null` on an update remains the one way to remove an expiry. An omitted
  field still leaves it unchanged.

Two existing tests ended a link by sending a past expiry. They now check that
the request is refused, and set the expiry in the database instead, as time
passing would.

## Other expiry and lifetime fields

- **Wiki share links** have no expiry.
- **Workspace invitations** have no expiry input in the app. `invite-list.tsx`
  and the admin `invite-settings.tsx` only display it. The API rule above
  applies to clients that send one.
- **API keys** choose their lifetime from a list (1, 7, 30, 90 or 365 days,
  or "Never expires"). The request always carries `expiresInDays`: a number,
  or `null` for the explicit "Never expires". An omitted field means 30 days,
  and `""` or values outside 1–365 are refused. Nothing is typed, so no change
  is needed. The integration test now also checks `""`.
- The other date inputs are a recurring schedule, report ranges, filters and
  task dates. None of them controls access.

## Tests

- `share-expiry-typing.test.tsx` renders the real dialog with the query and
  mutation boundaries stubbed. It replays the values Chromium reports while
  2027-03-15 is typed into an empty input (Create) and over a saved one
  (Save), in month/day/year, day/month/year and year/month/day order. It
  checks that:
  - no request leaves a link without an expiry, and every expiry sent is a
    date the input showed;
  - Create and Save refuse incomplete and past dates;
  - a press that completes a half-typed part sends nothing, and so does a
    click that leaves focus in the input when settling the input changes it;
  - a refused focus-less click whose settled value is incomplete puts focus
    back on that date input and keeps the alert; a successful create does not;
  - a double-click sends one request;
  - Clear date and Remove expiration work;
  - messages state the stored expiry;
  - a dialog for several files shows what the server stored.
- `share-file-dates.test.tsx` covers the time zones above.
- `tests/integration/share-expiry-validation.test.mjs` runs the share link and
  invitation endpoints against PostgreSQL. It sends omitted, null, empty,
  malformed, impossible, partial-year, six-digit-year, numeric, just-past,
  past, latest and beyond-latest values. It checks status, stored rows, the
  error messages, and that a refused update changes nothing.
- `tests/browser/share-expiry-typing.mjs` runs the production build against
  the API and PostgreSQL in Chromium. It uses en-US in New York, de-DE in
  Kiritimati and ja-JP in Pago Pago. In each it types into Create and Save:
  half a part, two parts, a partial year, a past date, one Backspace, and the
  full date (by click, by keyboard, and with Enter in the input). It also
  uses `element.click()`, which leaves focus in the input, after a lone "0"
  and after the full date, and double-clicks Save. It records
  every request and stored row. It fails on any request that creates a link
  without an expiry or sends null, unless the scenario chose that (no date,
  Clear date, Remove expiration). It also fails on any expiry that is not the
  end of a future date the input showed before the press. Run it from
  `packages/backend` after `pnpm build`:

  ```sh
  TEST_DATABASE_URL=postgresql://…/werkyn_audit_… PLAYWRIGHT_MODULE=playwright \
    node --import tsx tests/browser/share-expiry-typing.mjs
  ```

## Limits

- What the input shows is what is sent. In some part orders a half-typed part
  already reads as a whole date. In year/month/day, a day's first digit gives
  2027-03-01 on the way to 2027-03-15. Typing over a saved date passes
  through dates that mix typed and old parts. Pressing the button at such a
  moment sends the date shown. That is never "no expiry", and never a date the
  input did not show. `DateInput` has the same limit, since the browser
  reports nothing else.
- A lone month "0" in an empty input reads as empty until focus leaves the
  input. While it still has focus, Create looks usable. Using it moves focus
  out of the input, which marks it incomplete, and nothing is sent. When that
  leaves focus on the document body, focus returns to the date input and the
  alert stays. A button that already has focus, and a successful Create, are
  not moved.
- Keyboard users who Tab out of a half-typed date see the browser's completed
  date before they reach the button. Enter then sends that date.
- A double-click on Create or Save with a half-typed last part sends the
  browser's completed date. In year/month/day, a day "0" becomes 01. The first
  click completes the part and sends nothing. The second click comes before
  the user can see the completed date, and sends it. That date is never "no
  expiry" and never in the past. It is the lowest value of that part, so the
  link ends sooner than the date being typed, and the message states the
  stored date.
- A day whose 23:59:59 occurs twice (a zone that falls back at midnight) ends
  at the first one. No zone tested here does so.
- The "not before today" check runs in the browser when the button is used,
  and the "in the future" check runs again on the server, by its clock. If the
  two clocks disagree, the server may refuse a date the dialog accepted; the
  error message is then shown.
