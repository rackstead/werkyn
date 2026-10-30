# Backup transport: concurrency, staged uploads and streamed export

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
preview or restore itself, and for export, building the archive. The finished
export is staged on disk, so its download runs outside the section but keeps
the request's admission until it has been sent or abandoned. These are the
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
- A request that sends no bytes for 60 seconds, whether before its file part
  starts or during the file, is dropped (408).
- The staged file is removed on every path before the response is sent, so a
  client can start its next backup request as soon as it has the answer.
- At startup, before the server accepts requests, staged files left by a
  process that stopped mid-request are removed. Only names of the form above
  are touched. If that sweep fails, the server still starts, but nothing is
  staged until a sweep has succeeded: each backup request retries it first,
  and fails while it cannot. Like the rest of the app, this assumes one server
  process per storage directory.

The archive is then read from the file by position instead of from a buffer:
the end record from the last 64 KiB, the central directory through a 1 MiB
window, and one small read per local header. The SEC-025 inspection rules and
limits are unchanged, so exactly the same archives are accepted and refused.
adm-zip is no longer used to restore: entry data is read straight from the
file, inflated with zlib, and must come to exactly its declared size and
CRC-32. Inflation stops as soon as an entry exceeds its declared size. A
failure to read the staged file is a server error (500), not a damaged
archive.

Only `backup.json` (at most 24 MiB) is read into memory. Every embedded file is
streamed once to verify it before anything is written, as before, and again
when the restore copies it into storage. A legacy plain `.json` upload over the
24 MiB `backup.json` limit is refused by its size, before it is read.

## Streamed export

Export used to read every embedded image into memory, build the whole
`backup.json` string, measure it, and then collect the ZIP into one more
buffer before sending it. Now the archive is written to a staged file,
`export-<uuid>.part`, one entry at a time:

- Embedded wiki images are copied first, straight from storage, one file
  open at a time. Each file is authorized and resolved exactly as before
  (SEC-009), and gets one archive entry however many URLs spell it. Two
  different files with the same name get distinct entry names.
- `backup.json` follows, written in pieces of about 64 KiB as rows are read
  in batches (tasks, messages, pages). Each query asks for the rows after the
  last one read, by creation time and ID. The first query of a list reads 50
  rows; later ones read about 4 MiB of output at the average row size so far,
  between 1 and 500 rows, so a list of large rows (a page or a description
  can be about 1 MiB) is read a few rows at a time. It keeps the previous two-space
  formatting. `metadata` now comes last, because it lists every user the
  content refers to; key order does not matter to restore.
- Every byte is counted as it is written: each image against the per-entry and
  total limits, and `backup.json` against the SEC-028 limits by the same meter
  restore uses (`BackupJsonMeter`). The export stops at the first byte over a
  limit, closes and removes the partial file, and answers with the existing
  400, before any response header is sent.
- An export whose client disconnects while it waits or builds stops at its
  next batch or image and removes its file.
- The finished file is opened, its name removed, and the open file streamed
  to the client with `Content-Length`. Nothing is left on disk whether the
  download completes or is abandoned. A client that reads nothing for 60
  seconds is dropped: the download is watched for moving bytes, which stop
  as soon as the client stops reading. A plain socket timeout would wait about
  twice as long while a write is pending.

## Consistency

An export is one consistent snapshot of the workspace, as pg_dump takes it.
Every read (projects, statuses, labels, fields, members, tasks, channels,
messages, wiki spaces and pages, both reads of the pages, the user
references, and each embedded image's access check) runs in one read-only
REPEATABLE READ transaction. Edits
made while an export runs are not in it at all: a dependency reversed, a
page re-parented or moved to another space, or a status added with a task
moved into it all export as they were when the export started, so the
archive never holds a cycle, a page twice, or a task whose status is
missing.

- The ADMIN check runs on current data immediately before the snapshot
  opens. Each image's access is then read in the snapshot, so the export
  copies what the admin could reach when it began, and needs only one
  database connection (it works with a pool of one).
- Image files are copied from storage, which has no snapshot. A file deleted
  after its page was read is left out and its URL kept, as a missing file
  always has been.
- Exports run one at a time per process (the exclusive section), so the
  snapshot holds one database connection for the build. It is closed on
  success, error, cancellation and refusal, and its rows are never locked, so
  writers are not blocked.
- An export may take at most 10 minutes, image copy included, and the
  snapshot is bounded a little above that. At the deadline, or as soon as the
  client leaves, the export stops whatever it is waiting for, including a
  storage read that has stalled, removes its file and closes the snapshot.
  A deadline, or no free connection within 10 seconds, answers with the
  retryable 409.
- No query in the snapshot may run longer than 60 seconds
  (`statement_timeout`). A batch query still running when the export stops
  is cancelled on the snapshot's own database backend. The cancel is sent
  only while that query runs, and the export waits for it before the
  transaction ends, so it cannot reach another request's query once the
  connection is reused. With a pool of one connection the cancel cannot run,
  and the 60-second bound applies.
- If a page ever referred to an image URL that the image copy had not
  examined, the export would be refused with a 409 rather than written with a
  missing file. With one snapshot this cannot happen; it remains as a guard.

## What a backup contains

A backup is a selective content export, not a disaster-recovery copy. Each
export records this in `backup.json`: `metadata.scope` is `content-export`,
and `metadata.included` and `metadata.omitted` list the keys of
`BACKUP_INCLUDED_CONTENT` and `BACKUP_OMITTED_CONTENT` in `@pm/shared`. Older
files without these fields still restore. The backup page shows both lists,
when exporting and when restoring.

| Content | In a backup | Details |
|---|---|---|
| Tasks | Included | Title, description, priority, position, start and due dates, status, assignees, labels, subtasks, custom field values, dependencies on tasks in the backup, comments, and activity history when selected. Not the archived flag, reminders, creation and update times, time entries or recurrence links. |
| Statuses | Included | Name, color, position and whether it completes a task. |
| Labels, project members | Included | Members as user references. |
| Custom fields | Included | Name, type, options, required flag and position, and each task's value. |
| Attachments | Omitted | Exports write an empty `attachments` list. |
| Files | Omitted | Drive files and folders, team folders, shares and share links. Only images embedded in wiki pages are included, when files are included. |
| Users | References only | The email and name of each user referenced, matched by email on restore. Accounts, passwords, profiles, avatars, workspace membership, groups and invitations are omitted. |
| Rates | Omitted | Billing rates and time entries. |
| Settings | Omitted | Workspace settings, modules, email and sign-in (SSO) configuration. |
| Templates | Omitted | Task templates. |
| Recurrences | Omitted | Recurring task schedules and their occurrences. |
| Wiki | Included | Spaces, pages (title, content, icon, position, parent, author), page comments and embedded images. Not page versions, edit locks or public share links. |
| Chat | Included for public and private channels | Name, description, type, members, messages (content, author, thread parent, time) and reactions. Not direct messages, deleted messages, pins, edits, bookmarks or thread subscriptions. |
| API keys | Omitted | |
| Sessions | Omitted | Sign-in sessions and tokens. |
| Other | Omitted | Notifications and their preferences, dashboards, starred files, and whether projects, tasks and channels are archived. |

## Measurements

A 192 MiB archive (three 64 MiB incompressible images plus `backup.json`) was
uploaded over HTTP to a fresh server process with a 256 MiB heap, previewed and
then restored:

| Peak RSS | Idle | After preview | After restore | Growth |
|---|---|---|---|---|
| Before | 186 MiB | 716 MiB | 798 MiB | 612 MiB |
| After | 182 MiB | 220 MiB | 221 MiB | 39 MiB |

All three restored images matched their source bytes. Exporting the restored
space again from the same process (a 192 MiB archive) raised peak RSS by 2 MiB
more. Staging the 256 MiB stream of the unit test buffers less than 64 MiB at
any moment.

Export of the SEC-028 workspace (4 projects with 6,000 tasks, 12,000 subtasks
and 6,000 comments, 20,000 messages, 500 pages, and 1,512 images of which 12
are 16 MiB, 196 MiB in all) over HTTP from a fresh server process with a
256 MiB heap:

| Export | Peak RSS growth | Peak heap | Time | Archive |
|---|---|---|---|---|
| Before | 704 MiB (187 → 891) | 87 MiB (+39) | 7.4 s | 196.1 MiB, `backup.json` 17,001,365 bytes |
| After | 65 MiB (183 → 248) | 70 MiB (+19) | 8.1 s | 196.1 MiB, `backup.json` 17,002,123 bytes |

Both archives hold 1,513 entries, 6,000 tasks, 20,000 messages and 500 pages.
`backup.json` grew by the scope fields. The "after" row is the final code,
with the database snapshot; peak RSS varies between runs of the same code
(237 to 260 MiB), peak heap less (66 to 70 MiB).

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
- In an exported archive the images come before `backup.json`, and in
  `backup.json` the metadata comes last and carries `scope`, `included` and
  `omitted`. The export response has a `Content-Length`.

## Tests

`tests/backup-concurrency.test.mjs` and `tests/backup-staging.test.mjs` run in
`pnpm test`. They cover the documented limits, per-workspace and per-process
admission, release after success and error, the order and exclusivity of the
exclusive section, skipping a request aborted while it waits, staging without
buffering, the size limit at and one past its boundary, the idle timeout,
interrupted uploads, the startup sweep and its retry after a failure, and, on
a real socket, dropping a request that stalls before its file part, inside the
multipart preamble or mid-file. `tests/backup-archive.test.mjs` also checks
that a failed read of the staged file keeps its errno instead of becoming a
400. `tests/backup-archive.test.mjs` now
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
- while an export's client reads none of a 32 MiB response, a preview in
  another workspace is processed, and a second export of the same workspace
  gets a 429; the download then completes byte for byte, and an export whose
  client leaves mid-download frees its admission and leaves no file;
- an upload one byte over `MAX_FILE_SIZE` gets a 413 and leaves nothing;
- the 192 MiB measurements above, in a separate server process.

`tests/integration/backup-round-trip.test.mjs` exports a fixture workspace
over HTTP with every option: a project with two statuses, two labels, three
custom fields, members, three tasks with assignees, labels, subtasks,
custom field values, a dependency, comments and activity, a channel with
members, a thread reply, a reaction and a deleted message, and a wiki space of
three nested pages with comments and two images. It checks the manifest and
the formatting of `backup.json`, restores into a fresh workspace, and compares
both workspaces entity by entity by name: counts, every relationship, and the
image bytes. Preview and restore report the same counts with no warnings. One
assertion depends on current restore behaviour: the restoring admin is
added to each restored channel's members. `tests/integration/backup-zip-restore.test.mjs`
also checks that refused exports leave no staged file. The round-trip file
also checks, with batches of two and edits made through the HTTP API between
batches:

- the reads run in a REPEATABLE READ, read-only transaction, and an export
  refused over a limit, cancelled, or failing on a database error leaves no
  open transaction and no file;
- a task deleted between two batches does not cut the rest of the list short;
- a reversed dependency, a re-parented pair of pages, a page moved to another
  space, and a new status with a task moved into it each export as they were
  before the edit, and the archive previews and restores with matching counts
  and no warnings;
- a page that gains an image while images are copied exports as it was;
- an export with images completes through a pool of one connection;
- a storage read that never delivers a byte is cut off by a client abort
  (cancelled) and by the deadline (409), within seconds, with the stalled
  stream destroyed and no open transaction or file left;
- a batch query held for 30 seconds in the database is cancelled within
  seconds by a client abort and by the deadline, with no query, transaction
  or file left behind (on the previous code the abort took 30 seconds).

On the code before the snapshot, the four edit scenarios exported a cycle,
a page twice or a missing status, and the isolation check read `read
committed`. Before the stop signal, the one-connection export timed out
waiting for a second connection and the stalled read never ended.
`tests/backup-staging.test.mjs` checks that a download whose client reads
nothing is dropped after the idle timeout itself, and a slow but steady one
never is.

On the previous code all five integration tests and both unit test files fail.
The existing backup suites (SEC-009, SEC-025, SEC-028 and restore tests) pass
unchanged apart from awaiting the reader.

## Remaining limits

An export longer than 10 minutes fails and must be made in parts. A long
snapshot holds back the database's cleanup of old row versions while it
lasts. A client that keeps sending, or reading, a few bytes a minute holds its
admission; three such clients, in three workspaces, fill the process. The
limits are per process, and up to three staged files of up to 1,088 MiB each
can be on disk at once. Parsing `backup.json` is still synchronous (at most
about 0.4 s). A workspace whose export exceeds the restore limits must still
be exported in parts. The public backup documentation does not describe these
limits or the backup's scope yet.
