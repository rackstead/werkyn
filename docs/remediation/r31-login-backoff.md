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
   however many failures came before. Nothing in the stored state locks the
   account; but see "Trusted browsers" for what someone who keeps failing can
   still do to a browser that has never signed in.
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

A ticket also carries the row's generation. The generation comes from a
sequence and is new each time a row is created. So an outcome for a row that
was pruned meanwhile never touches the row created after it, even when the
admission numbers match. Each of these rules can leave the count too high,
never too low. For example, an overlapping later attempt that was uncounted
before an earlier sign-in finished still counts.

### Trusted browsers (device cookies)

Admission is first come when a wait ends. Someone who sends a wrong password
for an address each time its wait ends, about once a minute, would otherwise
win every window. The account's owner would then be refused every time, even
when following the form's countdown exactly. The independent review measured
exactly that: 0 of 21 owner attempts got in over 7 minutes, against a timed
attacker and against a plain loop sending every 6 seconds from one IP. So a
browser that has signed in before is exempt from the address's shared wait,
following OWASP's "device cookies" (`login-device.ts`):

- A successful password sign-in sets the cookie `login_device` with these
  attributes:
  - HttpOnly;
  - `Path=/api/auth/login`, so it is sent only to sign-in;
  - Secure, SameSite and Domain from `COOKIE_SECURE`, `COOKIE_SAMESITE` and
    `COOKIE_DOMAIN`, like the refresh cookie;
  - `Max-Age` 30 days.
- The cookie holds one token per address signed in from that browser, at most
  5. A token is `<device id>.<expiry>.<HMAC>`. The HMAC is keyed from
  `COOKIE_SECRET` and binds the random device id and the expiry to the
  normalized address. Each sign-in renews the token and keeps its device id.
- A sign-in that presents an unexpired, unaltered token for its address is
  counted in that device's own lane instead of the address's slot. The lane is
  a second set of `LOGIN_BACKOFF_SLOTS` rows, keyed by the device id. It has
  the same rules: 5 failures, then 2, 4, … 60-second waits. The lanes are
  numbered from 16,777,216, above the largest address slot any setting
  allows, so changing `LOGIN_BACKOFF_SLOTS` never turns one kind of row into
  the other. Someone holding a
  stolen cookie therefore gets one more lane at the same rate, not unlimited
  guesses. The password is always checked.
- A trusted sign-in clears its lane's failures. It also clears the address
  failures admitted before it started, as an ordinary sign-in does. Failures
  admitted while it was being checked keep their count.
- The token is checked against the submitted address with a constant-time
  HMAC comparison, without the database. Tokens exist only for addresses whose
  password has signed in, so unknown addresses never have one. Someone probing
  other people's addresses has no valid token for them. Every answer they get
  goes through the shared, account-independent path, whatever browsers
  elsewhere hold. A token for one's own address is ignored for any other
  address.
- Each token also carries a keyed tag of the account's stored password hash.
  A password change or reset writes a new hash, so it ends every token for the
  account; a re-registered address gets a new account and hash. Because the
  tag can only be checked against the account, sign-in looks the account's
  hash up first. It does so only when the cookie holds a token whose HMAC is
  valid for the submitted address, which only a sign-in to that address can
  produce.
- Signing out keeps the cookie, by design. Clearing the browser's cookies, its
  expiry, a password change or reset, or rotating `COOKIE_SECRET` removes the
  trust.

**Remaining risk.** A browser without a valid token can still be held off by
someone targeting that address. That covers a new device, a cleared or private
browser, a different browser, and the first sign-in after 30 days. The
attacker must send a wrong password each time the wait ends (about once a
minute) for as long as they want to keep it out. They get one guess per wait
for it. Existing sessions, trusted browsers and SSO sign-in are unaffected. A
password reset does not help a new browser, because the address's slot stays
held. Signing in from a trusted browser, or stopping the attacker's traffic,
does.

The reviewer's starvation probe ran again after the change, for 300 seconds
against one production server. Each address started at the capped wait, and
the attackers were the same as before:

| scenario | owner | owner attempts | signed in |
| --- | --- | --- | --- |
| timed attacker, owner reacts after 300 ms | trusted | 1 | at once (47 ms) |
| timed attacker, owner retries the instant the countdown ends | trusted | 1 | at once (48 ms) |
| plain loop every 6 s from one IP | trusted | 1 | at once (52 ms) |
| no attacker (control) | new browser | 2 | after 57.4 s |
| timed attacker | new browser | 5 | never (each refused 429, wait 60 s) |

Before this change, the three attacked owners were refused all 21 attempts
over 7 minutes. The last row is the remaining risk described above. The
trusted sign-ins also cleared the addresses' counts, so each attacker then got
5 more checked guesses before the waits started again. That follows from
"reset on success".

### Bounded tracking without addresses

The `LoginThrottle` table has at most twice `LOGIN_BACKOFF_SLOTS` rows (default
65,536 each): address slots, then trusted-device lanes. Each submitted address
maps to a slot number:

```
HMAC-SHA256(key, lowercase address), first 8 bytes, modulo LOGIN_BACKOFF_SLOTS
key = HMAC-SHA256(JWT_SECRET, "werkyn login backoff slot v1")
```

The slot number is the primary key. A row holds only the slot, the failure
count, the time of the last counted attempt and the two admission numbers, so
the table stores no address.
However many distinct addresses are sent, the table cannot hold more rows than
there are slots. A device lane is
`16777216 + (HMAC-SHA256(key, "device " + device id) mod LOGIN_BACKOFF_SLOTS)`.
The daily cleanup deletes rows quiet for longer than the reset period, and rows
outside both ranges after `LOGIN_BACKOFF_SLOTS` is lowered. Changing the
setting reshuffles which addresses share a slot. It is like rotating
`JWT_SECRET`: counts may move to other addresses until they are forgotten.

Addresses whose slots collide share a count. A collision can only make a wait
start sooner; it never lets an address skip one. Without `JWT_SECRET`, nobody
can choose an address that collides with a given account. At the default
65,536 slots:

| accounts | chance a given account shares its slot | expected colliding pairs |
| --- | --- | --- |
| 100 | 0.15% | 0.08 |
| 1,000 | 1.5% | 7.6 |
| 10,000 | 14% | 763 |

A collision matters only while the pair's combined failures reach 5 within the
quiet period. The review reproduced one: 5 failures on one account made
another's correct password wait 2 seconds, and that account's success then
cleared the first one's count. Installations with many thousands of accounts
should raise `LOGIN_BACKOFF_SLOTS`.

### No account oracle

- Without a device token, every address is counted and answered the same way,
  with or without an account: the same `401` body for a wrong password, then
  the same `429`, the same `Retry-After` and the same message. Unknown
  addresses back off exactly like real accounts. The device cookie is set only
  on a successful sign-in, so no `401` or `429` answer carries one.
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
  one sends the newest link. Work for an
  existing account lasts until its mail is sent, but work for an unknown
  address ends after one lookup. So any cap on work in progress would itself
  show which accounts exist, and behind a shared proxy address it would drop
  other users' links. An earlier revision capped work at 3 per client IP. The
  review measured that cap as an oracle: the prober's own link arrived 0/15
  times when the probed account existed and 15/15 when it did not. It also
  dropped 2 of 5 users' links behind one IP.

  A later revision refused every request past 600 a minute per process. The
  re-review measured that as a cheap total denial: about 60 client
  addresses at the route limit left a real user 0 of 30 resets, against 30
  of 30 on main. Work is now bounded per address, after the uniform answer:
  - a request for an address whose earlier request is still running adds
    nothing;
  - an account gets at most one new link per `PASSWORD_RESET_COOLDOWN_SECONDS`
    (default 60, at most 3,600). A request within the cooldown is answered
    alike and makes no token and no mail. The cooldown is read from the
    account's newest link, which is kept until it expires after an hour, so
    longer cooldowns are not offered. A password change deletes the unused
    links and so ends the cooldown early. A completed reset keeps its used link
    until it expires, so the cooldown still runs from that link's creation.
    Across processes the cooldown is best effort: two requests checked at the
    same moment can both send a link.
  - Work for an address without an account ends after one lookup.

  The reviewer's flood probe ran against this design for 150 seconds: 65
  client addresses per pool sent 1,950 requests for unknown addresses
  (about 780 a minute), and a real user asked for a reset every 5 seconds.
  All 1,950 flood requests and all 30 of the user's requests were answered
  `200`. The user received a link at once, then one per cooldown (3 links).
  With the cooldown set to 0, all 30 links arrived, as on main. The
  reviewer's oracle probe still finds no difference: the prober's own link
  arrived 15/15 times whether the probed account existed or not, and 10/10
  with 50 ms mail.

  So mail work is bounded by the number of accounts per cooldown, and other
  work by the request rate. The route's limit of 10 a minute per client
  still applies. Purely as a memory guard, each process starts at most
  `PASSWORD_RESET_REQUESTS_PER_MINUTE` requests (default 6,000), counted by
  request alone before any lookup. Past it, every request, for any address,
  is answered `429` with `Retry-After` and the same message, and the first
  refusal in each minute is logged (`password_reset_budget_exhausted`).
  Reaching the default takes about 600 client addresses at the route limit.
  That is more than the 480 or so that sign-in's two-job password-check
  limit needs. The forgot-password form counts any `429` down.
- When the server closes, it keeps the database open for reset work in
  progress until shortly before the shutdown deadline (8 seconds overall).
  Work still running then is logged (`password_reset_requests_abandoned`,
  with the count) before the connection closes. A failure in this work
  (database or mail) is logged and no longer reaches the requester. Mail
  failures were already logged and never shown to the requester.
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
| `PASSWORD_RESET_COOLDOWN_SECONDS` | 60 | 0–3600 |
| `PASSWORD_RESET_REQUESTS_PER_MINUTE` | 6000 | 60–1000000 |

The server refuses to start with a value outside its range, or with the order
base ≤ max ≤ reset broken. Each error names the variable and never repeats the
value.

## Upgrade

Migration `20261105150000_bounded_login_backoff` drops `LoginAttempt` and
creates `LoginThrottle`. Current failure counts and lockouts are lost, which
lifts any lockout in place. Stop older servers before applying it. They still
read `LoginAttempt` and would answer sign-ins with `500` until replaced. The
shipped container entrypoint applies migrations before starting the server.

**Rolling back.** An earlier version run against the migrated database also
answers every password sign-in with `500` (its `LoginAttempt` table is gone).
Before starting an earlier version, recreate the table it expects. It starts
empty; only counters are lost.

```sql
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailedAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LoginAttempt_email_key" ON "LoginAttempt"("email");
CREATE INDEX "LoginAttempt_email_idx" ON "LoginAttempt"("email");
```

Leave `LoginThrottle` in place while rolled back: Prisma's migration history
still lists the migration as applied, so upgrading again needs no further step.
After that upgrade, the recreated `LoginAttempt` is unused and can be dropped.

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
  - trusted browsers:
    - a browser that signed in before signs in at once while the address is
      held at its longest wait;
    - the cookie's attributes;
    - a trusted browser has its own small budget, separate from the address;
    - another address's token, an altered or expired token and garbage are
      ignored;
    - at most 5 tokens per browser;
    - without a token, answers are identical for an address trusted elsewhere,
      one never signed in, a password-less one and an unknown one;
  - with mail held, 8 users' resets from one client address are all delivered;
  - the reviewer's oracle sequence delivers the prober's own link whether or
    not the probed address exists;
  - a repeat for a pending address adds nothing;
  - closing the server waits for reset mail slower than 2 seconds and
    delivers it;
  - work still running at the drain deadline is logged with its count;
  - an outcome for a pruned row does not touch the row created after it, even
    at the same admission number;
  - a password change ends a browser's trust, and a token minted under the new
    password is trusted;
  - an account gets one reset link per cooldown: repeats within it are
    answered alike and make nothing, and a link follows once it has passed.
- `tests/integration/login-backoff-bounds.test.mjs` runs with 256 slots:
  - 600 unique unknown addresses through the sign-in route leave at most 256
    rows and only `401` or `429` answers;
  - 2,000 more addresses admitted directly still leave at most 256 rows;
  - cleanup removes rows past the quiet period and rows outside the address
    and device ranges;
  - at the smallest ceiling (60 a minute), the next request is refused `429`.
    The refusal is identical for an existing and an unknown address, and the
    refused request does no work.
- `tests/argon2id-passwords.test.mjs` checks that sign-in without a usable
  hash is refused and uses the same native admission (`503` while two jobs
  run). It also checks that the stand-in check costs between half and twice a
  real one.
- `tests/env-validation.test.mjs` covers defaults, ranges and ordering.
- `tests/error-response-headers.test.mjs` covers `429` with `Retry-After`.
- `tests/shutdown.test.mjs` checks, with an injected clock, that each shutdown
  step learns the exact time left before the overall deadline. The reset drain
  uses it.
- In the frontend, `login-form.test.tsx` checks:
  - the countdown (3, 2, 1, then the form is usable again);
  - that nothing is sent during the wait;
  - that a new `429` restarts the countdown;
  - that a `429` without `Retry-After` shows the server's message;
  - that `Retry-After` is read as seconds or as an HTTP date;
  - in `forgot-password-form.test.tsx`, a reset `429` counts down and sends
    nothing during the wait.

## Limitations

- **A browser that has never signed in can be held off.** Someone who sends a
  wrong password for an address each time its wait ends keeps every browser
  without a valid device token for that address from signing in with a
  password, for as long as they keep sending. That covers new devices, cleared
  or private browsers, and the first sign-in after 30 days. See "Trusted
  browsers". Trusted browsers, existing sessions and SSO are unaffected.
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
- **Process-local limits.** The route limit and the password-check admission
  are counted per server process. The route limit keys on the connection's
  address: the app does not trust proxy headers, so behind a reverse proxy it
  counts all users together, as before this change. Only the backoff is
  shared.
- **Reset requests can be refused for everyone during a very large flood.**
  More than `PASSWORD_RESET_REQUESTS_PER_MINUTE` (6,000) reset requests a
  minute to one process are answered `429` until the minute ends, for every
  address. That takes about 600 client addresses at the route limit. A user
  caught by it sees the countdown and can ask again.
- **One reset link per account per cooldown.** A user whose first mail was
  lost waits up to `PASSWORD_RESET_COOLDOWN_SECONDS` (60 s) for another.
- **Reset requests are not durable.** An answered request lives only in the
  process that answered it. It is lost if the process is killed, or if its
  mail is still being sent at the shutdown deadline; that case is logged. The
  requester saw the usual answer and must ask again. A durable outbox for
  account mail would remove this; it is a separate feature.
- **Measured in-process only.** The timing evidence was measured in-process on
  one machine. It is not a remote measurement or a production load test
  (R39/R42).
