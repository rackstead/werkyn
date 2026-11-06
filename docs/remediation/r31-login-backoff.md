# Failed sign-in backoff and enumeration cost (R31)

## Problem

Password sign-in had a per-client-address route limit (10 requests a minute)
and a per-email lockout in the `LoginAttempt` table. Four problems remained:

- **Hard lockout.** Five failures locked the address for 30 seconds, ten for
  5 minutes and fifteen for 30 minutes. A locked address refused even the
  correct password. Anyone could lock out another user by sending a few wrong
  passwords for their address, and keep them locked out with one more every
  30 minutes.
- **Unbounded storage.** Every submitted address, with or without an account,
  got a row holding the raw address. Rows were removed only by the daily
  cleanup, a day after their last update, so requests for made-up addresses
  grew the table without limit.
- **Timing showed which accounts exist.** A wrong password for a real account
  ran an Argon2id check (about 20 ms). An unknown address, or an account
  without a password (SSO only), skipped the check. Measured in-process, the
  median answer took 21.9 ms for a real account and 4.0 ms for the other two
  (Kolmogorov–Smirnov distance 1.0: the distributions did not overlap).
- **Password-reset timing showed the same.** For an account, forgot-password
  replaced the reset link and waited for the mail server before answering. For
  an unknown address it answered at once. With a mail server that takes 150 ms,
  the median answer took 160 ms for an account and 2.3 ms otherwise.

The owner decided on 5 November 2026: keep the route limits, add a growing
per-account delay with no hard lockout, reset it on success, bound the
tracking, and give unknown accounts the same hashing cost. The Argon2id
password policy is unchanged.

## Behaviour

### Backoff

Each attempt for an email address is counted before its password is
checked:

1. The first 5 consecutive attempts are checked at once. After the 5th
   failure, the next attempt must wait 2 seconds. Each further failure doubles
   the wait: 2, 4, 8, 16, 32, then 60 seconds, and stays at 60.
2. An attempt made during the wait gets `429 Too Many Requests` with a
   `Retry-After` header (whole seconds) and the message `Too many sign-in
   attempts. Try again in N seconds.` No password is checked, the attempt is
   not counted, and the wait does not grow. The correct password also waits.
   CORS exposes `Retry-After`, so a frontend on another allowed origin can
   read it. The sign-in form shows the wait counting down and does not send
   until it has passed.
3. After the wait, the next attempt is checked. A correct password signs in,
   however many failures came before. There is no lockout.
4. A completed sign-in clears the count. An hour without counted attempts
   also clears it. A correct password whose sign-in is then refused, because a
   concurrent password change or reset replaced it, stays a counted failure.
5. If the outcome was not decided, the attempt is not counted. This covers a
   password that could not be checked (`503`, password checks busy) and a
   session transaction that failed.

The request is refused at once. No server worker, database connection or
timer is held during the wait. A refused attempt costs two small database
statements and no password hashing. So a client that retries too early costs
the server little.

The state is in PostgreSQL. Admitting an attempt is one `INSERT … ON CONFLICT
DO UPDATE` statement. Concurrent attempts for one address, from any number of
server processes, take the row lock one at a time. So a burst of parallel
guesses cannot all pass the check before any failure is recorded: in a burst of
20, at most 5 passwords are checked.

Each admitted attempt also gets the slot's next admission number, which acts
as its ticket. An outcome changes only the admissions it owns:

- A sign-in sets the count to the number of attempts admitted after it, never
  more than the current count, and records its number as cleared. Failures
  that overlapped it and were admitted later keep their count.
- An undecided attempt uncounts itself only if no later sign-in has cleared it.

Any outcome reported more than half the reset period after its admission
changes nothing, because by then the row may have been pruned and started
again. Each of these rules can leave the count too high, never too low. For
example, an overlapping later attempt that was uncounted before an earlier
sign-in finished still counts.

### Bounded tracking without addresses

The `LoginThrottle` table has at most `LOGIN_BACKOFF_SLOTS` rows (default
65,536). Each submitted address maps to a slot number:

```
HMAC-SHA256(key, lowercase address), first 8 bytes, modulo LOGIN_BACKOFF_SLOTS
key = HMAC-SHA256(JWT_SECRET, "werkyn login backoff slot v1")
```

The slot number is the primary key. A row holds only the slot, the failure
count, the time of the last counted attempt and the two admission numbers, so
the table stores no address.
However many distinct addresses are sent, the table cannot hold more rows than
there are slots. The daily cleanup deletes rows quiet for longer than the reset
period, and rows outside the configured slot range after
`LOGIN_BACKOFF_SLOTS` is lowered.

Addresses whose slots collide share a count. A collision can only make a wait
start sooner; it never lets an address skip one. Without `JWT_SECRET`, nobody
can choose an address that collides with a given account. With the default size
and a few thousand accounts, collisions between real accounts are rare, and
they matter only while one of them is failing.

### No account oracle

- Every address is counted and answered the same way, with or without an
  account: the same `401` body for a wrong password, then the same `429`, the
  same `Retry-After` and the same message. Unknown addresses back off exactly
  like real accounts.
- If no stored hash can be checked, sign-in verifies the password against an
  Argon2id hash of random bytes, made with the current parameters when the
  server starts. This covers an unknown address, an account without a
  password, an unsupported stored hash, and a legacy bcrypt hash with an input
  over 72 bytes. The check goes through the same two-job admission as a real
  check and always fails. Input that no hash could accept (over 512 UTF-8
  bytes, or ill-formed) is refused before any hashing, for every address
  alike.
- The SSO-only check (password sign-in disabled) now runs before the attempt
  is counted. Its answer is the same for every address.
- Forgot-password answers `200` with the same message before it looks the
  account up. Replacing the reset link and sending the mail run afterwards
  (`requestPasswordReset` in `auth.service.ts`). A repeated request for an
  address whose earlier one is still running adds nothing, because the running
  one sends the newest link. Each process runs at most 100 requests at a
  time, and at most 3 from one client IP address, so one client cannot take
  the whole bound. Further requests are logged
  (`password_reset_request_dropped`) and dropped. The requester sees the same
  answer as for an unknown address and can ask again. Work for an address
  without an account ends after one lookup, so only mail to existing accounts
  can hold the bound for long. When the server closes,
  it waits up to 2 seconds for requests in progress before closing the
  database connection. A failure in this work (database or mail) is logged and
  no longer reaches the requester. Mail failures were already logged and never
  shown to the requester.
- Reset-password is keyed by the secret link token, not by an address. Its
  answers (`404` unknown link, `410` used or expired, `200`) show only the
  state of the link that was presented. They never show whether an address has
  an account, so this change leaves that path as it is.

### Measured timing

The audit's timing script measures each answer in-process through
`app.inject`, with no network jitter. That makes it stricter than a
remote observer. It takes 300 sign-in and 150 forgot-password samples per
group, interleaved in random order. Each sample uses a fresh account or
address, so the backoff never starts. A mail stub
waits 150 ms to stand in for a remote mail server.

| | real account | password-less (SSO) | unknown | KS distance real vs unknown | Mann–Whitney p |
| --- | --- | --- | --- | --- | --- |
| sign-in before | 21.9 ms | 4.0 ms | 4.0 ms | 1.00 | < 0.0001 |
| sign-in after | 22.3 ms | 22.2 ms | 22.1 ms | 0.05 | 0.58 |
| forgot-password before | 159.7 ms | 160.1 ms | 2.3 ms | 1.00 | < 0.0001 |
| forgot-password after | 1.27 ms | 1.24 ms | 1.26 ms | 0.07 | 0.55 |

Values are medians. After the change, every pairwise comparison (real,
password-less, unknown) has a Mann–Whitney p of 0.15 or more and a
Kolmogorov–Smirnov distance of 0.15 or less, within the noise. Each answer
had one status and one body per group. Forgot-password samples wait for the
previous request's background work to finish before the next is sent; the
stub delivered all 300 account messages (150 real, 150 password-less) and none
for unknown addresses.

## Configuration

| Variable | Default | Range |
| --- | --- | --- |
| `LOGIN_BACKOFF_THRESHOLD` | 5 | 1–100 |
| `LOGIN_BACKOFF_BASE_SECONDS` | 2 | 1–900, at most the max |
| `LOGIN_BACKOFF_MAX_SECONDS` | 60 | 1–900, at most the reset |
| `LOGIN_BACKOFF_RESET_SECONDS` | 3600 | 60–604800 |
| `LOGIN_BACKOFF_SLOTS` | 65536 | 256–16777216 |

The server refuses to start with a value outside its range, or with the order
base ≤ max ≤ reset broken. Each error names the variable and never repeats the
value.

## Upgrade

Migration `20261105150000_bounded_login_backoff` drops `LoginAttempt` and
creates `LoginThrottle`. Current failure counts and lockouts are lost, which
lifts any lockout in place. Stop older servers before applying it. They still
read `LoginAttempt` and would answer sign-ins with `500` until replaced. The
shipped container entrypoint applies migrations before starting the server.

## Tests

- `tests/integration/login-backoff.test.mjs` (real PostgreSQL) covers:
  - identical answer transcripts for real, password-less and unknown addresses
    (five `401`, then `429`/`Retry-After: 2`, including for the correct
    password);
  - the wait sequence 2, 4, 8, 16, 32, 60, 60, 60;
  - sign-in with the correct password once the 60-second wait passes after 13
    failures;
  - a cleared count after success;
  - refused attempts are not counted;
  - failures forgotten after the quiet period;
  - a burst of 20 parallel attempts checks at most 5 passwords;
  - an attempt refused `503` (password checks busy) is not counted;
  - the table has no address column, and `LoginAttempt` is gone;
  - two separate server processes share one address's backoff, and a success
    in one clears it for the other;
  - forgot-password answers alike for all three kinds while the mail server
    holds every message, and the delivered link then works;
  - a sign-in clears only failures admitted up to it, keeping later
    overlapping ones;
  - a late undecided report does not uncount failures newer than a sign-in;
  - a correct password whose sign-in is refused, because the password was
    replaced while it waited for the account row, stays a counted failure;
  - a cross-origin frontend can read `Retry-After`, because CORS exposes it;
  - while mail is held, pending reset requests stop at 3 per client and 100
    per process, a repeat for a pending address adds nothing, every accepted
    request delivers its link, and a dropped address can ask again once the
    work drains.
- `tests/integration/login-backoff-bounds.test.mjs` runs with 256 slots:
  - 600 unique unknown addresses through the sign-in route leave at most 256
    rows and only `401` or `429` answers;
  - 2,000 more addresses admitted directly still leave at most 256 rows;
  - cleanup removes rows past the quiet period and rows outside the slot range.
- `tests/argon2id-passwords.test.mjs` checks that sign-in without a usable
  hash is refused and uses the same native admission (`503` while two jobs
  run). It also checks that the stand-in check costs between half and twice a
  real one.
- `tests/env-validation.test.mjs` covers defaults, ranges and ordering.
- `tests/error-response-headers.test.mjs` covers `429` with `Retry-After`.
- In the frontend, `login-form.test.tsx` checks:
  - the countdown (3, 2, 1, then the form is usable again);
  - that nothing is sent during the wait;
  - that a new `429` restarts the countdown;
  - that a `429` without `Retry-After` shows the server's message;
  - that `Retry-After` is read as seconds or as an HTTP date.

## Limitations

- **A determined attacker can hold an account in its longest wait.** If an
  attacker sends a wrong password for an address each time its wait ends, the
  account stays in its capped wait. Its user can still sign in by trying after
  the stated wait, but must get that attempt in before the attacker's next one.
  This is never a lock: each wait is at most `LOGIN_BACKOFF_MAX_SECONDS`, and
  the attacker gets one guess per wait. Exempting trusted devices (a cookie set
  at successful sign-in) would remove the race. That is a separate feature and
  was not part of this decision.
- **Success visibly clears the count.** An attacker who has made four failures
  for an address can see whether its owner signed in successfully before the
  attacker's next attempt: the count would be cleared, so no wait starts. That
  shows the account exists and is in use. This follows from "reset on success"
  and needs the owner to sign in with a password during the attacker's window.
- **Legacy bcrypt accounts.** Accounts that still have a legacy bcrypt hash are
  checked with bcrypt at the hash's own cost, not Argon2id. Their timing can
  differ from an unknown address's. The owner kept the existing policy of no
  rehash on sign-in, so these accounts move to Argon2id only on a password
  change or reset.
- **Registration still says whether an address is taken**, with
  `409 Email already in use`. That is a product behaviour outside this
  decision.
- **Shared slots.** Addresses in the same slot share a count. If someone keeps
  failing for one address, another address in that slot also waits; the
  chance is 1 in `LOGIN_BACKOFF_SLOTS` for each address. An attacker who sends
  failures for enough distinct addresses, from enough client addresses, to
  fill every slot slows sign-in for everyone by up to the longest wait per
  attempt. At the default size and the route limit, that takes several
  thousand client IP addresses. The two-job password check limit is a cheaper
  way to deny service.
- **Process-local limits.** The route limit, the password-check admission and
  the pending reset-request bounds are counted per server process. Only the
  backoff is shared.
- **Reset requests are best effort, not durable.** An answered request lives
  only in the process that answered it:
  - it is dropped past the 100-request or 3-per-client bound;
  - it is lost if the process stops;
  - the server waits at most 2 seconds for it on a clean shutdown.

  In each case the requester sees the usual answer, but no link arrives, and
  must ask again. Before this change, such a request either was answered with
  an error or held the request open. A durable outbox for account mail would
  remove this; it is a separate feature.
- **Measured in-process only.** The timing evidence was measured in-process on
  one machine. It is not a remote measurement or a production load test
  (R39/R42).
