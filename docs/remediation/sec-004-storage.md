# Storage write containment

Buffer and streaming writes validate their final path against the storage root before
creating directories or opening files. This closes the lexical traversal path through
category, scope, filename or extension, and preserves valid nested paths and contents.

Run `pnpm --filter @pm/backend exec node --import tsx --test tests/storage.test.mjs`.
The tests use disposable local directories, verify denial without files/directories
outside the root, reject sibling-prefix escapes, and check legitimate buffer/stream bytes.

Stream creation retries the complete directory-and-file attempt, up to three times,
when a missing-path error occurs during recursive directory creation or file opening.
A failed concurrent write may remove empty ancestors while either operation is in
progress. The paths created by earlier attempts remain tracked for failure cleanup;
permanent errors such as denied directory access are returned immediately, and an
unread source is destroyed if creation cannot complete. Existing files and directories
used by successful concurrent writes are preserved.

The storage tests coordinate actual failed-write cleanup with a one-shot missing-path
error during mkdir, and with removal between mkdir and open. They verify successful
bytes, failed-write cleanup, bounded retries, permanent errors and unrelated paths,
in addition to the existing 200-round concurrent-write stress check.

This is the storage-provider part of SEC-004/A07. Upload membership/role checks are a
separate fix. This check assumes storage directories do not contain attacker-controlled
symlinks; symlink lifecycle, resource limits and cancellation remain separate work.
