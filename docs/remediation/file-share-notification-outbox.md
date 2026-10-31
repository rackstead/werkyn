# Atomic member file-share notification intents

The member file-share HTTP endpoint previously committed its `FileShare` rows
before starting a detached notification request. An outbox insertion failure
could therefore return 201 with saved shares and no notification intent.

When `createFileShares` receives the server, it now creates the shares, captures
the existing actor/title/data payload, and enqueues one required `FILE_SHARED`
intent in one ordinary database transaction. An enqueue or payload-read failure
rolls back every newly inserted share. The service starts delivery of the
committed intent after the transaction. No external callback runs inside it.

The HTTP response stays `201 { data: { count } }` after a successful commit.
The count still describes newly inserted rows with `skipDuplicates`. An
all-existing batch returns zero and creates no intent. A partly new batch
continues to notify every requested recipient except the actor, including
recipients who already had a share. Duplicate requested recipients are
coalesced by the existing outbox helper. Self-only requests create no share
or intent. Internal calls without a server retain their existing standalone
write and create no notification intent.

Each notifying batch keeps one group. Its title uses the raw input file count:
two repeated file IDs still say "shared 2 files". A single file uses its name.
The payload still names only the first requested file and the workspace.
The actor's display name is read from the database during the transaction.
This change does not introduce per-file notification policy.

A process exit before commit leaves no new shares or intent. A process exit
after commit leaves the durable intent for the existing notification worker.
Notification preferences and current workspace/file read access are checked
by that worker when notifications are created. Its existing atomic notification
creation, leases, retry backoff and list-refresh behavior prevent duplicate
stored notifications and repeated toast delivery after creation. See
[durable jobs and notifications](dat-010.md).

An unexpected rejected first delivery does not turn a committed share into an
HTTP error. The service catch records a fixed stage, workspace and delivery
IDs, a bounded built-in error kind and an allowlisted network code obtained
only from an own data property. It copies no arbitrary exception text and
reads no accessor properties. Existing delivery-helper logging is unchanged.
Ordinary claim errors resolve to pending. The outer-catch tests use a real
claim fault together with a provided logger that itself rejects that error
report; they do not claim an ordinary claim fault escapes the helper.

`tests/integration/file-share-notification-outbox.test.mjs` uses actual HTTP,
PostgreSQL, physical file bytes, owned process termination and WebSockets.
It covers enqueue rollback, partial duplicates and raw duplicate IDs,
self/pure paths, API-key actors, admission denials, current recipient filters,
bounded diagnostics, fresh-process recovery and actual periodic delivery.
The blocked precommit case releases its advisory holder after killing the
client, so PostgreSQL can finish its submitted statement and observe the
lost connection. The postcommit recovery case advances the helper's logical
clock past the lease; a separate test runs the actual periodic worker against
an unleased due row. Neither case claims wall-clock lease expiry was tested.

This is the member file-share creation subset of the caller-to-outbox gap.
Existing access checks remain in their original order before the write;
in-flight admission and revocation serialization are unchanged. Public share
links, passwords, grants, revisions, schema, response shapes, worker policy
and optional-server behavior retain their existing contracts. This subset
alone does not close the wider notification workflow audit.
