# Integration test flakes under CI load

## Reset-link policy update (7 November 2026)

New reset requests now retain earlier unexpired, unused links instead of
replacing them. Successful password changes and resets still delete other
unused links, so the password-storm test and its reset lane keep the behavior
described below. The comparison to a link replaced by forgot-password in the
historical explanation is superseded by this retention policy.

Seven tests failed now and then in hosted CI, on main as well as on
unrelated pull requests. Each failure came from the test, not from the
behaviour it checks: a capture window, an order or a wait that held on an
idle machine and not on a loaded runner. This note gives, for each one, the
cause, the fix and the evidence. No flake revealed a product bug. Two test
seams were added to product code (sections 5 and 6); neither changes what
the product does.

The stress loops ran one test file at a time, pinned with `taskset` to two
CPUs shared with four busy-looping processes (about a third of two cores
for the test, its query engine threads and Node), against a migrated
disposable PostgreSQL database. Some causes were also forced with an
injected delay or planner state, which turns "sometimes" into "always" and
shows that the fix holds where the race is lost every time. The loop
scripts and probes are kept with the audit evidence, not in the
repository.

| # | Test | Cause | Fix | Main | After |
| --- | --- | --- | --- | --- | --- |
| 1 | bounded-lists preview | query event after the window closed | marker statement | 20/20 failed (stress), 10/10 (late events) | 0/60, 0/10 |
| 2 | cursor-tiebreak LIMIT | same | same | 6/20 (stress), 10/10 (late events) | 0/50, 0/10 |
| 3 | template assignee order | plan-dependent order | sorted comparison | 10/10 (analyzed table) | 0/50 |
| 4 | time entries snapshot | 50 ms settle heuristic | wait for the outbox | 10/10 (slow claims) | 0/20, 0/50 (stress), 0/50 |
| 5 | ICU restore warnings | recheck between drops | test-run rechecks | 9/30 (stress), 10/10 (slow drops) | 0/50, 0/10, 0/20 (startup loop) |
| 6 | thumbnail extent bound | 20 ms wall clock | count comparisons | 3/30 (stress) | 0/60; a scan mutation fails |
| 7 | password storm | admission and link deletion | two in flight, reset lane | 1/130 (stress), 1/16 (CI) | 0/160 |

"Stress" is the loop described above; the other conditions are explained
in each section.

## 1. bounded-lists: "each preview reads at most ten members"

**Cause.** The test records the SQL of `listChannels` through a Prisma
client's `$on("query")` events and stopped recording as soon as the call
returned. Prisma delivers those events through the query engine's log
callback, which Node runs as its own task, separate from the task that
resolves the statement's result. Under load the result task can run first.
An instrumented run showed the preview statement's event arriving 0.1 ms
after `listChannels` returned (25.6 ms against 25.5 ms), after the window
had closed, so the test failed with "preview statement".

**Fix.** `tests/integration/support/query-events.mjs` adds
`recordQueries(client, run)`. After `run` returns it sends one more
statement on the same client, carrying a unique marker, and stops recording
when that statement's event arrives. The engine reports a statement before
it returns the statement's result, and its log callback delivers events in
the order they were reported, so by then every event of the operation has
arrived. Its timeout only bounds a failure (the marker never arriving).

**Evidence.** On main, under the stress loop: 20 of 20 runs failed with
"preview statement". With every query event delivered 30 ms late (an
injected delay that keeps the order): 10 of 10 failed. After the fix: 60 of
60 passed under stress and 10 of 10 with the injected delay.

## 2. cursor-tiebreak-pagination: "the page query applies LIMIT"

**Cause.** The same capture window as section 1: `sqlOf` stopped recording
when the list call returned, so the page SELECT's event could be missed
("no WikiPageVersion page query", "no Comment page query", "no
ChatChannelMember page query"). The same race was latent in
`search-trigram.test.mjs`, which waited a fixed 50 ms for events in two
places.

**Fix.** `sqlOf` and both search-trigram captures use `recordQueries`.

**Evidence.** On main, under the stress loop: 6 of 20 runs failed (wiki
versions, task comments, channel members), with the CI messages. With query
events delivered 30 ms late: 10 of 10 failed. After the fix: 50 of 50 passed
under stress and 10 of 10 with the injected delay.

## 3. referenced-resource-integrity: "templates validate stored references and explicit instantiation overrides"

**Cause.** The test expected the task created from a legacy template to list
its assignees as `[MEMBER, ADMIN]`. No task endpoint orders assignees; the
template instantiation reads them back with Prisma's `include`, so the order
is whatever plan reads `TaskAssignee`. On a small, never-analyzed table that
is a sequential scan, in insertion order. Late in a full integration run the
table is large and analyzed, the planner uses the `("taskId", "userId")`
unique index, and the rows come back in user-ID order: ADMIN was created
first, so its ID sorts first.

**Fix.** The assertion compares the sorted IDs. Order is not part of what
the test checks (which stored references survive instantiation), and the
sorted comparison still catches a missing, extra or duplicated assignee.
Defining an order only for this endpoint would make it the one task
endpoint with an order; see Limitations. That order is now defined for
every assignee read ([task-assignee-order.md](task-assignee-order.md)),
and the instantiation test expects the stored order: earliest assignment
first.

**Evidence.** With `TaskAssignee` filled with 30,000 valid assignments and
analyzed (the planner then reads a task's assignees through the unique
index), the file failed 10 of 10 runs on main with the CI assertion (the
two IDs reversed). After the fix, the whole file passed 50 of 50 runs on
the same database.

## 4. referenced-resource-integrity: "time entries reject foreign references and task/project mismatches"

**Cause.** `assertRejectedAtomically` compares snapshots (including
notifications) taken before and after the rejected requests. The template
instantiations of the previous test commit a `NotificationDelivery` row
with the task and run its first delivery after responding, without awaiting
it. The old settle step waited only until the notification count stayed the
same for 50 ms. When the delivery took longer than that, its
`TASK_ASSIGNED` notification was created after the "before" snapshot (main
at ebcfb0f).

**Fix.** `drainNotifications` waits until no outbox row for the test's
users is still to be delivered. A delivered row is deleted after its
notifications commit; a failed attempt records its error and leaves the
retry to the delivery worker, which these tests do not run. So once no row
without an error is left, no notification is still to come. The 10 s
deadline only bounds a failure.

**Evidence.** With a probe trigger that makes each outbox claim sleep
300 ms (a slow first delivery attempt), the file failed 10 of 10 runs on
main with the CI diff (a `TASK_ASSIGNED` notification in the "after"
snapshot). After the fix it passed 20 of 20 with the same trigger, 50 of 50
under the stress loop on a fast-commit database, and 50 of 50 with the
analyzed `TaskAssignee` table above. The stress loop alone did not
reproduce it on main here (20 of 20 passed); the delayed claim does every
time.

## 5. search-trigram: "a libc dump restored into an ICU database"

**Cause.** The test starts the server's search index check with a 50 ms
recheck, runs the five DROP INDEX statements one after another, and
expected exactly two warnings. A recheck that ran between two of the drops
found fewer trigram indexes, a different warning, and logged it, so the
test saw three. That is the product working as designed: the warning
names the indexes still present, and a changed warning is logged again.

**Fix (product seam).** `startSearchIndexCheck` takes an options object,
`{ intervalMs, timer }`, in place of its `intervalMs` argument. `timer`
schedules a recheck and returns its cancel function; the default is the
previous unref'd `setTimeout`, and `server.ts` passes no options, so
production behaviour is unchanged. The tests pass a manual timer and run
each recheck themselves. The ICU test now also asserts what happens when a
recheck lands between the drops (a second warning naming the four indexes
left, still avoiding them) and that no recheck is scheduled once the
fallback is lifted. The startup-loop test in the same file, which counted
rechecks after real 150 ms sleeps, uses the manual timer too.

**Evidence.** On main, under the stress loop: 9 of 30 runs of the ICU test
failed with the CI assertion (`3 !== 2`). With each DROP INDEX returning
80 ms late (an injected delay, so a 50 ms recheck lands between drops):
10 of 10 failed. After the fix: the ICU test passed 50 of 50 under stress
and 10 of 10 with the injected delay, and the case-folding test that holds
the startup-loop check passed 20 of 20 under stress.

## 6. thumbnail-admission: "container checks stop after a bounded amount of work on crafted files"

**Cause.** The check that AVIF item extents are located by binary search
(not by scanning every `mdat` box for every item) asserted a fixed 20 ms
wall-clock bound; a CI run measured 20.25 ms.

**Fix (product seam).** `thumbnail-checks.ts` exports a counter,
`avifExtentLookups.boxesCompared`, incremented once per data box the
binary search compares. The test asserts that the 681 extents of the
2,000-box fixture compare at most 681 × ⌈log2 2,001⌉ = 7,491 boxes, where a
scan compares 1,321 to 2,000 per extent. The count is deterministic and
fails the scan regression the timing bound was written for. The
calibrated allowances for the four 32 MiB walks in the same test are
unchanged.

**Evidence.** On main, under the stress loop: 3 of 30 runs failed, at
20.26, 25.29 and 28.78 ms. After the fix: 60 of 60 passed. With the binary
search replaced by a scan of every box (a mutation), the new assertion
fails.

## 7. password-change-atomicity: "a mixed storm of changes, resets, logins and refreshes never deadlocks"

**Cause.** Two outcomes the product produces on purpose decided whether the
storm had any successful reset, which the test requires so that its
write-log checks cover resets:

- The server runs at most two password hashes or checks at once and refuses
  any other at once with 503 "Password checks are temporarily unavailable"
  (`utils/passwords.ts`, no waiting queue). The storm sends up to about
  twelve such requests at once, so admission refuses most of them: 73 to
  76 % of changes, resets and logins across sixteen hosted CI runs on main,
  and 72 % of resets in thirty local stress runs.
- A successful password change deletes the account's unused reset links
  (`users.service.ts`), and a reset with a deleted link is answered 404
  "Invalid reset token", as one replaced by forgot-password is. Changes and
  resets target the same two accounts, so an admitted reset can still lose
  its link to a change.

About a third of the storm's eight reset calls won, so a storm with none
was rare but possible: at a6bcc03 fifteen resets were refused by admission
and the sixteenth was the 404 above, which is expected. In the local runs on
main, seven of thirty storms had a single winning reset.

**Did #201 make it more likely?** Not measurably. #201 did not change
`resetPassword` or the admission limit. Its dummy Argon2id verification
runs only for sign-ins without a usable stored hash (unknown address,
SSO-only account, unsupported hash), and every storm login is for an
account with an Argon2id hash, so it does the same single verification as
before. Its reset cooldown and per-minute ceiling apply to forgot-password
requests, which the storm does not make (it inserts reset tokens
directly). The storm mixes in the hosted CI logs of eight main runs before
#201 and eight at or after it show the same hashing load (449 and 450
changes, resets and logins), a similar refusal share (73 % and 76 %) and
similar reset wins (21 and 17 of 120). The admission limit itself came with
the Argon2id change (#184).

**Fix.** Both causes are correct behaviour, so the storm is shaped so that
neither can remove every winning reset:

- At most two password-checking requests (change, reset, login) are in
  flight at a time, the server's admission limit. Each needs one hash or
  check at a time, so every one is admitted and decided by the row locks
  the test exists to exercise. Refreshes are not limited. Admission
  refusals stay covered by `tests/argon2id-passwords.test.mjs`, and the
  storm now asserts that no request was refused by admission (only a busy
  account or link may answer 503), which checks the sizing.
- A third account runs a reset lane next to the four workers: resets with
  one shared link and with two links, refreshes and sign-ins, never a
  change. Each of its reset calls has exactly one winner, which races the
  other copy, sign-ins and refreshes. The two original accounts still take
  every kind of request, so changes still race resets there and may win.

With only the first change, a storm could still have no winning reset: in
sixty stress runs every storm passed, but resets lost their link to a
change 610 times and one storm had a single winner. The reset lane removes
that dependence on luck.

**Evidence.** On main, under the stress loop: 1 of 130 runs failed with
the CI assertion ("the storm changed and reset passwords"; sixteen resets
refused by admission and two answered 404), and 21 more had a single
winning reset. Hosted CI on main: 1 of 16 runs. After the fix: 160 of 160
passed under stress; every storm had at least 5 winning resets (4 of them
from the reset lane) and at least 10 winning changes, and no request was
refused by admission. Slowing every Argon2 job by 150 ms did not change the
refusal share on main (10 of 10 passed), so the stress loop and the CI
mixes are the reproduction here, not an injected delay.

## Limitations

- Task assignee order is defined in
  [task-assignee-order.md](task-assignee-order.md). The first assignee is
  the earliest assignment, and the calendar colour follows that assignee.
- `recordQueries` relies on the pinned Prisma library engine reporting a
  statement before returning its result and delivering its log events in
  order. A Prisma upgrade that changes either would show up as a marker
  timeout or a missed statement in these tests.
- The stress loops approximate a loaded runner; they are not a model of
  GitHub's. The injected-delay and planner-state runs are what show that
  each fix holds when the race is always lost.
