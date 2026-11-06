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

## Remaining limits

- A client that reconnects after each 408 can keep slots busy while sending
  almost nothing. Each slow upload is still refused, as specified, after the
  grace period (30 seconds by default). By starting a new one each time, one
  client per workspace can hold a slot at a few hundred bytes every 30
  seconds, and three can hold the server's three. A reverse proxy that
  receives whole uploads first (recommended) or per-route request limits at
  the proxy prevent this. A cooldown per user after a 408 is a possible
  follow-up.
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
