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
  be a regular file. A link is refused, and so are a FIFO, socket, device or
  folder. Opening a FIFO never waits for a writer.
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
same checks run on full paths. That narrows the window between check and use
but cannot close it. The startup log then reports `"access":"path"` and logs a
warning.

The race was measured with a second process flipping a Drive folder between
the real folder and a link to an outside folder, for 3 seconds of reads
(`evidence/round14-r33-race-modes.log`):

| Mode | own file read | refused | missing (mid-flip) | outside file read |
| --- | --- | --- | --- | --- |
| `/proc/self/fd` (Linux) | 3,135 | 65 | 3,060 | **0** |
| path fallback | 2,173 | 67 | 4,322 | 135 |

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
  - A backup whose staging folder is a link answers `403`. The startup sweep
    logs the refusal and stages nothing.

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
| Backup staging (`<root>/.tmp/backup`) | staged files opened with `O_NOFOLLOW` | folders opened through `StorageRoot.openDirectory`; files created with `O_EXCL \| O_NOFOLLOW` | sweep removes names inside the opened folder |
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
without the trailing slash now answers `403` instead of a `301` redirect.

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
change. To catch the likely case, startup checks the top level of the root
and warns about each link there. To list every link and special file below
the root, run the read-only report:

```bash
# Docker Compose
docker compose exec werkyn node packages/backend/dist/scripts/storage-link-report.js
# From a checkout
STORAGE_DIR=/path/to/storage node packages/backend/dist/scripts/storage-link-report.js [--json] [--limit=N] [--dir=PATH]
```

The report never follows a link. It only lists folders, examines entries and
reads link targets. It prints each entry's path below the root, its kind and,
for links, the target. Its exit status is `0` when nothing was found, `2`
when something was found or a folder could not be listed, and `1` on error.

To fix each finding, do one of the following:

- Replace the link with the folder or file it points to. Stop the server,
  move the target into place, then start the server again.
- Mount the other disk at that path (a bind mount or a Compose volume)
  instead of linking to it.
- Make `STORAGE_DIR` itself point at the other disk.

Remove FIFOs, sockets and device files. The application never creates them.

## Remaining limitations

- **Path fallback.** Without `/proc` (macOS development) the checks run on
  paths, and a link swapped in during an access can still be followed (see
  the table above). Production images run on Linux with `/proc`.
- **Backup staging.**
  - The staging folders are checked without following links on every use,
    and staged files are created exclusively and opened without following
    links.
  - After that, a staged file is addressed by its path. Someone with write
    access to the storage volume who swaps `.tmp/backup` for a link between
    the check and the open could redirect a staged file, whose name is a
    random UUID.
- **Trusted root.** The root and everything above it are trusted, as the
  owner decided.
- **Cost.** Each access opens one descriptor per folder level below the
  root, about five more `open`/`close` calls for a Drive blob. The report
  walks the whole tree.
- **Folder URLs.** `/storage/:ws/uploads/<folder>` without a trailing slash
  answers `403` instead of a `301` redirect.

## Tests

- **`packages/backend/tests/storage-paths.test.mjs`** runs with
  `/proc/self/fd` and with the path fallback.
  - Seven kinds of planted link (a link as the file, pointing outside,
    into another workspace, relative or dangling; a link as a parent
    folder, pointing outside or into another workspace; a link as the
    workspace folder), each refused for read, `exists`, create and
    delete. Nothing outside the root or in the other workspace changes.
  - A link where a missing folder would be made.
  - FIFOs and folders, refused without blocking.
  - Hard links.
  - A linked root.
  - Logged refusals.
  - Deterministic races: a folder replaced by a link after it was opened,
    before the read, create or delete.
  - A 3-second race against a process flipping a folder and a link.
  - The report command.
- **`packages/backend/tests/integration/storage-symlink-refusal.test.mjs`**
  runs with `STORAGE_DIR` as a link.
  - End to end through the linked root: Drive upload, thumbnail, download,
    archive; media and avatar upload; media served over GET, HEAD, range
    and `304`, with no descriptor left open afterwards; backup export and
    restore; delete.
  - Every Drive read route, every media route and every write route refuses
    links at the file, the folder and the workspace folder.
  - Delete removes a link itself or keeps the refused delete queued.
  - The startup log and warning.
- **Updated tests.** Existing tests that mocked `fs.open`/`fs.mkdir` by
  absolute path, or counted `readStream` calls inside `openReadStream`, now
  match the folder-relative opens and the provider's actual read methods.
