# Manual template task notification intents

Manual task creation from a template previously committed its task, subtasks
and activity before the controller attempted to enqueue assignment
notifications. An enqueue failure or process exit in that gap left a saved
task without its notification intent.

The manual endpoint now writes the task and its required assignment intent in
the same existing project-order transaction. Any required write failure rolls
back the task, subtasks, activity and intent. The intent uses the assignees
actually copied or overridden, the created task's title and the same
authenticated actor label as before. Actor exclusion, titles, body and data
formatting are unchanged. Empty or self-only recipient groups create no row.

The controller receives committed delivery IDs internally. It broadcasts and
starts delivery after the service commits, and returns the same 201
`{ data: task }` response without exposing the IDs. Optional broadcast or first
delivery failures preserve that success. Logs retain a fixed stage, task and
delivery IDs, a bounded error kind and allowlisted own data network codes;
arbitrary exception text and accessors are excluded. The existing durable
worker retries queued work, with its existing leases, backoff, exhaustion,
current-access and preference checks. Retries do not create duplicate
notification rows or repeat an already-created notification's toast.

The existing `createTaskFromTemplate` signature and returned task remain
unchanged. Direct service calls still create no assignment intent. Recurring
occurrences continue using that path inside their own transaction, with their
occurrence date, task and schedule advance committed together. They gain no
new assignment notification. Both entry points share one creation body and
one unchanged `withProjectOrder` call; no nested transaction or new lock,
retry, isolation level or timeout policy is introduced.

Stored-reference filtering, explicit overrides, MEMBER auto-assignment,
status fallback, due-offset arithmetic, sanitization, copied subtasks and
archived-project refusal retain their existing behavior. This adds no HTTP
idempotency key: two deliberately submitted manual requests create two tasks.

`template-notification-outbox.test.mjs` exercises real TCP HTTP, PostgreSQL,
WebSockets and owned process termination. It covers enqueue rollback,
precommit death, committed-intent recovery through a fresh worker, public and
direct-service DTOs, actor/preferences/access, API keys, reference filtering,
postcommit diagnostics and recurring compatibility. The blocked old
standalone INSERT can finish after client death and barrier release; that
case proves partial domain commit rather than necessarily lost enqueue. A
separate supplied broadcaster callback kills its own process before actual
broadcast/notification invocation and does not claim a frame was transmitted.

This addresses only the manual-template caller gap. Other caller integrations
are tracked separately in [durable jobs and notifications](dat-010.md).
Template editing, scheduler policy, authorization/revocation serialization,
schema, API retry policy and broader release validation are unchanged.
