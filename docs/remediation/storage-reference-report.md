# Synthetic storage reference report

`buildSyntheticStorageReferenceReport(inputBytes, perReportKey)` builds a bounded,
redacted report from explicitly supplied synthetic metadata. It has no command,
application integration, DB adapter, filesystem/storage/network reader or repair
action. It cannot establish that input is synthetic, complete or an actual
snapshot. Only reviewed synthetic test callers are supplied.

Input is a UTF8 JSON byte view, at most1MiB, and a separate caller-owned32-byte
per-report key. The key is not generated, mutated, retained or emitted. The
envelope has `schemaVersion:1`, a declared40-hex `declaredSourceRevision`, a native
`snapshotNativeTimestamp3` (`YYYY-MM-DD HH:mm:ss.SSS`), explicit roots, and sources.
The revision/root/snapshot declarations are not environment attestations.

Each of `files`, `attachments`, `avatars`, `wikiPages`, `wikiVersions` and
`cleanupQueue` must be an array or null inside `sources`. Null means not supplied;
an empty array means an empty synthetic sample, not proof of absence. Rows use:

| Kind | Fields |
|---|---|
| files | rootSlot, storagePath, thumbnailPath, trashed, isFolder |
| attachments | rootSlot, storagePath, fileId |
| avatars | avatarUrl |
| wikiPages / wikiVersions | contentJson (serialized JSON string) |
| cleanupQueue | rootSlot, storagePath, attempts, availableAt, createdAt |

Paths/URLs may be null except the queue path. An empty supplied reference string
contributes a fixed EMPTY_REFERENCE unknown diagnostic, including queue paths;
ordinary nullable reference fields remain null. A null rootSlot remains unresolved
and never joins a global unknown root. Root declarations have unique slots0–7,
kind CONFIGURED_STORAGE / AVATAR_STORAGE / LEGACY_UPLOAD, and bindings with an
exact HTTP(S) origin or null for relative URLs plus an exact routePrefix ending
in `/`. No physical root is read. Overlapping bindings are ambiguous.

All strings used for matching/identity are checked for well-formed UTF16 after
JSON parsing and before UTF8 encoding or HMAC. Lone high/low surrogates reject
structural/root declarations or skip malformed reference strings as UNKNOWN.
Malformed wiki keys skip their key/value subtree. Valid pairs/non-BMP text and
literal U+FFFD remain valid; no replacement repair or Unicode normalization runs.

HMAC-SHA256 frames every domain/field with a four-byte big-endian byte length.
Root IDs include slot/kind/exact sorted bindings; path IDs include root ID and
exact candidate bytes; interpretation IDs additionally separate modes. No raw
path, URL, content, ID/email, native error or key appears in normal/error output.

File originals/thumbnails, trash/folders, Attachment cached paths, global avatar
and both current/version wiki strings contribute observations. Queue metadata is
separate from resource reference evidence. Its native millisecond strings are
compared without UTC conversion or an application clock: due-at-snapshot,
unattempted-deferred, attempted-deferred/ambiguous, or invalid/unknown metadata.
These labels do not identify producers, grace/leases/retries or ownership.

Raw DB paths remain exact. Whole-string URLs retain raw suffix first, an optional
URI suffix before literal query/fragment, and at most one percent decoding of
each (max4 modes). Plus stays plus. No dot/slash normalization or physical probe
chooses an interpretation. Embedded text/HTML, custom/foreign/unsafe/malformed
tokens and unmapped roots are explicit unknown coverage. JSON keys as well as
string values are inspected. The existing recursive/access-filtered backup
extractors are not used.

Proof limits are100rows/kind,8roots/16bindings,4096UTF8 bytes/token,16KiB content
JSON/row,depth32,width64,8192visited nodes,4194304scanned UTF16 code units,
1024observations,256identities and256KiB output. Byte caps precede bounded parsing;
iterative traversal avoids enqueueing an unchecked level. Caps/omissions produce
UNKNOWN and lower-bound observations, never inferred skipped-reference totals.
Output overflow returns a minimal <=2048-byte redacted OUTPUT_LIMIT report with
empty facts and UNKNOWN_NOT_ZERO coverage, not a false empty census.

Every report is INCOMPLETE_SYNTHETIC (or INVALID_INPUT), physicalState NOT_OBSERVED,
and completeForDestructiveUse false. No orphan/deletable/unused/cleanup conclusion
exists. Physical bytes, legacy blobs, unregistered producers, external copies,
other fields, concurrent lifecycle and environment truth remain excluded.

This synthetic tool does not classify the audit's21 preserved legacy blobs.
Live/disposable adapters, bounded retrieval, root/symlink/public-hosting trust
(R33), owner-selected environment/read-role/repair (R35), producer crash windows,
worker throughput and final R26 acceptance require their separate work. No live
inventory or repair instructions are provided here.
