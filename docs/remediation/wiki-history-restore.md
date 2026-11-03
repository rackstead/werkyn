# Historical wiki restore revisions

`POST /api/wiki/versions/:vid/restore` requires a JSON body containing
`expectedRevision`, an integer from 0 through 2147483647. It is the current
page revision the caller reviewed, rather than the historical version number.
The version is selected by its unique `vid`; duplicate legacy display numbers
do not affect selection.

Missing, null, fractional, negative, out-of-range and string revisions return
400. A valid revision that differs from the stored page returns 409 with
`code: "REVISION_CONFLICT"` and `current.revision`/`current.updatedAt`.
Neither refusal creates a snapshot, updates the page or broadcasts a change.

The existing transaction locks the page row, checks another user's edit lock,
and compares revisions before snapshotting or updating. An active other-user
lock still returns `EDIT_LOCKED`. A successful restore snapshots the actual
replaced title/content, restores the selected version and advances the page
revision once. The controller broadcasts the committed full page afterward.
Concurrent saves and restores based on one revision have one winner.

History waits for the current user's pending saves to finish before opening.
It captures the page revision from the acknowledged query cache, keeping it
fixed for that panel session even when a remote update refreshes the page.
After a stale restore, the panel stays open and retains the failed target;
the page refreshes for review. Further restores are disabled until the user
closes History, reviews the refreshed page and reopens History to choose
again. Another intervening change is refused again. No conflict revision is
automatically adopted for a retry.

Ordinary wiki PATCH requests still allow an omitted revision. The separate
parked-draft **Restore changes** action and version-label policy are unchanged.
This change has no migration or new lock ordering.

Regression coverage uses actual Fastify request injection and PostgreSQL row
barriers for validation, refusals, snapshots and serialization; this is not
TCP/proxy evidence. The History tests compose the actual page/panel, mutation
hooks, query cache, autosave and lock hooks with mocked transport and a simple
editor input carrier. Browser/editor-library behavior remains a separate
independent review gate.
