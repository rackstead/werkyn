# Drive copy staging intent

Drive copy records its freshly planned target path in the durable cleanup queue
before opening the source and writing target bytes. The current production
LocalStorageProvider uses the same deterministic path join. Source and destination
authority checks still run before staging and again under the workspace graph lock.
Names, declared MIME, bytes, ownership and size limits retain their existing rules.

An unclaimed intent has the same one-hour grace as restore staging. The copy removes
exactly that unclaimed intent in the transaction that creates its File. A missing
or already-claimed intent refuses the copy with503 and creates no File. A slow copy
can outlive the grace and be refused; this is not a completion-time guarantee. An
unexpected returned path is never adopted, queued or deleted: only the proved
planned path belongs to this operation.

After irreversible failure, with no File retry, an unclaimed stage is made due for
cleanup. A claimed row keeps its attempts and error; failure renewal advances its
lease by at least one stored millisecond. Workers condition retirement and retry
on the exact attempts/lease they claimed, so an earlier worker cannot remove or
overwrite renewed work for later bytes. Failure-only cleanup inserts the exact
planned path if an earlier worker already removed its row. Retry compares the native millisecond lease
without session-timezone conversion, including transaction-local non-UTC sessions.
The existing live-File guard protects an ambiguous successful commit. Such an error may leave a queued live path
with backoff; no zero-enqueue or automatic-success guarantee is claimed. If cleanup
enqueue itself fails, existing behavior preserves the bytes and logs the known path.

Ordinary tiny-text cases cover pre-write intent, exact successful copy, source and
destination denials, source410, settled write/transaction failures, a return error
after an actual settled commit, claimed leases, a late writer after a completed
one-path sweep, a worker paused between storage and queue-row deletion, unexpected
return paths and retained cleanup retry work. They do
not establish process-crash recovery, sustained draining, universal orphan cleanup
or native/archive/load behavior. The shared worker now fences retirement/retry by
claim identity; upload/thumbnail/restore producers, providers, schema and permissions
retain their existing contracts. Broader R26 work stays open.


Failure cleanup due-now precision

`BlobCleanup.availableAt` uses native `TIMESTAMP(3)`. PostgreSQL rounds extra fractional digits on assignment, so an unrounded due-now value can become a stored millisecond later than a very fast following claim. Failure cleanup explicitly truncates only a newly inserted or unclaimed failure row's due-now value to native milliseconds before storage. The worker eligibility comparison remains unchanged. Claimed rows retain the existing `GREATEST(previous lease + 1 millisecond, CURRENT_TIMESTAMP)` renewal, attempts, errors and native tuple fences; staging grace and backoff are unchanged.

The regressions compare fixed producer `.125600` and later consumer `.125900` instants through native SQL and the real copy/failure-cleanup/worker path with tiny owned files. Their test-only SQL clock adapter records original and transformed templates and verifies the schema default before substituting a delegated default timestamp. UTC and non-UTC component controls cover rounding, later/equal boundaries and the claimed lease fence. These are controlled precision witnesses, not a reconstruction of any prior CI failure's unrecorded fractional query times.
