import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database",
  );
// Up to three requests wait on PostgreSQL row locks at once, each holding one
// pooled connection inside its transaction. The lock holder and the
// pg_stat_activity observer use their own pool so waiting requests can never
// starve the control that releases them.
const actorUrl = new URL(process.env.TEST_DATABASE_URL);
if (!actorUrl.searchParams.has("connection_limit"))
  actorUrl.searchParams.set("connection_limit", "5");
assert(
  Number(actorUrl.searchParams.get("connection_limit")) >= 5,
  "Editor revision races require connection_limit>=5",
);
const controlUrl = new URL(actorUrl);
controlUrl.searchParams.set("connection_limit", "2");
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-revisions-"));
Object.assign(process.env, {
  DATABASE_URL: actorUrl.toString(),
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "editor-revisions-jwt-secret",
  COOKIE_SECRET: "editor-revisions-cookie-secret",
  STORAGE_DIR: storageDir,
});

const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");

const suffix = crypto.randomBytes(5).toString("hex");
const users = {};
const tokens = {};
let app, control, workspace, space;
const events = [];
let requests = 0;
let counter = 0;

before(async () => {
  control = new PrismaClient({
    datasources: { db: { url: controlUrl.toString() } },
  });
  await control.$connect();
  app = await buildApp();
  await app.ready();
  // Observe the serialized broadcast envelope, matching the HTTP JSON representation.
  app.broadcastToWorkspace = (...args) => events.push(JSON.parse(JSON.stringify(args)));
  app.broadcastToUser = () => {};
  app.broadcast = () => {};
  for (const name of ["ALICE", "BOB", "VIEWER"]) {
    users[name] = await app.prisma.user.create({
      data: {
        email: `revisions-${name}-${suffix}@example.test`,
        displayName: name,
        emailVerified: true,
      },
    });
    tokens[name] = signAccessToken({
      sub: users[name].id,
      email: users[name].email,
    });
  }
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Editor revisions",
      slug: `revisions-${suffix}`,
      members: {
        create: [
          { userId: users.ALICE.id, role: "MEMBER" },
          { userId: users.BOB.id, role: "MEMBER" },
          { userId: users.VIEWER.id, role: "VIEWER" },
        ],
      },
    },
  });
  space = await app.prisma.wikiSpace.create({
    data: {
      workspaceId: workspace.id,
      name: "Docs",
      slug: `docs-${suffix}`,
    },
  });

});

after(async () => {
  try {
    if (app && workspace) {
      await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
      await app.prisma.user.deleteMany({
        where: { id: { in: Object.values(users).map((u) => u.id) } },
      });
    }
  } finally {
    const closed = await Promise.allSettled([
      app?.close(),
      control?.$disconnect(),
    ]);
    await rm(storageDir, { recursive: true, force: true });
    for (const result of closed)
      if (result.status === "rejected") throw result.reason;
  }
});

function req(actor, method, url, payload) {
  return app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.92.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
}

function status(response, expected) {
  assert.equal(response.statusCode, expected, response.body);
  return response.body ? response.json() : undefined;
}

/** Asserts a 409 that wrote nothing and reports the stored revision. */
function conflict(response, code, revision) {
  const body = status(response, 409);
  assert.equal(body.code, code, response.body);
  assert.equal(body.current.revision, revision, response.body);
  assert.equal(typeof body.current.updatedAt, "string");
  return body;
}

// ─── Real PostgreSQL lock barriers ─────────────────────────

let holderPid = null;

async function waitForLockWaiters(expected) {
  const deadline = performance.now() + 5000;
  let observed = 0;
  while (performance.now() < deadline) {
    const [row] = await control.$queryRaw`
      SELECT count(*)::int AS total FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend'
        AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
        AND pid <> ${holderPid}::int
    `;
    observed = row.total;
    if (observed >= expected) return;
    await sleep(10);
  }
  assert.fail(`Expected ${expected} PostgreSQL lock waiters, saw ${observed}`);
}

/**
 * Holds `table` row `id` FOR UPDATE in a control transaction while the
 * requests start, so every request has passed authentication and its reads
 * and is waiting in PostgreSQL before any of them can write. `starts` run in
 * order, each after the previous one is observed waiting: PostgreSQL grants a
 * row lock to its waiters in arrival order, which models one request being
 * delivered before another. `during` runs while they all wait.
 */
async function race(table, id, starts, during) {
  let unlock, locked;
  const unlocked = new Promise((resolve) => (unlock = resolve));
  const ready = new Promise((resolve) => (locked = resolve));
  const holder = control.$transaction(
    async (tx) => {
      [{ pid: holderPid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRawUnsafe(
        `SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`,
        id,
      );
      locked();
      await unlocked;
    },
    { timeout: 15_000, maxWait: 2_000 },
  );
  const running = [];
  try {
    await Promise.race([
      ready,
      holder.then(() => {
        throw new Error("Control transaction ended before its lock was ready");
      }),
    ]);
    for (const start of starts) {
      running.push(Promise.resolve(start()));
      await waitForLockWaiters(running.length);
    }
    await during?.();
  } finally {
    unlock();
    await Promise.allSettled([holder, ...running]);
    holderPid = null;
  }
  await holder;
  return Promise.all(running);
}

// ─── Fixtures ──────────────────────────────────────────────

function doc(text) {
  return [{ type: "paragraph", content: text }];
}

async function newPage(text = "original") {
  counter++;
  return app.prisma.wikiPage.create({
    data: {
      spaceId: space.id,
      title: `Page ${counter}`,
      content: doc(text),
      position: counter,
      createdById: users.ALICE.id,
    },
  });
}

async function stored(pageId) {
  return app.prisma.wikiPage.findUniqueOrThrow({ where: { id: pageId } });
}

function save(actor, pageId, body) {
  return req(actor, "PATCH", `/api/wiki/pages/${pageId}`, body);
}

function acquire(actor, pageId) {
  return req(actor, "POST", `/api/wiki/pages/${pageId}/lock`);
}

// Historical restore preconditions, including real row-lock serialization.
// app.inject runs the actual HTTP parser/validation/auth/controller against real PostgreSQL;
// this is not TCP/proxy/browser evidence. Only ordinary tiny text documents are created.
async function fixture() {
  const page = await newPage("selected old text");
  const version = status(await req("ALICE", "POST", `/api/wiki/pages/${page.id}/versions`, {name:"Chosen"}),201).data;
  status(await save("ALICE",page.id,{title:"New current title",content:doc("current text"),expectedRevision:0}),200);
  return {page,version,base:1};
}
async function state(id) {
  return {page:await stored(id), versions:await app.prisma.wikiPageVersion.findMany({where:{pageId:id},orderBy:{versionNumber:"asc"}}),events:events.filter(event=>event[1]==="wiki_page_updated" && event[2]?.page?.id===id)};
}
function restore(version,base,actor="ALICE") {
  return req(actor,"POST",`/api/wiki/versions/${version.id}/restore`,{expectedRevision:base});
}
for (const [label,payload] of [
 ["absent body",undefined],["missing member",{}],["null body",null],
 ["null revision",{expectedRevision:null}],["fraction",{expectedRevision:1.5}],
 ["negative",{expectedRevision:-1}],["string",{expectedRevision:"1"}],
 ["overflow",{expectedRevision:2147483648}],
]) test(`historical restore: rejects ${label} without effects`,async()=>{
 const {page,version}=await fixture(); const before=await state(page.id);
 status(await req("ALICE","POST",`/api/wiki/versions/${version.id}/restore`,payload),400);
 assert.deepEqual(await state(page.id),before);
});
test("historical restore: matching restore keeps replaced title/content and broadcasts exactly committed revision",async()=>{
 const {page,version,base}=await fixture(); const before=await state(page.id);
 const body=status(await restore(version,base),200).data;
 assert.equal(body.revision,base+1); assert.equal(body.title,page.title); assert.deepEqual(body.content,doc("selected old text"));
 const after=await state(page.id); assert.equal(after.versions.length,before.versions.length+1);
 const replaced=after.versions.at(-1); assert.equal(replaced.title,before.page.title); assert.deepEqual(replaced.content,before.page.content);
 assert.equal(after.events.length,before.events.length+1); assert.deepEqual(after.events.at(-1)[2].page,body);
});
test("historical restore: stale revision refuses with current state and zero effects",async()=>{
 const {page,version,base}=await fixture(); const before=await state(page.id);
 conflict(await restore(version,base-1),"REVISION_CONFLICT",base); assert.deepEqual(await state(page.id),before);
});
test("historical restore: repeated same-version request does not create a second snapshot",async()=>{
 const {page,version,base}=await fixture(); status(await restore(version,base),200); const before=await state(page.id);
 conflict(await restore(version,base),"REVISION_CONFLICT",base+1); assert.deepEqual(await state(page.id),before);
});
test("historical restore: two restores from one base have exactly one winner",async()=>{
 const {page,version,base}=await fixture();
 const second=status(await req("ALICE","POST",`/api/wiki/pages/${page.id}/versions`,{name:"Also chosen"}),201).data;
 const before=await state(page.id);
 const [a,b]=await race("WikiPage",page.id,[()=>restore(version,base),()=>restore(second,base)]);
 status(a,200); conflict(b,"REVISION_CONFLICT",base+1);
 const after=await state(page.id); assert.equal(after.page.revision,base+1); assert.equal(after.versions.length,before.versions.length+1); assert.equal(after.events.length,before.events.length+1);
});
for(const restoreFirst of [true,false]) test(`historical restore: same-base save/restore ordered restoreFirst=${restoreFirst}`,async()=>{
 const {page,version,base}=await fixture(); const before=await state(page.id);
 const r=()=>restore(version,base), s=()=>save("ALICE",page.id,{title:"Racing edit",content:doc("racing current"),expectedRevision:base});
 const [first,second]=await race("WikiPage",page.id,restoreFirst?[r,s]:[s,r]);
 status(first,200); conflict(second,"REVISION_CONFLICT",base+1);
 const after=await state(page.id); assert.equal(after.page.revision,base+1); assert.equal(after.events.length,before.events.length+1);
 assert.deepEqual(after.page.content,doc(restoreFirst?"selected old text":"racing current"));
 if(restoreFirst){assert.equal(after.versions.length,before.versions.length+1);assert.deepEqual(after.versions.at(-1).content,before.page.content);}
});
test("historical restore: valid base preserves other-user lock refusal",async()=>{
 const {page,version,base}=await fixture();status(await acquire("ALICE",page.id),200);const before=await state(page.id);
 const body=conflict(await restore(version,base,"BOB"),"EDIT_LOCKED",base);assert.equal(body.current.lockedBy.id,users.ALICE.id);assert.deepEqual(await state(page.id),before);
});
test("historical restore: ordinary revision-checked PATCH preserves stale refusal",async()=>{
 const page=await newPage();status(await save("ALICE",page.id,{title:"Reviewed edit",expectedRevision:0}),200);const before=await state(page.id);
 assert.equal(before.page.revision,1);conflict(await save("ALICE",page.id,{content:doc("stale"),expectedRevision:0}),"REVISION_CONFLICT",1);assert.deepEqual(await state(page.id),before);
});
