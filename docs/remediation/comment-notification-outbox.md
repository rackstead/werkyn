# Atomic task-comment notification intents

Task-comment creation previously committed the comment and its activity before
the controller tried to enqueue notifications. An outbox insert failure or a
process exit in that gap left a saved comment with missing notifications.
The assignee and mention groups could also enqueue independently.

`createComment` now reads the task and recipients, inserts the comment and its
`comment_added` activity, and enqueues both required notification groups in one
database transaction. Any required write failure rolls them all back. A
committed comment keeps its notification intents through a process exit before
the first delivery attempt. No external callback runs inside that transaction.

The controller broadcasts and starts delivery only after commit. A failed
realtime callback or first delivery cannot turn the committed comment into an
HTTP failure: it is logged, the response remains 201, and the existing durable
worker retries queued notification delivery. A client can still lose the HTTP
response after a commit. This change adds no HTTP idempotency key; deliberately
submitting the same text twice creates two comments and two sets of intents.

Postcommit request logs retain the operation stage, committed IDs, a fixed
error kind and a small allowlist of network error codes. They copy no arbitrary
exception name, message, stack or cause, and do not read accessor properties.
Unrecognized or uninspectable thrown values receive fixed fallback context.

The HTTP response remains `{ data: comment }`. Existing internal service
fields remain, with committed delivery IDs added for the controller; those
IDs are not exposed in the comment response. The existing `@[userId]` parser
deduplicates mentions. Assigned mentioned users get the mention group, other
assignees get the comment-added group, and the actor is excluded. Existing
title/body/data formatting is retained. The actor's display name and task
context are captured with the committed comment.

Notification preferences and current project/task access are still checked by
the existing delivery implementation. Creation of each group's notifications
and its notified marker stays atomic. A retry after creation refreshes the
recipient's list without repeating the title/snippet toast. Delivery remains
asynchronous and uses the existing leases, backoff and exhaustion behavior;
see [durable jobs and notifications](dat-010.md).

The existing excerpt limit is 100 JavaScript code units. If cutting there would
split a valid surrogate pair, the excerpt ends one code unit earlier. For
example, 99 ASCII characters followed by an emoji produce a 99-character
excerpt rather than an unpaired surrogate that Prisma rejects. The original
comment is preserved in full, and every previously storable excerpt remains
unchanged. No broader text normalization or input limit is introduced.

`tests/integration/comment-notification-outbox.test.mjs` exercises real TCP
HTTP, PostgreSQL, WebSocket notifications and owned process termination. It
covers required-write rollback, both groups, mention/actor/preferences/access
behavior, deliberate separate creates, postcommit callback failure, Unicode
boundaries and fresh-worker recovery. Its blocked-INSERT case releases the
test advisory holder after killing the client, allowing PostgreSQL to finish
the pending statement and observe the dead connection. A separate fixture
callback kills its own process at the first postcommit broadcast boundary,
before notification invocation; that does not claim a frame was sent.

This is the task-comment creation subset of the caller-to-outbox gap. The
other current transactional producers are documented in the
[task](task-notification-outbox.md), [manual-template](template-notification-outbox.md)
and [member file-share](file-share-notification-outbox.md) guides.
Comment edit/delete behavior, authorization and revocation
serialization, file policy, schema, API retry policy and worker timing are
unchanged. Existing backup/import row restoration does not become a new
notification producer.
