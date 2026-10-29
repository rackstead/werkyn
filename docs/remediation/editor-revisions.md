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
is written (for tasks, not even the activity entry). Omitting the field keeps
the previous last-writer-wins behaviour, so existing API clients keep working;
the README documents both for API key users.

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
  conditional statements on the caller's own lock row.
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
explains the conflict (naming the lock holder for `EDIT_LOCKED`). Restoring the
draft is an explicit replacement of the version then shown; discarding drops it.

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

- Restoring a version does not take an expected revision; it always keeps the
  replaced content as a version.
- A save whose response is lost after the server stored it is retried with the
  old revision and reported as a conflict; the stored page then shows the
  user's own text.
- Existing duplicate version numbers are left as they are (no unique index).
