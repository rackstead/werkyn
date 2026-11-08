# Absolute timestamps for the blob cleanup queue

`BlobCleanup.availableAt` and `createdAt` use `TIMESTAMPTZ(3)` after migration
`20261108120000_blob_cleanup_absolute_timestamps`. They represent instants,
independent of the PostgreSQL connection's `TimeZone`. Both database-clock
writers and Prisma's UTC `Date` writes therefore agree. Cleanup no longer
waits an extra timezone offset for failed-upload staging, or an extra repeated
hour for a due time or lease written before daylight-saving fall-back.

## Legacy interpretation and upgrade premise

The owner confirmed that this application has no deployed installation or
real data. The migration adopts **UTC** as the explicit interpretation of any
legacy `TIMESTAMP(3)` fixture values, using `AT TIME ZONE 'UTC'` for both
columns. It does not infer a timezone from the migration session, server
settings, row age, or which writer might have produced a row. Existing paths,
attempt counts, errors, precision, defaults and the due-time index are retained.
The type changes run in one transaction and take PostgreSQL's table lock while
rewriting the queue and its index; run migrations with application workers
stopped, as for the supported upgrade procedure.

A different installation with an existing non-UTC or mixed-writer legacy queue
does not meet this premise. Those wall times do not encode their original
offsets, and a repeated local hour cannot be reconstructed from the values
alone. Such an installation needs an explicit, source-based conversion plan
before using this migration; the repository's UTC conversion is not a repair
algorithm for unknown historical data. A code-only rollback after migration
is incompatible with the old retry fence and local-time copy writer.

## Writers, eligibility and fencing

- Defaults and delete/update triggers use `CURRENT_TIMESTAMP`, which is already
  an absolute timestamp. Restore/copy staging grace, claim leases, retry backoff
  and failure renewal keep that type throughout their arithmetic.
- The failed-copy due-now floor uses `date_trunc('milliseconds',
  CURRENT_TIMESTAMP)` without casting away the timezone. A first-pass repeated
  hour therefore stays the first occurrence.
- Storage still rounds to the nearest millisecond. Eligibility retains
  `CURRENT_TIMESTAMP::timestamptz(3)`, so a due-now value rounded up is available
  to the following claim. The existing maximum rounding lead is below 1 ms.
- Retry matches the exact path, attempt count and claimed timestamp using the
  returned UTC ISO timestamp cast as `timestamptz(3)`. Retirement uses Prisma's
  equivalent instant. Changing a connection timezone cannot shift either
  comparison, and a newer lease still defeats an old worker's retry/retirement.
- `FOR UPDATE SKIP LOCKED`, the 15-minute lease, backoff, one-hour staging grace
  and live-File guard retain their existing behavior.

## Validation

The PostgreSQL tests reproduce Prisma-staged cleanup waiting about eight hours
in America/Los_Angeles and first-occurrence fall-back due times/leases being
missed on the prior schema. They cover immediate staging cleanup in UTC, Los
Angeles and Kathmandu; the existing rounded due-now and cross-fall-back lease
guards; retry, stale-retry and retirement after a session-zone change; and
populated legacy-shape upgrades under three migration session zones. The
upgrade fixtures verify UTC interpretation, metadata/default/index preservation
and atomic refusal of a malformed legacy shape.

The offline synthetic storage-reference report keeps its declared timestamp
string format. An exporter of these absolute queue timestamps must first render
both timestamps and its snapshot in UTC, for example
`to_char("availableAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS')`.
Arbitrary local timestamp strings are not interchangeable with those UTC
declarations. The report still establishes no physical absence or deletion
authority.
