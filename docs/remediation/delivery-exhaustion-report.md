# Read-only delivery attempt report

Chat and notification delivery workers admit at most 20 attempts. A completed
delivery removes its outbox row. A recorded final failure leaves a row without
another scheduled attempt. An attempt interrupted after its final claim can
instead retain a schedule and an expired lease: checking only for a null
`nextAttemptAt` misses it. A final attempt with a live lease may still complete.

After building the backend, run the local operator script against the intended
database. It needs `DATABASE_URL`, without application JWT or mail settings:

```sh
DATABASE_URL=... node packages/backend/dist/scripts/delivery-exhaustion-report.js --kind=chat --limit=50
DATABASE_URL=... node packages/backend/dist/scripts/delivery-exhaustion-report.js --kind=notification --limit=50
```

Output is one JSON object. `--kind=chat|notification` is required; `--limit` is
an integer from 1 through 100, default 50. Pass `--after=<nextAfter>` unchanged
to continue the same kind. IDs are opaque, with no trimming or normalization;
an empty stored ID can be represented by `--after=`. Duplicate flags, unknown
options, malformed limits, ill-formed strings, NUL and cursors exceeding 256
UTF8 bytes are refused before a query.

The report contains rows at or beyond the current attempt cap, with only their
ID, attempt count, status and creation/notification/lease/schedule timestamps.
It does not select stored errors, message text, notification content, recipients,
or credentials. Statuses describe the observed row, without inferring why work
stopped:

| Status | Observation |
| --- | --- |
| `cap_reached_lease_active` | Lease expires after `observedAt`; this takes priority even if the schedule is null. |
| `cap_reached_unscheduled` | No live lease and no next scheduled attempt. |
| `cap_reached_lease_expired` | Schedule remains and the stored lease has expired. |
| `cap_reached_scheduled_unleased` | Schedule remains without a stored lease. |

Each invocation uses one repeatable-read, read-only PostgreSQL transaction and
one UTC observation instant rounded down to milliseconds, matching the stored
timestamp precision. SQL statement time is limited to 2 seconds; transaction
wait and duration are bounded to 1 and 4 seconds. The standalone CLI bounds
connection/pool waiting and has a 15-second failure deadline, including
disconnect and actual stdout/stderr write settlement. A blocked output consumer
can therefore cause a fixed failure exit with incomplete output; it is never a
completed report. Consumers must check exit status and parse the complete JSON.
One lazy, core-only Node output child receives bounded output over IPC, without
the database URL or application credentials. This keeps blocked stdout/stderr
out of the parent's deadline clock. At 14.75 seconds the parent attempts the
fixed deadline error. At 14.9 seconds it terminates and collects an output child
that is still pending, reserving time before the absolute 15-second stop. These
internal deadline signals are intentional; ordinary successful output collects
the child without terminating it. Error delivery is best effort when stderr is
blocked, so a nonzero exit may have incomplete error output as well as incomplete
report output.

Rows use the same explicit `C` collation for ordering and the ID keyset. The
query fetches at most the requested limit plus one lookahead. SQL checks ID
length before transferring its value: an oversized ID in the page **or its
lookahead** refuses the entire page, without truncating, skipping or supplying a
continuation. JSON is limited to 256 KiB, plus its final newline. CLI errors
contain a fixed code, without the raw database exception or rejected argument.
These bounds do not establish a general query-performance guarantee on an
arbitrarily large database; a timeout must be investigated rather than called
clean.

`hasMore` describes the lookahead; `nextAfter` is the last emitted ID when more
rows exist, otherwise null. `completeAfterCursor` means no further matching row
was seen after the supplied cursor in **this transaction's snapshot**. It is
not a total count, a scan-wide snapshot across invocations, or an application
health result. Concurrent completion, deletion and new capped rows can change
later pages, including rows whose IDs precede a previously returned cursor.

Exit status is 0 for a successful empty page, 2 when a successful page contains
capped rows (including an active final lease), and 1 for refusal or failure.
Do not attach this report to public readiness or expose its private IDs through
an unauthenticated endpoint.

The script never changes attempts, leases, schedules, notification markers,
recipient IDs, or worker behavior. It does not redrive or reset a delivery.
Review retained records through an authorized operator process; a reset/redrive
tool needs its own concurrency and duplicate-delivery design and review. This
report does not prove exactly-once network delivery or close the remaining
delivery audit work. Validation uses disposable alpha fixtures; no deployed
installation or real-data scan is claimed.

The integration test checks actual worker-cap equality, observed states,
unchanged stored rows, deterministic pagination, selected/lookahead oversized
IDs, maximum escaped-ID output, malformed options, standalone JSON/exit codes,
and PostgreSQL rejecting an attempted write in the report transaction.
The POSIX/Linux FIFO case checks the standalone deadline with an actual blocked
consumer, alongside the ordinary CLI completion controls.
Separate real error pipes exercise a reader that resumes after the deadline
request and one that never drains. Public process/IPC observations check the
single output child and its collection. The earlier two error-delivery controls
both delivered the complete fixed error; a distinct never-drained condition
reproduced a process still alive after 17 seconds and required recorded
termination. This was a deadline stall, not a proven lost-error result.
