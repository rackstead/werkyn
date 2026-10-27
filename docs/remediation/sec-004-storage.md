# Storage write containment

Buffer and streaming writes validate their final path against the storage root before
creating directories or opening files. This closes the lexical traversal path through
category, scope, filename or extension, and preserves valid nested paths and contents.

Run `pnpm --filter @pm/backend exec node --import tsx --test tests/storage.test.mjs`.
The tests use disposable local directories, verify denial without files/directories
outside the root, reject sibling-prefix escapes, and check legitimate buffer/stream bytes.

This is the storage-provider part of SEC-004/A07. Upload membership/role checks are a
separate fix. This check assumes storage directories do not contain attacker-controlled
symlinks; symlink lifecycle, resource limits and cancellation remain separate work.
