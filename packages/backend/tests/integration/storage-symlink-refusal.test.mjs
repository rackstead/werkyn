import assert from "node:assert/strict";
import crypto from "node:crypto";
import fss from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { png } from "../fixtures/passive-media.mjs";

// R33 (docs/remediation/r33-storage-symlinks.md): STORAGE_DIR may itself be
// a link (storage moved to another disk); below it, every read, write and
// delete refuses a symbolic link. This suite runs with STORAGE_DIR a link, so
// every ordinary operation also proves the linked root works end to end.
if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "storage-symlink-refusal-jwt-secret",
  COOKIE_SECRET: "storage-symlink-refusal-cookie-secret",
});
const base = await mkdtemp(path.join(os.tmpdir(), "werkyn-storage-links-"));
const disk = path.join(base, "other-disk", "storage");
const linkedRoot = path.join(base, "storage");
const outside = path.join(base, "outside");
await mkdir(disk, { recursive: true });
await mkdir(outside);
await symlink(disk, linkedRoot);
process.env.STORAGE_DIR = linkedRoot;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { readBackupArchive } = await import("../../src/modules/backup/backup-archive.ts");

const SECRET = Buffer.from("R33 secret marker outside the workspace folder");
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
// Would pass the media byte sniff if a link to it were ever followed.
const secretGif = Buffer.concat([gif, SECRET]);
let app, member, foreigner, memberToken, foreignToken, workspace, foreign, space, foreignSpace;
let requests = 0;

function request(method, url, { token = memberToken, payload, headers = {} } = {}) {
  return app.inject({
    method,
    url,
    payload,
    headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    remoteAddress: `10.33.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
}

function multipart(fields, file) {
  const boundary = `r33-${crypto.randomUUID()}`;
  const parts = Object.entries(fields).map(([name, value]) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

function uploadDriveResponse(name, type, bytes, { token = memberToken, workspaceId = workspace.id } = {}) {
  return request("POST", `/api/workspaces/${workspaceId}/files/upload`, { token, ...multipart({}, { name, type, bytes }) });
}

async function uploadDrive(name, type, bytes, options) {
  const response = await uploadDriveResponse(name, type, bytes, options);
  assert.equal(response.statusCode, 201, response.body);
  return response.json().data;
}

function uploadMediaResponse(purpose, bytes, { name = "image.gif", spaceId = space.id } = {}) {
  const fields = { workspaceId: workspace.id, purpose, ...(purpose === "wiki" ? { spaceId } : {}) };
  return request("POST", "/api/uploads", multipart(fields, { name, type: "image/gif", bytes }));
}

async function uploadMedia(purpose, bytes, options) {
  const response = await uploadMediaResponse(purpose, bytes, options);
  assert.equal(response.statusCode, 201, response.body);
  return response.json().data.url;
}

const mediaUrl = (url, download = false) => `/api/uploads/media?${new URLSearchParams({ url, ...(download ? { download: "1" } : {}) })}`;
const onDisk = (relative) => path.join(disk, relative);
const leaks = (response, marker = SECRET) => response.rawPayload.includes(marker);

/** Every entry below `dir`, with link targets and file bytes, to show nothing changed. */
async function tree(dir) {
  const entries = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    entries[path.relative(dir, full)] = entry.isSymbolicLink()
      ? `link -> ${await readlink(full)}`
      : entry.isFile() ? (await readFile(full)).toString("base64") : "dir";
  }
  return entries;
}

/** Replace the folder `relative` with a link to `target`; returns the undo. */
async function swapForLink(relative, target) {
  const parked = `${onDisk(relative)}.parked-${crypto.randomUUID()}`;
  await rename(onDisk(relative), parked);
  await symlink(target, onDisk(relative));
  return async () => {
    await unlink(onDisk(relative));
    await rename(parked, onDisk(relative));
  };
}

/** Replace the file `relative` with a link to `target`; returns the undo. */
async function linkInPlaceOf(relative, target) {
  const bytes = await readFile(onDisk(relative));
  await rm(onDisk(relative));
  await symlink(target, onDisk(relative));
  return async () => {
    await unlink(onDisk(relative));
    await writeFile(onDisk(relative), bytes);
  };
}

/** A Drive archive download; a response ended early is reported as aborted. */
async function archiveOf(fileIds) {
  try {
    const response = await request("POST", `/api/workspaces/${workspace.id}/files/archive`, { payload: { fileIds } });
    return { aborted: false, rawPayload: response.rawPayload, response };
  } catch (error) {
    if (error.code !== "LIGHT_ECONNRESET") throw error;
    return { aborted: true, rawPayload: Buffer.alloc(0) };
  }
}

function assertRefused(response, label) {
  assert.equal(response.statusCode, 403, `${label}: ${response.statusCode} ${response.body.slice(0, 200)}`);
  assert.match(response.headers["content-type"], /^application\/json/, label);
  assert.equal(response.json().message, "Stored file is not accessible", label);
  assert.equal(leaks(response), false, `${label} leaked the outside bytes`);
}

/** Descriptors of this process that point at `file` (Linux). */
function descriptorsOf(file) {
  if (!fss.existsSync("/proc/self/fd")) return [];
  return fss.readdirSync("/proc/self/fd").filter((fd) => {
    try {
      return fss.readlinkSync(`/proc/self/fd/${fd}`) === file;
    } catch {
      return false;
    }
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 18);
  member = await app.prisma.user.create({ data: { email: `r33-member-${suffix}@example.test`, displayName: "R33 member", emailVerified: true } });
  foreigner = await app.prisma.user.create({ data: { email: `r33-foreign-${suffix}@example.test`, displayName: "R33 foreigner", emailVerified: true } });
  memberToken = signAccessToken({ sub: member.id, email: member.email });
  foreignToken = signAccessToken({ sub: foreigner.id, email: foreigner.email });
  workspace = await app.prisma.workspace.create({ data: { name: "R33", slug: `r33-${suffix}`, members: { create: { userId: member.id, role: "ADMIN" } } } });
  foreign = await app.prisma.workspace.create({ data: { name: "R33 foreign", slug: `r33-foreign-${suffix}`, members: { create: { userId: foreigner.id, role: "ADMIN" } } } });
  space = await app.prisma.wikiSpace.create({ data: { workspaceId: workspace.id, name: "Media", slug: "media" } });
  foreignSpace = await app.prisma.wikiSpace.create({ data: { workspaceId: foreign.id, name: "Media", slug: "media" } });
});

after(async () => {
  try {
    if (app) {
      const ids = [workspace?.id, foreign?.id].filter(Boolean);
      await app.prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await app.prisma.blobCleanup.deleteMany({ where: { OR: ids.map((id) => ({ storagePath: { startsWith: `${id}/` } })) } });
      await app.prisma.user.deleteMany({ where: { id: { in: [member?.id, foreigner?.id].filter(Boolean) } } });
    }
  } finally {
    await app?.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("a storage root that is itself a link works end to end", async () => {
  // Resolved once at startup to the real folder on the "other disk".
  assert.equal(app.storage.rootPath, await realpath(disk));

  // Drive: upload, thumbnail (decoded by a worker through the linked root), download, archive.
  const photo = await uploadDrive("photo.png", "image/png", png);
  assert.ok(photo.thumbnailPath, "a thumbnail was made");
  assert.deepEqual(await readFile(onDisk(photo.storagePath)), png);
  const download = await request("GET", `/api/workspaces/${workspace.id}/files/${photo.id}/download`);
  assert.equal(download.statusCode, 200, download.body);
  assert.deepEqual(download.rawPayload, png);
  const thumb = await request("GET", `/api/workspaces/${workspace.id}/files/${photo.id}/thumbnail`);
  assert.equal(thumb.statusCode, 200, thumb.body);
  assert.equal(thumb.headers["content-type"], "image/webp");
  const archive = await request("POST", `/api/workspaces/${workspace.id}/files/archive`, { payload: { fileIds: [photo.id] } });
  assert.equal(archive.statusCode, 200, archive.body);
  assert.ok(archive.rawPayload.includes(Buffer.from("photo.png")));

  // Wiki media and avatars: member route, legacy route, ranges, HEAD, validators.
  const media = await uploadMedia("wiki", gif);
  const member200 = await request("GET", mediaUrl(media));
  assert.equal(member200.statusCode, 200, member200.body);
  assert.equal(member200.headers["content-type"], "image/gif");
  assert.deepEqual(member200.rawPayload, gif);
  const legacy = await request("GET", media);
  assert.equal(legacy.statusCode, 200, legacy.body);
  assert.equal(legacy.headers["content-type"], "image/gif");
  assert.deepEqual(legacy.rawPayload, gif);
  const ranged = await request("GET", media, { headers: { range: "bytes=0-5" } });
  assert.equal(ranged.statusCode, 206);
  assert.deepEqual(ranged.rawPayload, gif.subarray(0, 6));
  const head = await request("HEAD", mediaUrl(media));
  assert.equal(head.statusCode, 200);
  assert.equal(Number(head.headers["content-length"]), gif.length);
  const unchanged = await request("GET", media, { headers: { "if-none-match": legacy.headers.etag } });
  assert.equal(unchanged.statusCode, 304);
  // Every response's descriptor of the checked file is closed again.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(descriptorsOf(await realpath(onDisk(media.replace(/^\/storage\//, "")))), []);
  const avatar = await uploadMedia("avatar", gif);
  const avatarResponse = await request("GET", mediaUrl(avatar));
  assert.equal(avatarResponse.statusCode, 200, avatarResponse.body);

  // Backup: export with the page's image, then restore it (writes below wiki/imports).
  await app.prisma.wikiPage.create({
    data: { spaceId: space.id, title: "With media", content: [{ id: "m", type: "image", props: { url: media }, children: [] }], createdById: member.id },
  });
  const exported = await request("POST", `/api/workspaces/${workspace.id}/backup/export`, {
    payload: { projects: [], channels: [], wikiSpaces: [{ spaceId: space.id }], includeFiles: true },
  });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal((await readBackupArchive(exported.rawPayload)).assets.size, 1);
  const restored = await request("POST", `/api/workspaces/${workspace.id}/backup/restore`, {
    ...multipart({}, { name: "backup.zip", type: "application/zip", bytes: exported.rawPayload }),
  });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().data.images, 1);
  const imported = await readdir(onDisk(`${workspace.id}/uploads/wiki/imports`));
  assert.equal(imported.length, 1);
  assert.deepEqual(await readFile(onDisk(`${workspace.id}/uploads/wiki/imports/${imported[0]}`)), gif);

  // Delete: the blob and its thumbnail are removed from the real folder.
  const deleted = await request("DELETE", `/api/workspaces/${workspace.id}/files/${photo.id}`);
  assert.equal(deleted.statusCode, 204, deleted.body);
  await assert.rejects(lstat(onDisk(photo.storagePath)), { code: "ENOENT" });
  await assert.rejects(lstat(onDisk(photo.thumbnailPath)), { code: "ENOENT" });
});

test("Drive reads refuse a link at the blob, in a folder above it, or into another workspace", async () => {
  await writeFile(path.join(outside, "secret.txt"), SECRET);
  const file = await uploadDrive("report.txt", "text/plain", Buffer.from("own drive bytes"));
  const theirs = await uploadDrive("theirs.txt", "text/plain", Buffer.from("foreign drive bytes"), { token: foreignToken, workspaceId: foreign.id });
  const link = await request("POST", `/api/workspaces/${workspace.id}/files/share-links`, { payload: { fileIds: [file.id] } });
  assert.equal(link.statusCode, 201, link.body);
  const routes = {
    download: `/api/workspaces/${workspace.id}/files/${file.id}/download`,
    inline: `/api/workspaces/${workspace.id}/files/${file.id}/download?inline=true`,
    "public share": `/api/public/files/${link.json().data.token}/${file.id}/download`,
  };
  const readAll = async (label, marker = SECRET) => {
    for (const [route, url] of Object.entries(routes)) {
      const response = await request("GET", url, { token: route === "public share" ? null : memberToken });
      assertRefused(response, `${label}: ${route}`);
      assert.equal(leaks(response, marker), false, `${label}: ${route}`);
    }
    // A link is refused before any zip byte, the same 403 as the other reads.
    const archive = await archiveOf([file.id]);
    assert.equal(archive.aborted, false, `${label}: archive`);
    assertRefused(archive.response, `${label}: archive`);
    assert.equal(leaks(archive, marker), false, `${label}: archive`);
  };

  let undo = await linkInPlaceOf(file.storagePath, path.join(outside, "secret.txt"));
  await readAll("blob links outside");
  await undo();
  undo = await linkInPlaceOf(file.storagePath, onDisk(theirs.storagePath));
  await readAll("blob links to another workspace", Buffer.from("foreign drive bytes"));
  await undo();
  // The member's whole Drive folder is a link to an outside folder holding a
  // file of the same name.
  const folder = path.dirname(file.storagePath);
  await writeFile(path.join(outside, path.basename(file.storagePath)), SECRET);
  undo = await swapForLink(folder, outside);
  await readAll("Drive folder links outside");
  await undo();
  // The workspace folder itself.
  const elsewhere = path.join(outside, "workspace-copy");
  await mkdir(path.join(elsewhere, folder.split("/").slice(1).join("/")), { recursive: true });
  await writeFile(path.join(elsewhere, file.storagePath.split("/").slice(1).join("/")), SECRET);
  undo = await swapForLink(workspace.id, elsewhere);
  await readAll("workspace folder links outside");
  await undo();

  // Thumbnails are read through the same checks.
  const photo = await uploadDrive("photo.png", "image/png", png);
  undo = await linkInPlaceOf(photo.thumbnailPath, path.join(outside, "secret.txt"));
  assertRefused(await request("GET", `/api/workspaces/${workspace.id}/files/${photo.id}/thumbnail`), "thumbnail");
  await undo();

  // A missing blob is a 410 with no zip body, the same error as a single-file
  // download, instead of a 200 that resets after a local header.
  const missing = await uploadDrive("missing.txt", "text/plain", Buffer.from("soon gone"));
  await rm(onDisk(missing.storagePath));
  const missingArchive = await archiveOf([missing.id]);
  assert.equal(missingArchive.aborted, false);
  assert.equal(missingArchive.response.statusCode, 410);
  assert.match(missingArchive.response.headers["content-type"], /^application\/json/);
  assert.equal(missingArchive.response.json().message, "File content is no longer available");
  assert.equal(missingArchive.rawPayload.subarray(0, 4).equals(Buffer.from("PK\x03\x04")), false);
  assert.equal((await request("GET", "/api/live")).statusCode, 200, "the server is still serving");

  // With every link removed, the same routes serve the member's bytes again.
  const restored = await request("GET", routes.download);
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.body, "own drive bytes");
});

test("uploaded media refuse links on the member, shared, legacy, HEAD and range reads", async () => {
  await writeFile(path.join(outside, "secret.gif"), secretGif);
  const url = await uploadMedia("wiki", gif);
  const relative = url.replace(/^\/storage\//, "");
  const page = await app.prisma.wikiPage.create({
    data: { spaceId: space.id, title: "Shared", content: [{ id: "m", type: "image", props: { url }, children: [] }], createdById: member.id },
  });
  const share = await app.prisma.wikiPageShare.create({ data: { token: crypto.randomUUID(), pageId: page.id, createdById: member.id } });
  const readAll = async (label, marker = SECRET) => {
    for (const [route, response] of [
      ["member", await request("GET", mediaUrl(url))],
      ["member download", await request("GET", mediaUrl(url, true))],
      ["member HEAD", await request("HEAD", mediaUrl(url))],
      ["shared", await request("GET", `/api/public/wiki/${share.token}/media?${new URLSearchParams({ url })}`, { token: null })],
      ["legacy", await request("GET", url)],
      ["legacy HEAD", await request("HEAD", url)],
      ["legacy range", await request("GET", url, { headers: { range: "bytes=0-5" } })],
    ]) {
      assert.equal(response.statusCode, 403, `${label}: ${route}`);
      assert.equal(leaks(response, marker), false, `${label}: ${route}`);
      if (!route.endsWith("HEAD")) assert.equal(response.json().message, "Stored file is not accessible");
    }
  };

  let undo = await linkInPlaceOf(relative, path.join(outside, "secret.gif"));
  await readAll("media file links outside");
  await undo();
  // The wiki space's media folder is a link into the other workspace's
  // media folder, which holds a file of the same name.
  const foreignFolder = onDisk(`${foreign.id}/uploads/wiki/${foreignSpace.id}`);
  await mkdir(foreignFolder, { recursive: true });
  await writeFile(path.join(foreignFolder, path.basename(relative)), Buffer.concat([gif, Buffer.from("foreign media")]));
  undo = await swapForLink(path.dirname(relative), foreignFolder);
  await readAll("media folder links to another workspace", Buffer.from("foreign media"));
  await undo();
  // The legacy public routes stay retired.
  for (const retired of ["/storage/avatars/x.gif", "/storage/uploads/x.gif", "/uploads/x.gif"]) {
    assert.equal((await request("GET", retired, { token: null })).statusCode, 410, retired);
  }
  assert.equal((await request("GET", mediaUrl(url))).statusCode, 200, "served again once the link is gone");
});

test("writes refuse a link below the root and create nothing through it", async () => {
  // Folders the writes below need, made by ordinary writes.
  await uploadDrive("seed.txt", "text/plain", Buffer.from("seed"));
  const seedMedia = await uploadMedia("wiki", gif);
  await uploadMedia("avatar", gif);
  const exported = await request("POST", `/api/workspaces/${workspace.id}/backup/export`, {
    payload: { projects: [], channels: [], wikiSpaces: [{ spaceId: space.id }], includeFiles: true },
  });
  assert.equal(exported.statusCode, 200, exported.body);
  const before = await tree(outside);
  const driveFolder = `${workspace.id}/files/${member.id}`;
  const attempts = {
    "Drive upload": async () => uploadDriveResponse("blocked.txt", "text/plain", Buffer.from("blocked")),
    "wiki media upload": async () => uploadMediaResponse("wiki", gif),
    "avatar upload": async () => uploadMediaResponse("avatar", gif),
    restore: async () => request("POST", `/api/workspaces/${workspace.id}/backup/restore`, {
      ...multipart({}, { name: "backup.zip", type: "application/zip", bytes: exported.rawPayload }),
    }),
  };
  const exportBackup = () => request("POST", `/api/workspaces/${workspace.id}/backup/export`, {
    payload: { projects: [], channels: [], wikiSpaces: [{ spaceId: space.id }], includeFiles: true },
  });
  const linked = {
    "Drive upload": driveFolder,
    "wiki media upload": path.dirname(seedMedia.replace(/^\/storage\//, "")),
    "avatar upload": `${workspace.id}/uploads/avatars`,
    restore: `${workspace.id}/uploads/wiki/imports`,
  };
  for (const [label, attempt] of Object.entries(attempts)) {
    await mkdir(onDisk(linked[label]), { recursive: true });
    const undo = await swapForLink(linked[label], outside);
    try {
      const response = await attempt();
      assert.equal(response.statusCode, 403, `${label}: ${response.statusCode} ${response.body.slice(0, 200)}`);
      assert.deepEqual(await tree(outside), before, `${label} wrote through the link`);
    } finally {
      await undo();
    }
  }
  // Backup staging was checked and opened when first used, and staged files
  // are named through that open folder. Replacing the staging folder (or its
  // parent) with a link afterwards does not redirect them: the export
  // completes inside the folder that was checked. (A link present before
  // first use is refused: tests/backup-staging.test.mjs.)
  for (const folder of [".tmp", ".tmp/backup"]) {
    const undo = await swapForLink(folder, outside);
    try {
      const response = await exportBackup();
      assert.equal(response.statusCode, 200, `${folder}: ${response.body.slice(0, 200)}`);
      assert.equal((await readBackupArchive(response.rawPayload)).assets.size > 0, true);
      assert.deepEqual(await tree(outside), before, `staging through a linked ${folder} followed the link`);
    } finally {
      await undo();
    }
  }
  assert.equal((await attempts["Drive upload"]()).statusCode, 201, "writes succeed once the links are gone");
});

test("deletes remove a link at a blob's path, never its target, and refuse a link above it", async () => {
  await writeFile(path.join(outside, "victim.txt"), SECRET);
  const linkedBlob = await uploadDrive("linked.txt", "text/plain", Buffer.from("own"));
  await linkInPlaceOf(linkedBlob.storagePath, path.join(outside, "victim.txt"));
  const deleted = await request("DELETE", `/api/workspaces/${workspace.id}/files/${linkedBlob.id}`);
  assert.equal(deleted.statusCode, 204, deleted.body);
  await assert.rejects(lstat(onDisk(linkedBlob.storagePath)), { code: "ENOENT" }, "the link itself was removed");
  assert.deepEqual(await readFile(path.join(outside, "victim.txt")), SECRET, "its target was not touched");
  assert.equal(await app.prisma.blobCleanup.count({ where: { storagePath: linkedBlob.storagePath } }), 0);

  // The blob's folder is a link to an outside folder holding a file of the
  // same name: the delete is refused and stays queued with the reason.
  const queued = await uploadDrive("queued.txt", "text/plain", Buffer.from("own"));
  await writeFile(path.join(outside, path.basename(queued.storagePath)), SECRET);
  const undo = await swapForLink(path.dirname(queued.storagePath), outside);
  try {
    const response = await request("DELETE", `/api/workspaces/${workspace.id}/files/${queued.id}`);
    assert.equal(response.statusCode, 204, "the record is deleted; its blob waits in the cleanup queue");
    assert.deepEqual(await readFile(path.join(outside, path.basename(queued.storagePath))), SECRET);
    const row = await app.prisma.blobCleanup.findUnique({ where: { storagePath: queued.storagePath } });
    assert.ok(row, "the refused delete stays queued");
    assert.equal(row.lastError, "Stored file is not accessible");
  } finally {
    await undo();
  }
  // Once the link is gone, the queued delete completes.
  await app.prisma.blobCleanup.update({ where: { storagePath: queued.storagePath }, data: { availableAt: new Date(0) } });
  const { processBlobCleanup } = await import("../../src/services/blob-cleanup.ts");
  const result = await processBlobCleanup(app.prisma, app.storage, { paths: [queued.storagePath] });
  assert.equal(result.deleted, 1);
  await assert.rejects(lstat(onDisk(queued.storagePath)), { code: "ENOENT" });
});

test("startup resolves the root once, logs it, and names links at its top level", async () => {
  const lines = [];
  const Fastify = (await import("fastify")).default;
  const storagePlugin = (await import("../../src/plugins/storage.ts")).default;
  await symlink(outside, onDisk("moved-workspace"));
  const probe = Fastify({ logger: { level: "info", stream: { write: (line) => lines.push(JSON.parse(line)) } } });
  try {
    await probe.register(storagePlugin);
    await probe.ready();
  } finally {
    await probe.close();
    await unlink(onDisk("moved-workspace"));
  }
  const resolved = lines.find((line) => line.msg?.startsWith("Storage root resolved"));
  assert.deepEqual([resolved.storageDir, resolved.storageRoot], [linkedRoot, await realpath(disk)]);
  // On Linux, accesses resolve names inside open directories (/proc/self/fd).
  if (fss.existsSync("/proc/self/fd")) assert.equal(resolved.access, "descriptor");
  const warned = lines.find((line) => line.level === 40);
  assert.deepEqual(warned.links, ["moved-workspace"]);
  assert.match(warned.msg, /storage-link-report/);
});
