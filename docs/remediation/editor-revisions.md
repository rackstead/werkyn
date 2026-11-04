# Server-side revisions and edit locks for editor saves

The wiki and task description editors save on a debounce (FE-009). The client
now binds each save to its page or task and serializes them, but the server
applied every PATCH to whatever was stored. A second tab, another user after a
lock lapsed, an API client or a delayed retransmission could overwrite newer
content without anyone noticing. The wiki edit lock was only shown in the UI,
the auto-save version was written without waiting and could record the wrong
content, and version numbers were `MAX + 1` without serialization.

## Revisions

`WikiPage.revision` advances with every title, content or icon write (saves and
version restores). `Task.descriptionRevision` advances with every description
write; other task fields leave it alone, so a priority or status change never
makes a pending description edit conflict. Both start at 0 for existing rows
(migration `20261030120000_add_editor_revisions`, a catalog-only change).

`PATCH /api/wiki/pages/:pgid` accepts `expectedRevision`, and
`PATCH /api/tasks/:tid` accepts `expectedDescriptionRevision` (with
`description`). A value other than the stored revision is refused with 409,
`code: "REVISION_CONFLICT"` and `current: { revision, updatedAt }`, and nothing
is written (for tasks, not even the activity entry). Wiki edits require a valid
revision for title, content and icon writes. Description edits require a valid
revision even when clearing to null or an empty string; task metadata-only
updates remain independent. Missing or invalid required revisions return 400.
Direct service callers obey the same contract.

## Locks and atomicity

A page save, a version restore, a named version and a lock acquisition each
start by locking the page row (`FOR NO KEY UPDATE`, which does not block the
foreign-key checks of comment or version inserts). Under that lock a save
checks the edit lock, then the revision, records the throttled auto-save version
of the content it replaces, and writes with `revision + 1`, all in one READ
COMMITTED transaction. A lock acquisition therefore either commits before a
save, which then sees it, or waits until the save has committed.

- Another user's unexpired lock refuses a save or a restore with 409,
  `code: "EDIT_LOCKED"` and `current.lockedBy`. Writers without a lock are
  refused only while somebody else holds one.
- A restore always records the replaced content as a version (it used to be
  skipped when an auto-save version was less than five minutes old) and is a
  new revision, so an in-flight save based on the replaced revision is refused.
- Version numbers are assigned under the page row lock and no longer repeat.
- An expired lock of another user is replaced with a conditional delete, so a
  renewal that won the race keeps its lock. Release and renewal are single
  conditional statements on the caller's own lock row, and a renewal only
  extends a lock that has not lapsed: a save by another user may already have
  checked a lapsed lock as absent. Start Editing takes it again. A renewal
  waits for the page row like the other writers, and lock expiry is set and
  compared on the database clock, so a renewal delayed past expiry fails too.
- The description check locks the task row after the project and column rows,
  as every task writer does (see `dat-005.md`).

Lock order: the page row, then its lock and version rows. Moves and deletes take
the workspace lock and then page rows; page writers take no workspace lock.

## Client

The autosave queue sends the revision its edits are based on: the revision the
editor showed while it had nothing unsaved, then each save's own result. Like
the editors' content sync, a revision first seen after unsaved changes were
stored is not taken, since the detail query can still be older than the save.
A 409 edit conflict sets the draft aside instead of retrying it: the page or
description shows the stored document again and is refetched, and a notice
explains the conflict (naming the lock holder for `EDIT_LOCKED`). The editor
stays read-only until the draft is restored or discarded: until the newer
document arrives it shows an older one, and an edit made there would be
refused again and replace the set-aside draft. Restoring the
draft is an explicit replacement of the version then shown; discarding drops it.
A rename or icon change from the page tree first stores the open editor's
pending edits and uses that own acknowledged base (or the displayed tree
revision without an editor), never an automatically fetched latest revision.
The editor's next save builds on its revision when nothing
else was written in between, so the user's own change is not reported as a
conflict.

A rename keeps the revision shown when its input opened, even if a remote
update rerenders the tree. Only a contiguous sequence of acknowledged local
writes may advance that captured base; a refetch cannot silently rebase it.
Outside writes serialize per author/page and resolve the current editor queue
when each operation starts. Failed writes do not advance the local ACK chain.
Successful ACKs update existing matching-base tree/detail cache entries, without
downgrading a newer entry or assigning a revision to unrelated stale metadata.
A task description remains read-only until its first revision is available;
existing unsaved drafts are not discarded or silently based on a new revision.


### A page removed in another session

A deletion event makes an open page unavailable without discarding its unsaved
changes. An ancestor or space deletion first checks the current page, since a
page may have moved; an unaffected page resumes its live edits after that check.
New saves and editing-lock activity stop while the page is unavailable.

An already-sent save may still succeed. Its acknowledgment remains valid; only
its stale cache effects are skipped. Any remaining unsaved fields are set aside
after it settles and stay in this tab, with a read-only preview and explicit
Discard. They are never restored or sent automatically on navigation or reopen.
If the page becomes available again, editing still needs the existing lock and
restoration remains explicit. This does not preserve a new recovery copy of
content that was successfully saved before the page was removed, and adds no
server restore/recreate policy.

## Validation

```sh
pnpm --filter @pm/shared build
TEST_DATABASE_URL="$AUDIT_DATABASE_URL" pnpm --filter @pm/backend exec node --import tsx --test tests/integration/editor-revisions.test.mjs
pnpm --filter @pm/frontend exec vitest run src/features/wiki/components/wiki-page-view.test.tsx src/features/tasks/components/task-description.test.tsx
```

The integration tests run two clients against PostgreSQL. A control
transaction holds the page or task row while requests queue on it, then releases
them in a chosen arrival order: concurrent saves, a save delivered after a newer
one, a save after a restore (and racing one), saves after a lock takeover (and
racing one), concurrent lock acquisition and version snapshots, and the same for
task descriptions. In each case exactly one write is stored and the others get
409 without writing.

## Remaining

- Historical restores already require the reviewed current revision and always
  keep replaced content as a version; see `wiki-history-restore.md`.
- A save whose response is lost after the server stored it is retried with the
  old revision and reported as a conflict; the stored page then shows the
  user's own text.
- Existing duplicate version numbers are left as they are (no unique index).
