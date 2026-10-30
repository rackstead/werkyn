# Backup transport: concurrency and staged uploads

Backup export, preview and restore had no limit on how many could run at once.
Each preview or restore may need the whole SEC-028 parse budget (about 170 MiB
of heap above the app at the worst accepted `backup.json`), so a few concurrent
requests could exhaust a process that survives any one of them. The routes
require workspace ADMIN, but any signed-in user can create a workspace and is
its ADMIN.

Uploads were also held in memory twice over. The controller collected the
whole multipart file (up to `MAX_FILE_SIZE`, 10 GB by default) into one buffer,
and adm-zip then inflated every embedded file into another buffer before the
restore wrote it out. Previewing and restoring a 192 MiB archive raised the
server's peak RSS by 612 MiB. An upload larger than `MAX_FILE_SIZE` was cut off
silently by the multipart parser and then reported as a damaged archive.

## Concurrency

Every backup route is admitted before it reads an upload or the database, and
after the caller has been authenticated and authorized:

| Limit | Value | Response when exceeded |
|---|---|---|
| Requests per workspace | 1 | 429 Too Many Requests |
| Requests per server process | 3 | 503 Service Unavailable |

Both responses carry `Retry-After: 30` and a fixed message that the backup
page shows. Admission is refused at once rather than queued. It is held until
the request's handler has finished, which happens on success, on error and when
the client goes away: an upload whose client disconnects fails and removes its
staged file. A restore that has already started still finishes or rolls back as
one transaction, and only then releases its admission.

Admitted requests take turns in one exclusive section, in arrival order. That
section covers reading `backup.json`, parsing and validating it, and the
preview or restore itself, and for export, building the archive. These are the
steps whose memory the SEC-028 budget bounds for a single request, so the
budget, and its recommendation of at least a 384 MiB heap, now holds for the
whole process rather than per request. Uploads to the staging area run outside
the section, so a slow client does not hold up other workspaces' processing. A
request whose client disconnects while it waits for its turn is skipped.

## Staged uploads

An upload is streamed to a file in the staging area, `STORAGE_DIR/.tmp/backup`,
and never held in memory as a whole:

- Each file is `upload-<uuid>.part`, created with mode 0600 in a 0700 folder.
  No route serves this folder; workspace-scoped storage routes only accept ids
  without a dot.
- The upload is limited to the smaller of `MAX_FILE_SIZE` and 1,088 MiB: the
  1 GiB archive budget, plus room for headers and a directory of 10,000
  entries. Beyond that the response is a 413 and the partial file is removed.
- An upload that sends no bytes for 60 seconds is abandoned with a 408.
- The staged file is removed on every path before the response is sent, so a
  client can start its next backup request as soon as it has the answer.
- At startup, before the server accepts requests, staged files left by a
  process that stopped mid-request are removed. Only names of the form above
  are touched. Like the rest of the app, this assumes one server process per
  storage directory.

The archive is then read from the file by position instead of from a buffer:
the end record from the last 64 KiB, the central directory through a 1 MiB
window, and one small read per local header. The SEC-025 inspection rules and
limits are unchanged, so exactly the same archives are accepted and refused.
adm-zip is no longer used to restore: entry data is read straight from the
file, inflated with zlib, and must come to exactly its declared size and
CRC-32. Inflation stops as soon as an entry exceeds its declared size.

Only `backup.json` (at most 24 MiB) is read into memory. Every embedded file is
streamed once to verify it before anything is written, as before, and again
when the restore copies it into storage. A legacy plain `.json` upload over the
24 MiB `backup.json` limit is refused by its size, before it is read.

## Measurements

A 192 MiB archive (three 64 MiB incompressible images plus `backup.json`) was
uploaded over HTTP to a fresh server process with a 256 MiB heap, previewed and
then restored:

| Peak RSS | Idle | After preview | After restore | Growth |
|---|---|---|---|---|
| Before | 186 MiB | 716 MiB | 798 MiB | 612 MiB |
| After | 182 MiB | 220 MiB | 221 MiB | 39 MiB |

All three restored images matched their source bytes. Staging the 256 MiB
stream of the unit test buffers less than 64 MiB at any moment.

## Behavior changes

- A second backup request for a workspace while one is running gets a 429; a
  fourth request in the process gets a 503. Both say when to retry.
- An upload over the limit gets a 413 instead of being truncated and refused
  as damaged. A stalled upload gets a 408.
- A checksum mismatch is logged with the reason `crc-mismatch`, and an entry
  that inflates past its declared size with `size-mismatch`; adm-zip reported
  both as `read-failed`. The responses are unchanged.
- A restore reads each embedded file from the archive twice (verify, then
  copy) instead of holding it in memory.

## Tests

`tests/backup-concurrency.test.mjs` and `tests/backup-staging.test.mjs` run in
`pnpm test`. They cover the documented limits, per-workspace and per-process
admission, release after success and error, the order and exclusivity of the
exclusive section, skipping a request aborted while it waits, staging without
buffering, the size limit at and one past its boundary, the idle timeout,
interrupted uploads, and the startup sweep. `tests/backup-archive.test.mjs` now
reads every case from a buffer and an export-shaped archive from a file too,
and checks that inflation stops just past the declared size.

`tests/integration/backup-transport.test.mjs` runs the real app on a loopback
port and drives it over TCP:

- staged files left before startup are removed, and other files are kept;
- with uploads stalled halfway, a second request for the same workspace gets a
  429 and a fourth workspace gets a 503, both with `Retry-After: 30`; aborting
  one upload removes its staged file and frees its admission; a valid restore
  and a corrupt one then finish with 200 and 400, leaving no staged files and
  no admissions;
- while the exclusive section is held, a staged restore waits; a restore whose
  client leaves while waiting never runs;
- an upload one byte over `MAX_FILE_SIZE` gets a 413 and leaves nothing;
- the 192 MiB measurement above, in a separate server process.

On the previous code all five integration tests and both unit test files fail.
The existing backup suites (SEC-009, SEC-025, SEC-028 and restore tests) pass
unchanged apart from awaiting the reader.

## Remaining limits

Export still builds the whole archive in memory before sending it. A client
that keeps sending a few bytes a minute holds its admission; three such
clients, in three workspaces, fill the process. The limits are per process,
and up to three staged uploads of up to 1,088 MiB each can be on disk at once.
Parsing `backup.json` is still synchronous (at most about 0.4 s).
