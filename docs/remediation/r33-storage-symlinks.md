# Symbolic links in storage (R33)

## Problem

Stored files live below `STORAGE_DIR`. The storage provider checked only
the spelling of a path (`path.resolve` plus a prefix test). Every later open,
`mkdir` and `unlink` followed symbolic links. So a link inside the storage
folder, whether left by an operator, a restored tarball or another process
with access to the volume, decided what the application read, wrote and
deleted:

- **Reads.** Drive downloads, inline previews, thumbnails, public share
  links, attachments, archives, wiki media, avatars and backup exports served
  whatever a link pointed to. That could be a file outside the storage folder
  or another workspace's blob.
- **Writes.** Uploads, copies, thumbnails and restored images were created
  through a linked folder, outside the workspace's folder.
- **Deletes.** Removing a Drive file or purging the trash deleted the file
  behind a linked folder, outside the storage folder.

The uploaded-media routes refused a link only as the file's last component.
The authenticated `/storage/:workspaceId/uploads/*` route, served by
`@fastify/static`, followed links everywhere. The thumbnail worker
refused FIFOs and devices, but not a link to a regular file.

`sec-004-storage.md`, `sec-004-upload.md`, `sec-009.md` and `sec-017.md` left
symbolic links as separate work. `sec-025.md` covers links inside uploaded
backup archives. It does not cover links in the storage folder, which is the
subject here.

Measured on `main` at 49b2d06 with a link planted below the root (one request
each; `evidence/round14-r33-route-probe.log`):

| Case | main | this change |
| --- | --- | --- |
| Drive download, blob is a link outside | 200, outside bytes | 403 |
| Drive download, Drive folder is a link outside | 200, outside bytes | 403 |
| Drive upload, Drive folder is a link outside | 201, file written outside | 403, nothing written |
| Drive delete, folder is a link outside | outside file deleted | refused, outside file kept |
| `/api/uploads/media`, media file is a link | 404 | 403 |
| `/api/uploads/media`, media folder is a link | 200, outside bytes | 403 |
| `/storage/:ws/uploads/*`, file is a link | 200, outside bytes | 403 |
| `/storage/:ws/uploads/*`, folder is a link | 200, outside bytes | 403 |
| Wiki media upload, folder is a link | 201 | 403 |

## Owner decision (5 November 2026)

- `STORAGE_DIR` may itself be a link or a mount point, so operators can move
  storage to another disk. It is resolved once at startup.
- Below it, every symbolic link is refused for reads, writes and deletes. A
  file never resolves outside its workspace folder.
- The legacy public routes (`/storage/avatars/*`, `/storage/uploads/*`,
  `/uploads/*`) stay retired with 410 (#186).
- Public wiki media stays reference-scoped (#186).

## Behaviour

### The storage root

At startup the server creates `STORAGE_DIR` if it is missing, then resolves
it once with `realpath`. Every later access uses that real path. The startup
log names both paths and the access mode:

```
{"storageDir":"/app/storage","storageRoot":"/mnt/disk2/werkyn","access":"descriptor","msg":"Storage root resolved through a link or relative path"}
```

The root may be a symbolic link, a Docker volume, a bind mount or a mount
point. Everything above it is trusted. If you move storage while the server is
running, restart it so that the root is resolved again.

### Below the root

All access goes through one helper, `StorageRoot` in
`packages/backend/src/services/storage-paths.ts`:

- **Folders.** Each folder below the root is opened with
  `O_DIRECTORY | O_NOFOLLOW`, inside the folder opened before it. A link at
  any level is refused.
- **Reads.** The file is opened with `O_NOFOLLOW | O_NONBLOCK`. It must then
  be a regular file. A link is refused, and so are a FIFO, device or folder.
  A socket fails that open with `ENXIO` and is refused the same way. Opening
  a FIFO never waits for a writer.
- **Writes.** New files are created with
  `O_CREAT | O_EXCL | O_NOFOLLOW`, and missing folders are made inside
  their opened parent. A write never opens an existing entry. It therefore
  never writes through a link at its own name or in any folder above it, and
  never into an existing (hard-linked) file. If concurrent cleanup removes a
  folder, the whole attempt is repeated, at most three times as before.
  Folders made by a failed write are removed again while they are empty.
- **Deletes.** A link at a blob's own path is removed itself. Its target is
  never touched, and the removal is logged. A link in a folder above the
  blob is refused, and nothing is removed.

On Linux, a name is resolved inside an open folder by addressing it as
`/proc/self/fd/<fd>/<name>`. This works like `openat(2)`: if someone renames
the folder or replaces it with a link after it was checked, the access still
lands in the folder that was checked. Without `/proc` (macOS development) the
same checks run on full paths. That path fallback is not race-free: any
concurrent writer can redirect accesses. The startup log then reports
`"access":"path"` and logs a warning.

The race was measured with a second process flipping a Drive folder between
the real folder and a link to an outside folder
(`evidence/round14-r33-race-modes.log`). With `/proc/self/fd` that run read
nothing outside the folder. A count from one non-atomic flip of the path
fallback is not a bound on how many accesses a concurrent writer can
redirect. Production Linux uses `/proc`. Startup still warns when the
server is in fallback mode.

### Errors and logs

- **HTTP reads.** A refused read answers `403` with the JSON body
  `{"message": "Stored file is not accessible"}`, before any byte is sent. A
  missing blob answers as before: `410` for Drive, attachments and share
  links, and `404` for media and the `/storage/:ws/uploads/*` route.
- **Archives.** A Drive archive streams entries after its headers, so a
  refused or missing entry ends the response early. Previously a missing
  entry raised an unhandled stream error event.
- **Logs.** Every refusal is logged at `warn` with `storagePath`, `reason`
  (`symbolic-link` or `not-a-file`) and `operation` (`read`, `write`,
  `delete`, `exists`).
- **Background jobs.**
  - Blob cleanup and trash purge keep a refused delete queued in
    `BlobCleanup`, with `lastError: "Stored file is not accessible"`. They
    retry it with the usual backoff, and log each attempt, until the link is
    removed.
  - A thumbnail whose source is refused is skipped (outcome `failed`, with
    the refusal as its reason), and the upload is stored without one. This
    applies whether the server's first-bytes read or the worker's open finds
    the link.
  - If the staging folder (`.tmp` or `.tmp/backup`) is a link when it is first
    used, the startup sweep logs the refusal and every backup request answers
    `403` without staging anything. Once checked, the folder stays open and
    staged files are named through it (`/proc/self/fd/<fd>/<name>`). Replacing
    it with a link later therefore does not redirect a staged file: the file is
    still created, read and removed in the folder that was checked. A folder
    removed meanwhile is checked and opened again on its next use.

### Every entry point

| Entry point | Reads | Writes | Deletes |
| --- | --- | --- | --- |
| `LocalStorageProvider` (`save`, `saveStream`, `read`, `readStream`, `openReadStream`, `open`, `exists`, `delete`) | `StorageRoot.openFile` | `StorageRoot.createFile` | `StorageRoot.unlink` |
| Drive upload, copy, download, inline, preview, thumbnail, archive, public share link, attachments | provider | provider | provider (blob cleanup) |
| Wiki media and avatar upload (`POST /api/uploads`) | — | provider | — |
| Uploaded media (`/api/uploads/media`, `/api/public/wiki/:token/media`) | `storage.open`, then sent from that descriptor | — | — |
| `/storage/:workspaceId/uploads/*` (authenticated) | `storage.open`, then sent from that descriptor | — | — |
| Thumbnail worker (PR #198) | `StorageRoot.openFile` inside the worker, from the root and relative path it is sent | — | — |
| Backup export (images), restore (images) | provider | provider | provider |
| Backup staging (`<root>/.tmp/backup`) | staged files named inside the opened folder and opened with `O_NOFOLLOW` | folders checked and opened once through `StorageRoot.openDirectory` and kept open; files created inside them with `O_EXCL \| O_NOFOLLOW` | sweep and disposal remove names inside the opened folder |
| Blob cleanup worker, trash purge, request-time cleanup | — | — | provider |

Responses for the two media routes are sent from the descriptor that was
checked. On Linux, `@fastify/static` is given `/proc/self/fd/<fd>`, which
reopens exactly that file. Its HEAD, range, `ETag` and `304` handling are
unchanged. The checked descriptor stays open until the response body has
closed. The `/storage/:ws/uploads/*` route sets the same `Content-Type`
`@fastify/static` gave each inline-safe extension. Every other type was, and
still is, sent as an `application/octet-stream` attachment.

The `/storage/:ws/uploads/*` route still serves a folder's `index.html` for a
URL that ends in `/`, and still refuses non-canonical spellings. A folder URL
without the trailing slash answers `403`. Before this refusal, that URL was
`404`, or `200` serving `index.html` when one existed. It was not a `301`.

The legacy public routes still answer `410`. Public wiki media is still served
only for URLs that the shared page references.

### Hard links

Hard links are allowed:

- A hard link is an ordinary directory entry of a regular file. Whatever path
  reaches it is below the root, so the file is reached without leaving the
  workspace folder by any path.
- The application never creates hard links. Copies stream their bytes.
- Only someone who can already write to the storage volume can create one.
  That person can equally copy the bytes.
- Backup tools such as `rsync --link-dest` and `cp -al` share inodes with live
  storage. Refusing files with more than one link would break them.
- Writes only create new files (`O_EXCL`), so a write never modifies an inode
  shared through a hard link. Deletes remove only the directory entry.

### Bind mounts

A mount point is a folder, not a link, so `O_NOFOLLOW` does not affect it.
This was checked in `node:20-alpine` with the built helper
(`evidence/round14-r33-bind-mount-probe.log`):

- The storage root was a bind mount, and a second bind mount sat inside it in
  place of a workspace folder.
- Reads, writes and deletes inside both worked.
- A link inside the nested mount was still refused, and the report listed it.

## Existing installs: finding links

There is no deployed data. However, an installation that moved a workspace
folder to another disk with a link would find its files refused after this
change. Look for links before upgrading.

**Before upgrading,** in the running container of the older version, which
does not have the report script:

```bash
docker compose exec werkyn find -H /app/storage \( -type l -o -type p -o -type s -o -type b -o -type c \) -exec ls -ld {} +
```

`-H` follows the storage folder itself if it is a link (a supported setup),
and no link below it. This lists every link (with its target), FIFO, socket
and device below the storage folder. It also works outside Docker against
the storage folder.

**With this version,** use the read-only report. Run it in the upgraded
container, or, to check before the upgraded server starts, in a one-off
container of the newly built image (`docker compose build` first):

```bash
# After upgrading
docker compose exec werkyn node packages/backend/dist/scripts/storage-link-report.js
# Before starting the new version (no other services are started)
docker compose run --rm --no-deps --entrypoint node werkyn packages/backend/dist/scripts/storage-link-report.js
# From a checkout
STORAGE_DIR=/path/to/storage node packages/backend/dist/scripts/storage-link-report.js [--json] [--limit=N] [--dir=PATH]
```

The report never follows a link. It opens each folder as the server does,
without following a link and inside the folder above it. It only lists
folders, examines entries and reads link targets. It prints each entry's
path below the root, its kind and, for links, the target. Its exit status is
`0` when nothing was found, `2` when something was found or a folder could
not be listed, and `1` on error. Folders that the image's user cannot list
are reported as unreadable; if that happens, run the one-off container with
`--user root`.

At startup the server also checks the top level of the root and warns about
each link there.

To fix each finding, do one of the following:

- Replace the link with the folder or file it points to. Stop the server,
  move the target into place, then start the server again.
- Mount the other disk at that path (a bind mount or a Compose volume)
  instead of linking to it.
- Make `STORAGE_DIR` itself point at the other disk.

Remove FIFOs, sockets and device files. The application never creates them.

## Remaining limitations

- **Path fallback.** Without `/proc` (macOS development) the checks run on
  paths. The path fallback is not race-free: any concurrent writer can
  redirect accesses. Production images run on Linux with `/proc`, and
  startup still warns when the server is in fallback mode.
- **Kept-open staging folder.** The server keeps one descriptor of the
  staging folder open. If that folder is removed while running, its next use
  checks and opens the new folder, and the old descriptor stays open too.
- **Trusted root.** The root and everything above it are trusted, as the
  owner decided.
- **Cost.** Each access opens one descriptor per folder level below the
  root, about five more `open`/`close` calls for a Drive blob. The report
  walks the whole tree.
- **Folder URLs.** `/storage/:ws/uploads/<folder>` without a trailing slash
  answers `403`. Before the refusal it was `404`, or `200` serving
  `index.html` when one existed, not a `301` redirect.

## Tests

- **`packages/backend/tests/storage-paths.test.mjs`** runs with
  `/proc/self/fd` and with the path fallback.
  - Seven kinds of planted link (a link as the file, pointing outside,
    into another workspace, relative or dangling; a link as a parent
    folder, pointing outside or into another workspace; a link as the
    workspace folder), each refused for read, `exists`, create and
    delete. Nothing outside the root or in the other workspace changes.
  - A link where a missing folder would be made.
  - FIFOs, sockets and folders, refused without blocking. A missing path
    stays missing, and a regular file is still read.
  - Hard links.
  - A linked root.
  - Logged refusals.
  - Deterministic races: a folder replaced by a link after it was opened,
    before the read, create or delete.
  - A 3-second race against a process flipping a folder and a link.
  - The report command.
- **`packages/backend/tests/storage-socket-http.test.mjs`** checks both
  access modes. A socket, FIFO or directory at a blob path answers `403`.
  A missing path stays `410` on a Drive read and `404` where that miss is
  reported as not found. A regular file is still downloaded. An `ENXIO`
  that is not this open stays `500`.
- **`packages/backend/tests/integration/storage-symlink-refusal.test.mjs`**
  runs with `STORAGE_DIR` as a link.
  - End to end through the linked root: Drive upload, thumbnail, download,
    archive; media and avatar upload; media served over GET, HEAD, range
    and `304`, with no descriptor left open afterwards; backup export and
    restore; delete.
  - Every Drive read route, every media route and every write route refuses
    links at the file, the folder and the workspace folder.
  - Delete removes a link itself or keeps the refused delete queued.
  - A staging folder replaced by a link after first use still receives the
    export.
  - The startup log and warning.
- **`tests/backup-staging.test.mjs`** and **`tests/thumbnail-workers.test.mjs`**:
  - A link as the staging folder or its parent is refused before first use.
  - A staging folder swapped for a link after first use is never followed.
  - The worker refuses a linked file and a linked folder.
- **Updated tests.** Existing tests that mocked `fs.open`/`fs.mkdir` by
  absolute path, or counted `readStream` calls inside `openReadStream`, now
  match the folder-relative opens and the provider's actual read methods.
