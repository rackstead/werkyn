# R42: minimum rate for backup uploads, and the documented backup limits

## Problem

Backup export, preview and restore each take one of a server's backup slots
before they read anything: one per workspace and three per server process
([B03](b03-backup-transport.md)). A preview or restore keeps its slot while
its file uploads. Once the file part has started, the 120-second request
deadline no longer applies ([P03a](p03a.md)), so an upload was bounded only by
the 60-second transfer idle timeout and the 1,088 MiB size limit. A client
that sends a byte every few seconds is never idle. It held its slot for as long
as it kept dripping: a full-size file at one byte a second would take 36 years.
Any signed-in user can create a workspace and is its admin, so three such
clients, in three workspaces, kept every other admin on the server from
exporting or restoring.

Measured on main (`49b2d06`) with the production limits: three admins each
start an upload and then send one byte of the file per second. Another admin
tries a preview in the first workspace and in a fourth one at each checkpoint:

| Time | Slots held | Staged files | Same workspace | Fourth workspace |
|---|---|---|---|---|
| 5 s | 3 | 3 | 429 | 503 |
| 65 s (past the 60 s idle timeout) | 3 | 3 | 429 | 503 |
| 125 s (past the 120 s request deadline) | 3 | 3 | 429 | 503 |
| 185 s | 3 | 3 | 429 | 503 |

The slots were released only when the probe closed its connections. Log:
`round14-r42-before-probe-main-49b2d06.log` in the audit evidence.

## Change

The owner decision for R42 is to enforce a minimum transfer rate on backup and
restore uploads, document the remaining limits for operators, and keep exports
and restores as synchronous requests (no background jobs).

### Minimum upload rate

From the moment a preview or restore is admitted until its file has been
staged, its request body must arrive at a minimum average rate. Three settings
control it. They are read at startup, and an empty value keeps the default:

| Variable | Default | Range | Meaning |
|---|---|---|---|
| `BACKUP_UPLOAD_MIN_BYTES_PER_SECOND` | `16384` (16 KiB/s) | 1–1073741824 | The lowest average rate accepted |
| `BACKUP_UPLOAD_RATE_WINDOW_SECONDS` | `60` | 1–3600 | The sliding window the average is taken over |
| `BACKUP_UPLOAD_RATE_GRACE_SECONDS` | `30` | 1–3600 | Time after admission before the rate is enforced |

- The rate is checked every tenth of the window, and at least once a second.
  At each check from the end of the grace period, the bytes received over the
  last window (or since admission, while that is shorter) must average at
  least the minimum. The average uses measured time, so a late check never
  counts a shorter period than it covers.
- Every byte of the request body counts, multipart framing included, so a
  client that drips the part headers before its file is caught as well.
- Time counts only while the server is reading. When its staging write falls
  behind, the request stream is paused (back-pressure) until the write
  catches up; that time is left out of both the grace period and the window,
  so a slow disk is never held against a fast client. The 60-second transfer
  idle timeout still bounds a staging write that stops altogether.
- Checks run before pending socket reads in each turn of Node's event loop.
  When synchronous work has held up the process (parsing another backup, for
  example), a check that finds the upload too slow is confirmed only after the
  bytes that arrived meanwhile have been read.
- A body that has fully arrived is never refused, since what remains is the
  server's work.
- Exports are unchanged: their request body is small and is read before
  admission, and their download is not rate-limited.

An upload below the minimum is answered `408 Request Timeout` with the message
"The backup upload was too slow and was abandoned. Uploads must average at
least 16384 bytes per second." (with the configured rate). The server logs a
warning, "Abandoned a backup upload below the minimum rate", with the minimum
but nothing from the request. Before the response is sent, the partial staged
file is closed and removed and the slot is released, so another request is
admitted as soon as the client has its answer. If the client is still sending,
its connection is closed 2 seconds after the response, which gives it time to
read the 408.

The 1 GiB archive and the 1,088 MiB upload limit are unchanged. At the
default minimum, an upload that keeps exactly to it can still hold a slot for
up to 1,088 MiB / 16 KiB/s, about 19 hours. Raise the minimum, or let a
reverse proxy receive the whole upload first (see the README), to shorten or
remove that.

Two smaller changes came with it:

- Every answer to a preview or restore that is sent before its body has fully
  arrived now closes the connection 2 seconds later. Before, this applied only
  once the file part had started; a refusal before that (a missing or
  unsupported file) kept the connection until the 120-second request deadline
  while the client went on sending.
- The staged file is still created with R33's no-follow open inside the
  checked staging folder ([R33](r33-storage-symlinks.md)). An upload refused
  while that open is in progress is stopped as soon as it completes, and on
  every failure the file is closed before it is removed and the source is
  released.

### After the change

The same probe with the default settings:

| Time | Event |
|---|---|
| 5 s | 3 slots held, 3 staged files; the other admin gets 429 and 503 |
| 30.1 s | All three uploads answered 408 with the message above, after 30 file bytes each |
| 35 s | 0 slots held, 0 staged files; the other admin's previews in the first and fourth workspaces get 200 |

Log: `round14-r42-after-probe-defaults.log`.

## How the limits fit together

A preview or restore upload, with the default settings:

| Phase | Bounds |
|---|---|
| Request line and headers | 30-second header deadline |
| Before admission | Refused with a 429 while the user owes a cooldown (below) |
| From admission until the file part starts | 120-second request deadline (from the start of the request); 60-second transfer idle timeout; the minimum rate after the grace period |
| The file | 60-second transfer idle timeout; the minimum rate; 1,088 MiB (413). The request deadline no longer applies. |
| Waiting for the exclusive section, then processing | No client-side bound; a client that leaves while waiting is skipped |
| The response | 120-second socket idle timeout |

Which limit ends a stalled or slow upload first:

- A client that sends nothing after its headers, or drips a few bytes a
  minute: the minimum rate, 30 seconds after admission, with a 408.
- A client that sends part of the file quickly and then stops: the 60-second
  transfer idle timeout, which closes the connection without a response, or
  the minimum rate once the last minute's average falls below 16 KiB/s,
  whichever comes first. After 1 MiB or more at full speed, the idle timeout
  comes first.
- A client that keeps above the minimum: no limit until the file ends or
  reaches 1,088 MiB.

The socket idle timeout is suspended for backup routes until their response
starts (P03a), so it does not cut off an upload; the transfer idle timeout
does.

## Tests

`tests/integration/backup-upload-rate.test.mjs` runs the real app on a
loopback port with PostgreSQL, a minimum of 4,096 bytes a second, a 2-second
window and a 2-second grace period, and drives each upload over TCP with a
paced client:

- Three uploads (two restores and a preview, in three workspaces) send their
  first 64 file bytes and then one byte a second. While they hold the
  server's three slots, another admin gets 429 in the same workspace and 503
  in a fourth. Each upload is answered 408 with the documented message just
  after the grace period. When the clients have their answers no slot is held
  and no staged file is left, and the other admin's restore (image bytes
  checked) and preview are admitted at once with 200. Each client, still
  dripping, is disconnected about 2 seconds after its answer. The refused
  restores and preview wrote no space, file or cleanup-queue entry.
- A restore at 1.25 times the minimum for about 8 seconds (longer than the
  6-second request deadline used in this test) and a preview at three times
  the minimum with a pause of half the window both succeed.
- A client that sends 16 KiB of its file and stops, one that stops halfway
  through the file part's header, and one that drips that header a byte a
  second and goes on after its answer, are answered 408 within one window and
  two checks, ahead of the request deadline that still applies before the file
  starts. Each is disconnected about 2 seconds after its answer, well before
  that deadline. Nothing is left staged or stored, and no slot is held.
  Without closing the connection after the answer, the client dripping the
  header kept it until the request deadline (checked by removing the call).

`tests/backup-staging.test.mjs` adds:

- the rate check: a trickle at a fifth of the minimum is reported once, after
  the grace period; silence is reported at the end of the grace period; a
  watch stopped early never reports; uploads at 1.3 times the minimum, and at
  three times it with a pause of half the window, are never reported; a burst
  followed by silence is reported about one window later;
- a staging copy stopped through its signal rejects with the signal's reason,
  releases its source and leaves no file, also when stopped before it starts;
- a copy stopped by the signal or the idle timeout while the staged file is
  still being opened rejects with that reason, releases its source and leaves
  no file. Before this was handled, the stop destroyed the stream before
  anything listened for its error, which crashed the process (reproduced at
  the earlier head);
- over a real socket, a file at a tenth of the minimum and a part header
  dripped before the file are answered 408, and a file at 1.5 times the
  minimum is staged;
- an upload at twice the minimum is staged although the process is blocked
  for 1.5 seconds, longer than the window, while the client keeps sending
  from another process. The block runs in a socket read callback, as the
  synchronous parse of another backup does in an I/O callback, so the
  overdue check runs before the waiting bytes are read. Without the
  confirmation after pending reads, it is refused (3 of 3 runs, checked by
  removing it);
- time the watch is paused is not counted, before or after the grace period,
  and silence after the pause is still reported;
- a 1 MiB file sent at once is staged although staging writes take it at
  about 250 KiB/s, half the minimum, for about 4 seconds. Without leaving out
  the time the request is paused for back-pressure, it is refused after about
  0.6 seconds (checked by removing it).

`tests/env-validation.test.mjs` checks the defaults, empty values, the
accepted ranges and the refusals of 0, fractions and words.

Run against main's server code, the first and third integration tests fail:
the dripping uploads, and the upload stopped mid-file, are still unanswered
when the 60-second test timeout ends them. The test of uploads above the
minimum passes on main, as it should (each test run on its own, since the
first one leaves the slots held on main).

## Follow-up: a cooldown per user

### Problem

The independent review of the minimum rate (PR #204, finding M1) showed that
it stops a single slow connection but not a client that starts a new upload
each time. Three attacker uploads, in three workspaces, sent only their
request and part headers and reconnected as soon as each was answered 408.
Another admin, trying a preview in a fourth workspace every 3 seconds for
100 seconds, got 503 on 33 of 33 tries, as on main before the minimum rate.
Each slot cost the attacker a few hundred bytes every 30 seconds.

A cooldown that followed only the 408 could be sidestepped the same way: a
client that hangs up a second before its 408, or that sends the rest of a tiny
file a second before it, is never refused for its rate. Both are measured
below.

### Decision

The owner approved a per-user cooldown on 6 November 2026: after a backup or
restore upload is refused with 408 for falling below the minimum rate, the
same user cannot start another backup or restore upload until a short,
configurable cooldown ends, and gets 429 with Retry-After meanwhile. Normal
uploads and other users are not affected.

### Change

One more setting, read at startup like the others (an empty value keeps the
default):

| Variable | Default | Range | Meaning |
|---|---|---|---|
| `BACKUP_UPLOAD_RATE_COOLDOWN_SECONDS` | `120` | 0–3600 | How long a user's previews and restores are refused after one of their uploads is refused for its rate. 0 turns the cooldown off. |

- **After a 408 for the rate,** the same user's previews and restores, in any
  workspace and on any server process, are answered `429 Too Many Requests`
  for exactly the cooldown, with `Retry-After` in whole seconds, the code
  `BACKUP_UPLOAD_COOLDOWN` and the message "Backup uploads from your account
  are paused because a recent one was too slow. Try again in N seconds."
- **Ending a slow upload first does not avoid it.** Every preview or restore
  is measured when it stops being received: when its file has been staged,
  when it is refused for any reason, or when its client goes away. Its
  shortfall is the time since admission that the bytes received do not cover
  at the minimum rate (the time minus the bytes divided by the rate; time the
  server spent not reading, for back-pressure, is left out, as for the rate
  itself). Each second of shortfall adds cooldown ÷ grace seconds to the
  user's wait (4 at the defaults), so holding a slot for the whole grace
  period without sending costs about a full cooldown however the upload ends.
  An upload that keeps to the minimum has no shortfall and adds nothing.
- **Small shortfalls are forgiven.** Waits add up and count down in real
  time. The first fifth of the cooldown is forgiven (24 seconds at the
  defaults, which is 6 seconds of shortfall): a user is refused only while
  more than that is owed, and only until it is back to that. The time it takes
  to receive a small file, or a pause of a few seconds, never leads to a
  refusal. A 408 sets the wait to the cooldown plus that fifth, so it leaves
  exactly the cooldown. No user ever owes more.
- **Checked before admission.** The refusal comes before the user's request
  takes a slot or reads its body. Its connection is closed 2 seconds after
  the answer if the client goes on sending, as for other answers sent before
  the body has arrived.
- **Recorded before the answer.** The wait is written before the slot is
  released and before the response is sent, so the client's next request
  finds it. If the write fails, the error is logged and the request's own
  answer is unchanged.
- **Per authenticated user,** whether signed in with a session or a personal
  API key; not per IP address. Other users, and the user's exports (which
  upload nothing), are not affected.

At the defaults:

| How a user's upload ends | Shortfall | Then refused for |
|---|---|---|
| Refused for its rate (408) | about 30 s or more | 120 s |
| Client hangs up 29 s after admission, having sent only headers | about 29 s | 92 s |
| A 2 KB file, completed after a 10-second pause | about 10 s | 16 s |
| Client hangs up after 5 s, or a tiny file arrives after a 5-second pause | about 5 s | not refused |
| Any upload at 16 KiB/s or more | 0 | not refused |

However one account times its uploads, it can keep backup slots busy below
the minimum rate for only about a fifth to a quarter of the time at the
defaults: a slot it held for up to 30 seconds is then refused to it for up to
2 minutes. Other admins are admitted the rest of the time.

**Why PostgreSQL.** Backup slots are counted per server process, but a user's
next request can reach any process. The owner decision is that the same user
cannot start another upload until the cooldown ends, so the wait is kept in
the database and every process refuses the user; a restart does not clear it
either. The cost is one primary-key read per preview or restore, and a write
only for an upload with a shortfall. The new table `BackupUploadCooldown`
(migration `20261106180000_backup_upload_cooldown`) holds at most one row per
user: the time the user's wait is paid off. Rows are removed with their user,
and every write also prunes rows whose wait is over (up to 1,000 at a time,
skipping rows another write holds), so it holds only users with a recent slow
upload. Times are read from the database's clock, so clock differences between
server processes do not matter. The migration only creates the table; older
servers ignore it.

**Why 120 seconds.** With the 30-second grace period, a cooldown of C lets one
account hold slots below the minimum for about 30 of every 30 + C seconds:
a fifth at 120 seconds, a third at 60, a ninth at 240. Longer cooldowns
protect more, but make an admin whose upload was refused because their link
dropped wait longer before trying again. Two minutes keeps another admin's
chance of being admitted at four in five or better, and is about as long as
the web app already gives a restore (120 seconds).

**The web app.** When a preview or restore is refused this way, the backup page
shows "Backup uploads from your account are paused because a recent one was
too slow. You can upload again in N seconds.", counts it down (the same
`Retry-After` handling as the sign-in form, PR #201) and keeps the file picker
and Confirm Restore disabled until the wait has passed. A preview's chosen
file is cleared so the same file can be chosen again. Other refusals are
shown as before.

### Measured

The reconnect attack from the PR #204 review, rerun with its harness on main
(`a6bcc03`) and on this change, side by side, with the production limits and
default settings (30-second grace period, 120-second cooldown). Three attacker
uploads, one per workspace, send only their headers; another admin tries a
preview in a fourth workspace every 3 seconds for 100 seconds. Every
connection uses its own source address, so the per-address request limit does
not hide the result.

| Attacker | Main: other admin | This change: other admin | This change: attacker |
|---|---|---|---|
| Reconnects at once after every answer (the review's scenario, unchanged) | 503 on 33/33 | 503 on 9, then 200 on 24 | 3 × 408, then 58,163 × 429 |
| Reconnects when allowed (waits out each `Retry-After`) | 503 on 33/33 | 503 on 9, then 200 on 24 | 3 × 408, 3 × 429 |
| Hangs up 29 s after admission, before its 408, and reconnects | 503 on 33/33 | 503 on 9, then 200 on 24 | 3 hang-ups, 3 × 429 |
| Completes a small file 29 s after admission, and reconnects | 503 on 33/33 | 503 on 9, then 200 on 24 | 3 × 200, 3 × 429 |

With this change, the other admin is refused only during the first 30
seconds, while the attacker's first uploads hold the slots before they can be
measured, and admitted from then on. No slot, staged file or timer was left
afterwards in any run.

Over 330 seconds, an attacker that reconnects whenever it is allowed, and one
that hangs up 29 seconds after admission each time, both hold the slots for 30
seconds of every 150: the other admin got 503 from 0 to 30 s, 150 to 180 s and
300 to 330 s, and 200 otherwise (81 of 110 tries).

The same change with a cooldown that follows only the 408 (the shortfall
charge removed) lets both other attackers through: the one that hangs up 29
seconds after admission, and the one that completes a small file then, kept
every slot, and the other admin got 503 on 33 of 33 tries in each case.

Logs and the harness: `round14-r42b-harness/` in the audit evidence.

### Tests

`tests/integration/backup-upload-cooldown.test.mjs` runs the real app on a
loopback port with PostgreSQL, a minimum of 4,096 bytes a second, a 2-second
grace period and a 4-second cooldown:

- An upload that drips a byte a second is answered 408 after the grace
  period. The same user's next upload, at once and in another workspace, gets
  429 with `Retry-After: 4`, the code and the message, and is never admitted
  (no call to the admission). A client that goes on sending after that 429 is
  disconnected about 2 seconds after it. Another admin's restore and preview
  get 200 meanwhile, and the user's own export gets 200. A second later the
  wait is shorter, and once it has passed the user's preview gets 200.
- Fast previews and restores, and fast refusals (a 400 for a `.txt` file, for
  a missing file and for a damaged archive), leave nothing owed: the next
  upload gets 200 and the user has no row.
- A client that sends its part header and hangs up 1.6 seconds after
  admission, before it could be refused for its rate, owes about 3.2 seconds,
  and its next upload gets 429 with less than the full cooldown. A client that
  completes a small file after such a pause gets its preview (200), and its
  next upload gets 429. A client that hangs up after 0.2 seconds owes less than
  the allowance and is admitted at once.
- A second server process (a child process on the same database, with its own
  slots) refuses the user right after their 408 in the first one, without
  taking a slot, and admits another admin; an upload abandoned below the rate
  in the second process makes the first refuse the user.

Run against main's server code (the test's import of the code constant
replaced by its value), the first, third and fourth tests fail: nothing is
owed, and the user's next upload is admitted (200) where the test expects
429. The second passes, as it should.

`tests/backup-cooldown.test.mjs` checks what is asked of the database: a 408
owes the cooldown plus its fifth (144 seconds at the defaults), a shortfall
owes cooldown ÷ grace per second and never more than that cap, no shortfall
writes nothing, a failed write is logged without changing the answer, 0
reads and writes nothing, and the refusal's status, header, code and message.
`tests/backup-staging.test.mjs` checks the shortfall itself: silence counts
in full, inside the grace period too; bytes cover their share; it is measured
up to the stop; at the minimum rate there is none; time the server is not
reading is left out. `tests/env-validation.test.mjs` checks the default, an
empty value, 0, 3600 and the refusals of -1, 3601, fractions and words.
`backup-upload-rate.test.mjs` turns the cooldown off, so its cases can reuse
the admin an earlier case had refused; that also shows 0 turns it off.

The frontend test `backup-settings.test.tsx` uses the real hooks, ky client
and error parsing with a stubbed `fetch`: a paused preview shows the message,
counts 2, 1 and then clears, keeps the file picker disabled and sends nothing
meanwhile, then previews; a paused restore keeps its preview and disables
Confirm Restore for 120 seconds, then restores; a workspace-busy 429 and a
408 are shown as toasts without a countdown. Against main's backup page, the
first two fail.

## Remaining limits

- A client that reconnects after each 408 can no longer keep slots busy
  while sending almost nothing: this is closed by the cooldown above, also for
  a client that hangs up, or completes a small file, just before its 408. What
  remains:
  - Each upload is still admitted before it can be measured, so one account
    can hold up to three slots (one per workspace) for the grace period before
    its first refusal, and about a fifth to a quarter of the time after that.
  - The cooldown is per user. Anyone can register (unless registration is
    restricted) and create workspaces, so someone with several accounts can
    take turns between them and keep slots busy for longer. A reverse proxy
    that receives whole uploads before passing them on (recommended) prevents
    this, since a slot is then taken only once an upload has fully arrived.
    Per-client request limits at the proxy (nginx `limit_req`, Traefik's
    `rateLimit`) reduce it, but do not prevent it.
- A client that sends at or just above the minimum keeps its slot until its
  upload ends: up to about 19 hours for a 1,088 MiB file at the defaults. A
  reverse proxy that receives the whole body before passing it on (nginx by
  default, Traefik's buffering middleware) means the slot is taken only once
  the upload is complete.
- Export downloads have no minimum rate. A client that reads a few bytes a
  minute keeps its export's slot until the download ends or stops moving for
  60 seconds. A proxy that buffers the whole response (nginx with a large
  enough `proxy_max_temp_file_size`), or a write rate limit at the proxy
  (Caddy), releases it sooner.
- The slot limits (1 per workspace, 3 per process) and the transfer idle
  timeout are fixed, and they apply per server process.
- Exports and restores stay synchronous requests. An export may take at most
  10 minutes, and a request may wait behind two others in the exclusive
  section before its own work starts.
- Parsing and validating `backup.json` blocks the server's event loop for up
  to about 0.6 s ([SEC-028](sec-028.md)), and rewriting asset paths in crafted
  page content up to about 8 s ([backup restore](backup-restore.md)). The
  60-second window absorbs such pauses for uploads in progress.
- The backup page in the web app gives a preview 60 seconds and a restore 120
  seconds in all, upload included; larger files on slower links need the API.
- The proxy settings in the README follow each proxy's documentation; they
  were not tested against running proxies here.
