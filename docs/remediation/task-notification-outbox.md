# Task notification transactions

Status updates, column moves, assignment and duplication previously committed
their task changes before their controllers called `notify()`. A crash in that
gap lost the notification. An outbox insert failure left a successful task
change without a retryable intent. Status handlers also compared against a
read before the Project lock, so two requests for the same target status could
announce two transitions even though only one occurred.

The four service operations now write their existing notification intent in
the same transaction as the task change and activity. A failed required outbox
insert rolls the transaction back. A process killed before commit leaves no
partial task, copied subtask, activity or intent; one killed after commit
leaves the intent available to the existing delivery worker.

`updateTask`, `moveTask`, `addAssignee` and `duplicateTask` retain their original
arguments and returned task, move warning or assignee DTO. Each delegates to a
corresponding `WithNotifications` entrypoint, which also returns committed
delivery IDs and the project ID for its controller. Both paths perform the
same atomic write; using the original export does not bypass enqueueing.
These internal metadata fields are absent from public `{ data: ... }`
responses. HTTP responses retain their existing 200 or 201 status.

Status changes use the status reread under the existing Project lock. A
same-status update or same-column move creates no status-change intent.
Assignment uses the existing membership/reference transaction, and duplication
notifies only the assignees copied by the existing reference filter. No new
lock, retry, timeout or isolation setting is added. External delivery and
broadcasts run only after the original transaction commits.

The payloads retain their existing types, titles, bodies and data. Assignment
alone includes `projectName`; status changes and duplication retain their own
payloads. HTTP calls supply the authenticated current display name as plain
data, including API-key authentication. Direct service calls resolve the actor
name only when an actual nonactor recipient needs an intent. Actor exclusion,
current access checks, recipient preferences, atomic notification creation,
leases and backoff remain in the existing notification helpers.

Each controller broadcasts its existing event and attempts only the delivery
IDs returned by the committed transaction. An optional broadcast or delivery
failure does not turn a committed operation into a misleading error response.
The controller's defensive diagnostics record fixed operation/stage/source
IDs, built-in error kind and an allowlisted own-data network code. They do not
read exception messages, stacks, causes, names or accessor properties. This
bounded diagnostic rule does not change the central delivery worker's logs.

The existing worker retries pending intents. A retry after notification
creation sends the existing content-free `notification_created` refresh
instead of a second `notification_new` toast. Notification sockets remain
local to the delivering instance. This change adds no HTTP idempotency key,
cross-instance socket routing or stronger global revocation serialization:
delivery still filters current recipients at its existing authorization
boundary, and work admitted before a concurrent revocation may finish.

## Verification

`tests/integration/task-notification-outbox.test.mjs` exercises real
PostgreSQL transactions, TCP requests, API keys, WebSockets and owned child
processes. Its database triggers inject faults and observable lock barriers;
they are test fixtures, not production hooks. Cases cover:

- Required enqueue failures for all four operations, with rollback of task
  state and activity and no success broadcast.
- Two same-target status requests observed waiting at the Project lock, with
  one real transition and one intent; same-status and denied-role controls.
- A process killed during blocked enqueue, and a process killed in a supplied
  postcommit broadcast callback before first delivery. That cutoff does not
  claim a WebSocket frame was transmitted.
- Recovery by a fresh actual notification worker, with a manually requested
  worker pass after socket authentication. This proves fresh-process recovery,
  not the elapsed 30-second interval or lease-expiry timing.
- Public and direct service DTOs, exact source-specific payloads, actor names,
  recipient preferences and access lost before deferred delivery.
- Optional notification-insert failure and retry after an actually received
  toast. Retry passes use an explicit logical due time, not an elapsed-time
  claim; neither creates a second notification or toast.
- Useful, bounded postcommit diagnostics for built-in errors, known/unknown
  codes, accessor properties, thrown values and uninspectable objects.

Existing order/graph, assignment-membership race, durable scheduler, task edit
policy and editor revision suites cover their original compatibility contracts.
No bulk or task-creation notifications are added: those handlers only broadcast
today. Comment, template and file-share integrations are separate caller
changes; this guide covers these four task producers only. The common outbox
contract and its limits remain in [dat-010.md](dat-010.md).
