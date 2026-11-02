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
cleanup. A claimed row keeps its lease/attempts. Failure-only cleanup may enqueue
the exact planned path again if a worker swept before a late writer opened it;
skipDuplicates preserves any existing claim. The existing worker's live-File guard
protects an ambiguous successful commit. Such an error may leave a queued live path
with backoff; no zero-enqueue or automatic-success guarantee is claimed. If cleanup
enqueue itself fails, existing behavior preserves the bytes and logs the known path.

Ordinary tiny-text cases cover pre-write intent, exact successful copy, source and
destination denials, source410, settled write/transaction failures, a return error
after an actual settled commit, claimed leases, a late writer after a completed
one-path sweep, unexpected return paths and retained cleanup retry work. They do
not establish process-crash recovery, sustained draining, universal orphan cleanup
or native/archive/load behavior. Uploads, thumbnails, restore, the shared worker,
providers, schema and permissions are unchanged. Broader R26 work stays open.
