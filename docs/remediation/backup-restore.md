# Transactional, validated backup restore (B03, restore side)

## Problem

Backup restore wrote rows one at a time in one transaction and resolved every
reference through a single map of all IDs in the file:

- A file that could not be stored was logged as a warning and the restore went
  on. The page kept a dead `assets/…` link and the other files stayed.
- Assignee, label, dependency and reaction inserts swallowed their own errors.
  In PostgreSQL that aborts the transaction, so a repeated reference turned the
  rest of the restore into a 500.
- Files written before a failed transaction were deleted best effort. When
  that failed, or the process died first, they stayed on disk with nothing
  pointing at them. Archive files that no page used were always written.
- References were looked up across the whole file. A task could get another
  project's column, label or blocking task. A reply could get a parent in
  another channel. Assignees could be users with no access to the project
  (A10 N3). Self-dependencies and dependency cycles were written as they came
  (DAT-012).
- Repeated IDs in the file were accepted, and the later copy overwrote the
  earlier one in the map. Repeated label or custom-field names failed with a
  409, two wiki spaces of the same name could collide on their slug, and
  repeated or invalid positions were written as is or failed with a 500.
- Preview only counted the file's entries. It agreed with restore only when
  nothing was skipped.
- Restoring 112,000 rows took 57 s locally, and the workspace row stayed
  locked for all of it.

## Design

`restore.service.ts` runs these steps. Preview runs steps 1 and 3 without
writing anything.

1. **Validate** (`restore-validation.ts`). After the `backup.json` limits
   (`backup-json.ts`), the whole file is checked. Anything restore refuses is
   refused here, before any file or row is written.
2. **Write the files.** Only archive files that some wiki page refers to are
   kept. At each `assets/` in a page's text, the longest archive path that
   starts there is the one referred to, so a file named like the start of
   another never takes its place. Each one gets a new storage path. Every path is first added to the
   durable cleanup queue (`BlobCleanup`, see `services/blob-cleanup.ts`), due
   one hour later. Then the files are written. If a write fails, everything
   written so far is removed and the restore stops with the storage error.
3. **One transaction** (READ COMMITTED, 10 s to start, 60 s in all):
   - lock the workspace row and re-read the administrator's role;
   - delete the queued cleanup entries for this restore's files;
   - read the workspace members;
   - run the restore plan (`restore-plan.ts`) and insert its rows in batches.

   A restore that fails for any reason rolls back every row. Its files are
   made due at once and removed through the cleanup queue. A commit removes
   the queue entries in the same transaction, so the files stay.
4. **Crashes.** If the process dies after step 2, the queue entries are still
   there and the cleanup worker removes the files once they are due. A
   cleanup that fails after a rollback leaves its entries due, and the worker
   retries them. If the commit actually went through (an ambiguous error), its
   entries are gone and nothing is removed. If the worker has already claimed
   an entry when the transaction tries to delete it, the restore stops with a
   503 and writes nothing. This takes longer than an hour, so it does not
   happen in practice.

The plan yields each row after the rows it references: a page after its
parent, and a reply after an earlier message. Each new ID is generated before
its row is inserted, in Prisma's cuid shape. The writer buffers up to 1,000 rows
or about 4 MiB. It then inserts them with one `createMany` per table, in
foreign-key order. PostgreSQL checks foreign keys at the end of each
statement, so a row may reference another row of the same batch. Prisma's
engine accepts one level of JSON nesting less in a batched insert than in a
single-row one, so a row whose JSON is deeper than that is inserted alone.
Measured locally, 112,000 rows restore in about 4 s, against 57 s before.

## What restore refuses (400, preview and restore alike)

Messages give a position in the file, such as "project 2" or "wiki space 1",
and never quote its content.

- **IDs repeated within the scope they resolve in.** That is user references
  in the file; statuses, labels, custom fields, tasks, subtasks, comments and
  activity entries within one project; messages within one channel; and pages
  and page comments within one wiki space. The same ID may appear in two
  projects or two spaces, for example when a project was exported twice.
- **Text a column cannot hold.** That is U+0000, an unpaired UTF-16 surrogate
  (which Prisma rejects), or more characters than the column allows (project
  name 255, column, label, custom-field and channel name 100, task and subtask
  title 255, comment 10,000, channel description 500, reaction 32, wiki space
  name 100, page title 500, page comment 10,000, highlight id 100).
- **JSON nested deeper than 123 levels**, or with such a character in a value
  or member name. This covers page content, activity details and comment
  selections. 123 is the deepest Prisma stores in one insert. The
  `backup.json` depth limit of 128 already keeps page content within it.
- **Timestamps PostgreSQL cannot store** (comments, activity, messages, page
  comments), and an **unknown priority or custom-field type**.
- **A dependency cycle among the tasks of one project**, including a task
  blocked by itself. This follows the rules of the dependency API
  ([DAT-012](dat-012.md)).
- **An invalid wiki tree.** That is a parent in another space, a parent cycle,
  or a page more than `graphLimits.maxDepth` (256) pages deep. That is the
  depth breadcrumbs and moves walk.

## What restore repairs, with a warning

Preview reports the same warnings. References are dropped as the A10 repair
report proposes ([DAT-005](dat-005.md#detecting-and-repairing-legacy-data)).
Missing references and references to another project's rows are treated the
same.

| Backup content | Restored as |
| --- | --- |
| Task column outside its project | The project's first column; a project without columns skips its tasks |
| Label, blocking task or custom-field value of another project, or missing | Dropped |
| Assignee who would have no access to the restored project (not a workspace admin, not a restored member) | Dropped (task), cleared (subtask) |
| User whose email matches no workspace member | As before: skipped where optional, the restoring admin where required |
| Reply whose parent is not an earlier message of the same channel | A top-level message |
| Page parent missing from the backup | A root page (as before) |
| Repeated label or custom-field name in a project | Later ones are renamed "Name (2)", "Name (3)"… |
| Repeated assignees, labels, dependencies, reactions, members | Written once, no warning |
| Positions repeated or not an integer in 0..2147483647 within a scope (a column's tasks, a project's columns or fields, a task's subtasks, a page's children) | That scope renumbered 0..n-1 in its previous order |
| More than one completion column | The first keeps it |
| Due or start date that is not a real YYYY-MM-DD date | Left empty |
| Custom-field options and values PostgreSQL cannot store | Dropped with the custom-field warnings ([DAT-013](dat-013.md#backup-restore)) |
| Attachment records | Not restored (restore never wrote them) |
| Archive files no page refers to | Not written |

## Existing data in the target workspace

Restore only adds rows and never changes or merges existing ones. Every row it
writes gets a new ID, and IDs from the file are never written, even when they
equal IDs of rows already in the workspace. Users are matched by email and
never created. New projects, channels and wiki spaces may share a name with
existing ones, as the API allows. A wiki space gets the slug the API would
give it. If that slug is taken in the workspace or by an earlier space of the
same restore, it gets the first free `-2`, `-3`… variant. Restored spaces are
appended after the existing ones. Running the same restore twice gives two
independent copies.

## Older backups

Versions 1.0 and 1.1 are accepted. The first export format (1.0: plain JSON,
no wiki, nulls for unset values) restores unchanged; the integration test keeps
a file in that shape. A file that breaks one of the rules above is refused or
repaired as described, whatever its version.

## Not covered

- Saving wiki page content nested more than 123 levels through the wiki API
  (create or update) still fails with a 500 from Prisma ("recursion limit
  exceeded"). Nothing is written. It is in the wiki module and the shared
  page schema, outside this change.
- Rewriting asset paths in page content looks at each `assets/` in a string
  and tries the archive paths of each distinct length, longest first. That is
  fast for exports, whose file names have few lengths. An archive crafted with
  files of many lengths and content full of `assets/` still costs time
  proportional to both counts multiplied, about as before.
- Export completeness, streaming, transport and concurrent backup requests
  are handled separately (B03 export side).

## Tests

`packages/backend/tests/integration/backup-restore-integrity.test.mjs` uses
real HTTP requests and PostgreSQL. Each case compares every restore-written
table of the workspace, the storage tree and the cleanup queue before and
after:

- A file write that fails, and a database failure late in the restore (a
  trigger on page comments), leave no rows, files or queue entries. When the
  removal fails too, the files stay queued and the worker removes them. A
  child process that exits as the transaction starts leaves its files queued
  for an hour, and the worker removes them then.
- Two projects and two channels that refer to each other restore without one
  cross-boundary row, with the warnings listed exactly. Preview returns the
  same summary.
- 19 refusals, each from both preview and restore, with nothing written.
- Content at 122 and 123 levels restores byte for byte. At 124 it is refused,
  and the restore check refuses it on its own. Wiki trees over the depth budget
  are refused.
- Repeated names, positions, completion columns, dates and references are
  restored as documented.
- Existing rows whose IDs the backup reuses are unchanged, and slugs stay
  unique over two restores.
- An export restores into a fresh workspace with identical counts, links and
  files, and preview agrees.
- A version 1.0 file restores.

Each restore compares preview with restore and the rows written with the
summary counts.
