# Wiki JSON storage contract

Wiki page `content` and comment `selectionStart` / `selectionEnd` previously
accepted arbitrary values. Content at 124 nested containers reached Prisma
and returned 500. NUL in a string or member name reached PostgreSQL; an
unpaired surrogate reached Prisma. A JSON number such as `1e400` parsed as
Infinity and was silently stored as null. A selection nested 122 levels could
be saved but made a depth-limited backup impossible.

The shared request schemas and wiki service boundaries now validate those
fields before writes. A refusal is HTTP 400 with a fixed message and the field
in `details`; it does not quote JSON values or member names. Refused writes
leave page rows, revisions, version history, comments and realtime events
unchanged.

| Field | Maximum object/array depth | Depth in `backup.json` |
| --- | --- | --- |
| Page content, including a version snapshot or restore | 123 | 128 |
| Comment selection start or end | 121 | 128 |

Scalars have depth zero. Each object or array adds one, including empty
containers; object, array and mixed nesting use the same rule. Prisma stores
123 levels in a single-row JSON write. The backup envelope adds five levels
around page content and seven around comment selections, and its existing
whole-file cap is 128. These limits are separate from the wiki parent-page
hierarchy and its graph budget.

Supported values remain format-independent JSON: objects, arrays, strings,
finite numbers, booleans and null, subject to the literal-member exclusions
below. Normal editor documents need no migration.
String values and member names must contain neither U+0000 nor an unpaired
UTF-16 surrogate. Valid surrogate pairs, Unicode normalization forms and other
characters that JSON storage supports are retained. HTTP's existing request
body byte limit continues to bound wide inputs; no new item-count limit is
introduced here.

Objects with an own `__proto__` member or an own
`__prismaRawParameters__` marker equal to boolean `true` are refused at every
nested position. The locked Prisma serializer drops the former during normal
member copying and interprets the latter as raw-parameter data, so accepting
them would silently change literal JSON. Direct marker accessors are also
refused without invoking them. These inherited serializer behaviors are not
new regressions; the storage contract explicitly excludes them. Ordinary
`$type`, `values`, `constructor`, `prototype`, string-valued `toJSON` and
disabled/non-true raw markers remain supported literal data. No submitted
JSON is escaped, stripped, rewritten or cloned to bypass these exclusions.

Omitted fields remain omitted. Creating a page with omitted or null content
keeps the existing SQL NULL behavior. A PATCH that omits content keeps the
stored content; explicit null writes JSON null as before. Comment selections
keep their previous optional/null behavior. This change does not normalize,
truncate or replace values.

Restoring a version with null content now clears the page to JSON null. Every
version captures page content, so null represents an empty snapshot. Previously
restore omitted that field and incorrectly kept newer non-null content. Both
SQL NULL and JSON null in historical versions restore empty content, while the
replaced content is recorded as a new version in the existing transaction.

`jsonStorageIssue` walks containers iteratively, checks depth before descending
and stops on the first problem. It returns the original value through the
schema without copying its contents. Its explicit stack and cycle detector
track the active path; JavaScript's object-key enumeration may also buffer
keys of a wide object. Direct service callers get the same checks, including
cycles, non-finite numbers and non-JSON values. Repeated noncyclic references
are accepted. Accessors and `toJSON` methods are never invoked by validation.

Existing rows and historical versions are retained. Reads and comment body
edits do not revalidate stored JSON. When an actual snapshot would copy
unsupported legacy content, the operation returns 400, says "Stored page
content cannot be versioned" and keeps all rows. This includes a title/icon
edit when an auto-save snapshot is due; it identifies the stored-content
problem separately from invalid new input.
Restoring unsupported historical content likewise returns 400 before writing
the replaced page's snapshot. A throttled save that needs no snapshot can
retain legacy content. Existing edit-lock, revision and tenant checks continue
to apply. This patch performs no legacy repair.

The bounds ensure compatibility with the backup depth envelope. Aggregate
backup byte, token and object budgets still apply, so a whole space may need
to be exported in parts. The backup parser's bounded validation and memory
budgets are unchanged. Its existing JSON storage check also rejects non-finite
numbers and the same unsupported object members in page content, selections
and activity details, so preview and restore refuse values that would be
silently changed. Overflow numbers are rejected before being converted to null.
Other shared JSON fields, graph limits and the broader
C07 contract work remain separate.

The shared schema regressions cover exact limits and the next level for
objects, arrays and mixed containers, member names, Unicode, primitives,
cycles, wide values and very deep direct input. The integration suite uses
actual loopback HTTP and PostgreSQL for create, update, comments, named
snapshots, historical restores and refused-write side effects, alongside
revision, edit-lock and workspace access checks.
