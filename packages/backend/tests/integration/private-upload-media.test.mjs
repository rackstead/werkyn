import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) throw Error("Disposable migrated TEST_DATABASE_URL required");
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test", JWT_SECRET: "private-media-test-jwt", COOKIE_SECRET: "private-media-test-cookie", LOG_LEVEL: "error" });
const storage = await mkdtemp(path.join(os.tmpdir(), "werkyn-private-media-"));
process.env.STORAGE_DIR = storage;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { createShareGrant, shareGrantCookieName } = await import("../../src/utils/share-grants.ts");
const { parseUploadedMedia, referencesUploadedMedia } = await import("../../src/modules/uploads/uploaded-media.ts");
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const html = Buffer.from("<!doctype html><title>Owned file</title><p>Owned file</p>");
let app, owner, outsider, workspace, foreign, space, page, share, protectedShare, ownerToken, outsiderToken;
let image, spoof, mismatch, unsafe;
const name = crypto.randomUUID();
let dispatches = 0, requestId = 0;
function document(url) { return [{ id: "media", type: "image", props: { url }, children: [] }]; }
function memberUrl(url, download = false) { return "/api/uploads/media?" + new URLSearchParams({ url, ...(download ? { download: "1" } : {}) }); }
function shareUrl(record, url = image) { return `/api/public/wiki/${record.token}/media?` + new URLSearchParams({ url }); }
function grant(record, kind = "wiki", now) { return shareGrantCookieName(kind, record.token) + "=" + createShareGrant(kind, record, now); }
function request(url, { actor, cookie, method = "GET", headers = {} } = {}) {
  return app.inject({ method, url, headers: { ...headers, ...(actor ? { authorization: "Bearer " + actor } : {}), ...(cookie ? { cookie } : {}) }, remoteAddress: `10.91.0.${++requestId}` });
}
before(async () => {
  app = await buildApp();
  app.addHook("onRequest", async (_request, reply) => { const original = reply.sendFile; reply.sendFile = function (...args) { dispatches++; return original.apply(this, args); }; });
  await app.ready();
  owner = await app.prisma.user.create({ data: { email: `private-media-${name}@example.test`, displayName: "Media owner" } });
  outsider = await app.prisma.user.create({ data: { email: `private-media-other-${name}@example.test`, displayName: "Other media owner" } });
  workspace = await app.prisma.workspace.create({ data: { name: "Media", slug: "media-" + name, members: { create: { userId: owner.id, role: "ADMIN" } } } });
  foreign = await app.prisma.workspace.create({ data: { name: "Other", slug: "other-" + name, members: { create: { userId: outsider.id, role: "ADMIN" } } } });
  space = await app.prisma.wikiSpace.create({ data: { workspaceId: workspace.id, name: "Media", slug: "media" } });
  const root = path.join(storage, workspace.id, "uploads", "wiki", space.id);
  await mkdir(root, { recursive: true });
  async function file(extension, bytes) { const filename = crypto.randomUUID() + extension; await writeFile(path.join(root, filename), bytes); return `/storage/${workspace.id}/uploads/wiki/${space.id}/${filename}`; }
  image = await file(".gif", gif); spoof = await file(".png", html); mismatch = await file(".html", gif); unsafe = await file(".html", html);
  page = await app.prisma.wikiPage.create({ data: { spaceId: space.id, title: "Media", content: document(image), createdById: owner.id } });
  share = await app.prisma.wikiPageShare.create({ data: { token: crypto.randomUUID(), pageId: page.id, createdById: owner.id } });
  const second = await app.prisma.wikiPage.create({ data: { spaceId: space.id, title: "Protected media", content: document(image), createdById: owner.id } });
  protectedShare = await app.prisma.wikiPageShare.create({ data: { token: crypto.randomUUID(), pageId: second.id, createdById: owner.id, passwordHash: "owned-current-password-hash" } });
  ownerToken = signAccessToken({ sub: owner.id, email: owner.email }); outsiderToken = signAccessToken({ sub: outsider.id, email: outsider.email });
});
after(async () => {
  if (app) { await app.prisma.workspace.deleteMany({ where: { id: { in: [workspace?.id, foreign?.id].filter(Boolean) } } }); await app.prisma.user.deleteMany({ where: { id: { in: [owner?.id, outsider?.id].filter(Boolean) } } }); await app.close(); }
  await rm(storage, { recursive: true, force: true });
});

test("canonical media parser refuses alternate paths and encoded aliases", () => {
  assert(parseUploadedMedia(image));
  for (const url of ["https://example.test" + image, image + "?x=1", image + "#x", image.replace("/wiki/", "/wiki/../"), image.replace("/uploads/", "/uploads%2f"), image.replace("/wiki/", "/wiki\\"), "/storage/avatars/a.gif"]) assert.equal(parseUploadedMedia(url), null);
});
test("only structural media refs and nested children authorize a share", () => {
  assert(referencesUploadedMedia([{ type: "paragraph", children: document(image) }], image));
  assert(!referencesUploadedMedia([{ type: "paragraph", content: image, props: { url: image } }], image));
  assert(!referencesUploadedMedia([{ type: "image", props: { caption: image } }], image));
});
for (const prefix of ["/storage/avatars/", "/storage/uploads/", "/uploads/"]) test("retired public namespace " + prefix + " returns410", async () => { const r = await request(prefix + "owned.gif"); assert.equal(r.statusCode, 410); assert.match(r.headers["cache-control"], /no-store/); });
test("member receives exact sniffed bytes, private policies and HEAD metadata", async () => {
  const r = await request(memberUrl(image), { actor: ownerToken }); assert.equal(r.statusCode, 200); assert.deepEqual(r.rawPayload, gif); assert.match(r.headers["content-type"], /^image\/gif/); assert.match(r.headers["cache-control"], /no-store/); assert.equal(r.headers["x-content-type-options"], "nosniff"); assert.match(r.headers["content-security-policy"], /sandbox/);
  const head = await request(memberUrl(image), { actor: ownerToken, method: "HEAD" }); assert.equal(head.statusCode, 200); assert.equal(head.rawPayload.length, 0); assert.equal(Number(head.headers["content-length"]), gif.length);
});
test("member media supports existing byte ranges", async () => { const r = await request(memberUrl(image), { actor: ownerToken, headers: { range: "bytes=0-5" } }); assert.equal(r.statusCode, 206); assert.deepEqual(r.rawPayload, gif.subarray(0, 6)); });
test("anonymous and current nonmember are denied before file dispatch", async () => { const n = dispatches; assert.equal((await request(memberUrl(image))).statusCode, 401); assert.equal((await request(memberUrl(image), { actor: outsiderToken })).statusCode, 403); assert.equal(dispatches, n); });
test("nonmembership does not disclose whether an upload exists", async () => { const missing = image.replace(/[^/]+$/, crypto.randomUUID() + ".gif"); assert.equal((await request(memberUrl(missing), { actor: outsiderToken })).statusCode, 403); });
test("membership removal takes effect on the next media request", async () => { await app.prisma.workspaceMember.delete({ where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } } }); try { assert.equal((await request(memberUrl(image), { actor: ownerToken })).statusCode, 403); } finally { await app.prisma.workspaceMember.create({ data: { userId: owner.id, workspaceId: workspace.id, role: "ADMIN" } }); } });
test("HTML and MIME-spoofed images are octet-stream attachment only", async () => { for (const url of [unsafe, spoof, mismatch]) { const r = await request(memberUrl(url), { actor: ownerToken }); assert.equal(r.statusCode, 200); assert.match(r.headers["content-type"], /^application\/octet-stream/); assert.match(r.headers["content-disposition"], /^attachment/); } });
test("explicit download forces safe images to octet-stream attachment", async () => { const r = await request(memberUrl(image, true), { actor: ownerToken }); assert.equal(r.statusCode, 200); assert.deepEqual(r.rawPayload, gif); assert.match(r.headers["content-type"], /^application\/octet-stream/); assert.match(r.headers["content-disposition"], /^attachment/); });
test("unpassworded current share serves its exact referenced image", async () => { const r = await request(shareUrl(share)); assert.equal(r.statusCode, 200); assert.deepEqual(r.rawPayload, gif); });
test("current password grant is required and files-kind grant is refused", async () => { const n = dispatches; assert.equal((await request(shareUrl(protectedShare))).statusCode, 404); assert.equal((await request(shareUrl(protectedShare), { cookie: grant(protectedShare, "files") })).statusCode, 404); assert.equal(dispatches, n); assert.equal((await request(shareUrl(protectedShare), { cookie: grant(protectedShare) })).statusCode, 200); });
test("expired password grant is refused", async () => { assert.equal((await request(shareUrl(protectedShare), { cookie: grant(protectedShare, "wiki", Date.now() - 31 * 60 * 1000) })).statusCode, 404); });
test("password revision change invalidates an existing grant", async () => { const cookie = grant(protectedShare); const old = protectedShare.passwordHash; protectedShare = await app.prisma.wikiPageShare.update({ where: { id: protectedShare.id }, data: { passwordHash: "owned-replacement-password-hash", updatedAt: new Date(protectedShare.updatedAt.getTime() + 1) } }); assert.equal((await request(shareUrl(protectedShare), { cookie })).statusCode, 404); assert.notEqual(protectedShare.passwordHash, old); });
test("disabled share immediately refuses media", async () => { await app.prisma.wikiPageShare.update({ where: { id: share.id }, data: { enabled: false } }); try { assert.equal((await request(shareUrl(share))).statusCode, 404); } finally { await app.prisma.wikiPageShare.update({ where: { id: share.id }, data: { enabled: true } }); } });
test("removed and sibling-only refs do not authorize media", async () => { const n = dispatches; assert.equal((await request(shareUrl(share, unsafe))).statusCode, 404); await app.prisma.wikiPage.update({ where: { id: page.id }, data: { content: [{ type: "paragraph", content: image }] } }); try { assert.equal((await request(shareUrl(share))).statusCode, 404); assert.equal(dispatches, n); } finally { await app.prisma.wikiPage.update({ where: { id: page.id }, data: { content: document(image) } }); } });
test("other-workspace URL cannot be exposed by a structural share ref", async () => { const url = image.replace(workspace.id, foreign.id); await app.prisma.wikiPage.update({ where: { id: page.id }, data: { content: document(url) } }); try { assert.equal((await request(shareUrl(share, url))).statusCode, 404); } finally { await app.prisma.wikiPage.update({ where: { id: page.id }, data: { content: document(image) } }); } });
test("nested actual structural refs remain eligible without rewriting content", async () => { const content = [{ type: "paragraph", children: document(image) }]; await app.prisma.wikiPage.update({ where: { id: page.id }, data: { content } }); const r = await request(shareUrl(share)); assert.equal(r.statusCode, 200); assert.deepEqual((await app.prisma.wikiPage.findUnique({ where: { id: page.id } })).content, content); });
