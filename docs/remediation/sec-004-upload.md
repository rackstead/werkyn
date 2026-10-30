# SEC-004: generic upload admission

`POST /api/uploads` authenticates the caller, validates bounded workspace/space
identifiers and the avatar/wiki purpose, and checks current workspace membership
before accumulating file bytes or writing storage. Wiki uploads require ADMIN or
MEMBER and a wiki space belonging to that same workspace. VIEWER wiki writes and
foreign-space targeting are denied. Every workspace member may upload their own
avatar; the user scope derives from authentication and cannot be changed by a
multipart userId field.

Avatar uploads accept detected JPEG/PNG/GIF/WebP bytes and use the detected image
extension even when the supplied filename ends in HTML or JavaScript. Wiki uploads
retain their existing arbitrary-file behavior. Uploads are capped at the lower of
MAX_FILE_SIZE and 5MiB for avatars or 25MiB for wiki content (413 beyond). Avatars
are buffered up to their cap for type detection before anything is written; wiki
content is streamed to storage and a refused, stalled or aborted upload removes its
partial file (P03a, `docs/remediation/p03a.md`).

Before this change, an authenticated VIEWER could write wiki uploads, and a MEMBER
could place bytes under another workspace's wiki-space identifier. Disposable
PostgreSQL/HTTP probes reproduce both cases. Regression tests exercise actual
roles/spaces, valid wiki bytes, own-avatar identity/extension, invalid image data,
configured size boundaries, oversized requests, membership revocation and malformed
multipart cleanup. Filesystem snapshots prove rejected requests preserve existing
file paths and bytes. Current frontend avatar callers already supply a current
workspace; unverified members retain profile uploads, including VIEWER accounts.

After migrating an explicitly selected disposable database:

```bash
pnpm --filter @pm/shared build
cd packages/backend
TEST_DATABASE_URL=<disposable-postgresql-url> node --import tsx --test tests/integration/upload-authorization.test.mjs
```

Storage lexical containment is a separate prerequisite fix. Active-content serving
and read authorization are separate changes. This admission patch does not promise
symlink-safe storage or durable cleanup after storage failures. A malformed or
prematurely closed multipart body is rejected with a 400 without storing bytes
(P03a).
