// Text search with pg_trgm GIN indexes (docs/remediation/p02c.md).
//
// - The migration installs pg_trgm and five valid trigram indexes, and each
//   search path's own ILIKE can use its index.
// - Every search path returns the same rows in the same order through the
//   indexes as through a table scan, for wildcard, escape, short, long,
//   mixed-case and non-ASCII terms.
// - Access scoping and order are unchanged: members see their projects,
//   channels and files, admins their workspace, nobody another workspace.
// - `%`, `_` and `\` keep their LIKE meaning: Prisma's `contains` does not
//   escape them, and this change keeps that behaviour.
// - Search statements keep a plan per term (plan_cache_mode is set for their
//   transaction only), so a generic plan cannot read the whole trigram index
//   for a one- or two-letter term.
// - On a libc database the index finds every row ILIKE finds, for every cased
//   character. On an ICU database it would not (pg_trgm lowercases with
//   libc), so the migration creates no index there and search returns
//   ILIKE's rows from a scan, as on main; the startup check warns.
// - A one-channel chat search in a small channel reads the channel, not the
//   trigram index.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "search-trigram-disposable-jwt",
  COOKIE_SECRET: "search-trigram-disposable-cookie",
});
const storage = await mkdtemp(path.join(os.tmpdir(), "werkyn-search-trigram-"));
process.env.STORAGE_DIR = storage;
const { buildApp } = await import("../../src/app.js");
const { searchTasks, searchWikiPages } = await import("../../src/modules/workspaces/workspaces.service.js");
const { searchMessages, chatSearchPlan } = await import("../../src/modules/chat/chat.service.js");
const { checkSearchIndexes, searchAvoidsTrigramIndexes } = await import("../../src/utils/text-search.js");
const { listFiles } = await import("../../src/modules/files/files.service.js");
const { listTasks } = await import("../../src/modules/tasks/tasks.service.js");
const { startRefreshSession } = await import("../../src/modules/auth/refresh-sessions.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { FileQuerySchema, TaskQuerySchema } = await import("@pm/shared");
const { PrismaClient } = await import("@prisma/client");

/** A client whose sessions start with `options` (one connection). */
function client(options, log = false) {
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set("connection_limit", "1");
  if (options) url.searchParams.set("options", options);
  return new PrismaClient({ datasourceUrl: url.toString(), ...(log ? { log: [{ level: "query", emit: "event" }] } : {}) });
}
// Only bitmap scans, no nested loops, and every row a plan reads or filters
// costs much more than an index page: the trigram index is used wherever it
// can serve a statement. (On this small data the planner otherwise reads the
// searched project, channel or workspace through its foreign-key index.)
const indexed = client(
  "-c enable_seqscan=off -c enable_indexscan=off -c enable_nestloop=off -c cpu_tuple_cost=10 -c cpu_operator_cost=10",
  true,
);
// No bitmap scans: GIN indexes cannot be used at all.
const scanned = client("-c enable_bitmapscan=off");
let recorded = null;
indexed.$on("query", (event) => recorded?.push(event));
/** The SELECT statements with an ILIKE that `run` sent through `indexed`. */
async function searchStatements(run) {
  recorded = [];
  await run();
  // Query events are delivered asynchronously after each statement.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const statements = recorded.filter((event) => event.query.startsWith("SELECT ") && event.query.includes(" ILIKE "));
  recorded = null;
  return statements;
}

// Index name: table, columns and operator classes.
const INDEXES = {
  ChatMessage_content_trgm_idx: ["ChatMessage", "content", "gin_trgm_ops"],
  File_name_trgm_idx: ["File", "name", "gin_trgm_ops"],
  Task_description_trgm_idx: ["Task", "description", "gin_trgm_ops"],
  Task_title_trgm_idx: ["Task", "title", "gin_trgm_ops"],
  WikiPage_title_trgm_idx: ["WikiPage", "title", "gin_trgm_ops"],
};
/** The trigram index that serves an ILIKE on `table`.`column`. */
const indexFor = (table, column) =>
  Object.entries(INDEXES).find(([, [t, columns]]) => t === table && columns === column)?.[0];

// Texts with LIKE metacharacters, case and non-ASCII variants. The same list
// fills task titles, task descriptions, messages, page titles and file names.
const TEXTS = [
  "Rate 50% off invoice",
  "rate 50 percent invoice",
  "snake_case name",
  "snakeXcase name",
  "back\\slash path",
  "ends with 50\\%",
  "Äpfel und Birnen",
  "ÄPFEL ernte",
  "Warehouse sync",
  "warehouse SYNC later",
  "in",
  "x",
  "zebra crossing",
];
const TERMS = [
  "warehouse", "WAREHOUSE", "wArEhOuSe", "sync", "ouse sy", "50%", "50\\%", "%", "%%", "_", "snake_case",
  "e_c", "\\", "\\\\", "h\\", "\\%", "\\_", "in", "IN", "i", "x", "zz", "äpfel", "ÄPF", "pfel und",
  "invoice", "rate 50", "qzxv", "zebra crossing", " ", "n", ".",
];
const ASCII_TERMS = TERMS.filter((term) => /^[\x20-\x7e]*$/.test(term));
// Filler rows in the searched scopes (the member's project, channel, files
// and the workspace's wiki), so that reading a whole project, channel or
// workspace costs more than the trigram index and the index client's plans
// use it. Their text is "Q" and four letters without e, i, n, x or z, and
// every term above needs one of those, a digit, a space, a dot, a backslash
// or a non-ASCII letter, so only "%", "%%" and "_" match them.
const FILLERS = 2000;
const fillerText = (k) => `Q${[...k.toString(20).padStart(4, "0")].map((d) => "abcdfghjklmopqrstuvwy"[parseInt(d, 20)]).join("")}`;

/** PostgreSQL ILIKE '%term%' with the default escape character, ASCII case only. */
function ilike(value, term) {
  if (value == null) return false;
  const lower = (text) => text.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  const pattern = `%${lower(term)}%`;
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") source += (pattern[++i] ?? "").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    else if (c === "%") source += "[\\s\\S]*";
    else if (c === "_") source += "[\\s\\S]";
    else source += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${source}$`).test(lower(value));
}

const suffix = crypto.randomUUID().slice(0, 12);
const T0 = Date.UTC(2026, 5, 1);
const at = (n) => new Date(T0 + n * 60_000);
const users = {};
const tokens = {};
const families = [];
const workspaces = {};
const projects = {};
const statuses = {};
const channels = {};
const tasks = [];
const messages = [];
const pages = [];
const files = [];
let app, requests = 0;

async function get(actor, url) {
  const res = await app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.91.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
  return res;
}
async function ok(actor, url) {
  const res = await get(actor, url);
  assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
  return res.json();
}
const ids = (rows) => rows.map((row) => row.id);
const byUpdatedDesc = (a, b) => b.updatedAt - a.updatedAt;
const byCreatedDesc = (a, b) => b.createdAt - a.createdAt || (a.id > b.id ? -1 : a.id < b.id ? 1 : 0);
const textOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ─── Expected results computed from the rows, as main computes them ───────

function expectedGlobalTasks(actor, term, limit) {
  const visible = tasks.filter((t) =>
    !t.archived && ["p1", ...(actor === "admin" ? ["p2"] : [])].includes(t.project));
  const titles = visible.filter((t) => ilike(t.title, term)).sort(byUpdatedDesc).slice(0, limit);
  const rest = limit - titles.length;
  const descriptions = rest > 0
    ? visible.filter((t) => !titles.includes(t) && ilike(t.description, term)).sort(byUpdatedDesc).slice(0, rest)
    : [];
  return ids([...titles, ...descriptions]);
}
function expectedWiki(term, limit) {
  return ids(pages.filter((p) => p.workspace === "main" && ilike(p.title, term)).sort(byUpdatedDesc).slice(0, limit));
}
function expectedMessages(actor, term, limit, channel) {
  const readable = channel
    ? [channel]
    : actor === "admin" ? ["joined", "private", "adminOnly"] : ["joined", "private"];
  return ids(messages.filter((m) => readable.includes(m.channel) && !m.deletedAt && ilike(m.content, term))
    .sort(byCreatedDesc).slice(0, limit));
}
/** Matching files in the listing's order, name then ID in the database collation. */
async function expectedFiles(actor, term) {
  const matching = ids(files.filter((f) => f.workspace === "main" && !f.trashed &&
    (actor === "admin" || f.owner === "member") && ilike(f.name, term)));
  if (matching.length === 0) return [];
  return ids(await app.prisma.$queryRaw`SELECT id FROM "File" WHERE id = ANY(${matching}) ORDER BY name, id`);
}
function expectedTaskList(term) {
  return ids(tasks.filter((t) => t.project === "p1" && !t.archived && ilike(t.title, term))
    .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt || textOrder(a.id, b.id)));
}

// ─── Each search path through a given client ─────────────────────────────

function paths(actor) {
  const userId = users[actor].id;
  const role = actor === "admin" ? "ADMIN" : "MEMBER";
  const wid = workspaces.main.id;
  return {
    "global search: tasks": async (db, term) => ids((await searchTasks(db, wid, userId, role, term, 50)).data),
    "global search: wiki pages": async (db, term) => ids(await searchWikiPages(db, wid, term, 50)),
    "chat search: all channels": async (db, term) => ids((await searchMessages(db, wid, userId, term, undefined, undefined, 50)).data),
    "chat search: one channel": async (db, term) => ids((await searchMessages(db, wid, userId, term, channels.joined.id, undefined, 50)).data),
    "drive search": async (db, term) => ids((await listFiles(db, wid, FileQuerySchema.parse({ search: term, limit: "100" }), { workspaceId: wid, userId, workspaceRole: role })).data),
    "drive search by size, descending": async (db, term) => ids((await listFiles(db, wid, FileQuerySchema.parse({ search: term, limit: "100", sortBy: "size", sortOrder: "desc" }), { workspaceId: wid, userId, workspaceRole: role })).data),
    "task list search": async (db, term) => ids((await listTasks(db, projects.p1.id, TaskQuerySchema.parse({ search: term, limit: "100" }))).data),
    "task list search, page 2": async (db, term) => ids((await listTasks(db, projects.p1.id, TaskQuerySchema.parse({ search: term, limit: "3", page: "2" }))).data),
    "board search": async (db, term) => ids((await listTasks(db, projects.p1.id, TaskQuerySchema.parse({ search: term, view: "board" }))).data),
  };
}

before(async () => {
  app = await buildApp();
  await app.ready();
  app.broadcast = () => {};
  const db = app.prisma;
  for (const name of ["admin", "member", "other", "foreign"]) {
    users[name] = await db.user.create({
      data: { email: `trgm-${name}-${suffix}@example.test`, displayName: `Trigram ${name}`, emailVerified: true },
    });
    const session = await startRefreshSession(db, users[name].id);
    families.push(session.familyId);
    tokens[name] = signAccessToken({ sub: users[name].id, email: users[name].email, sid: session.familyId });
  }
  workspaces.main = await db.workspace.create({ data: {
    name: "Trigram search", slug: `trgm-main-${suffix}`,
    members: { create: [
      { userId: users.admin.id, role: "ADMIN" },
      { userId: users.member.id, role: "MEMBER" },
      { userId: users.other.id, role: "MEMBER" },
    ] },
  } });
  workspaces.foreign = await db.workspace.create({ data: {
    name: "Trigram foreign", slug: `trgm-foreign-${suffix}`,
    members: { create: [{ userId: users.foreign.id, role: "ADMIN" }, { userId: users.member.id, role: "MEMBER" }] },
  } });

  // p1: member and admin; p2: admin only; p3: archived project; px: another workspace.
  for (const [key, wid, members, archived] of [
    ["p1", "main", ["admin", "member"], false],
    ["p2", "main", ["admin"], false],
    ["p3", "main", ["admin", "member"], true],
    ["px", "foreign", ["foreign", "member"], false],
  ]) {
    projects[key] = await db.project.create({ data: {
      workspaceId: workspaces[wid].id, name: `Trigram ${key}`, archived,
      members: { create: members.map((name) => ({ userId: users[name].id })) },
    } });
    statuses[key] = await db.statusColumn.create({ data: { projectId: projects[key].id, name: "Open", position: 0 } });
  }
  let n = 0;
  for (const project of ["p1", "p2", "p3", "px"]) {
    TEXTS.forEach((text, i) => {
      // Each description holds another text than its task's title, so some
      // tasks match a term by their description only.
      const description = i % 3 === 0 ? null : `<p>${TEXTS[(i + 4) % TEXTS.length]} described</p>`;
      tasks.push({
        id: `trgm_t_${project}_${String(i).padStart(2, "0")}_${suffix}`,
        project, title: text, description, archived: false,
        position: (i * 7) % 5, createdAt: at(i), updatedAt: at(1000 - ++n * 3 + (i % 4)),
      });
    });
    tasks.push({
      id: `trgm_t_${project}_archived_${suffix}`, project, title: "Warehouse sync archived",
      description: "<p>warehouse 50% snake_case</p>", archived: true, position: 0, createdAt: at(50), updatedAt: at(2000),
    });
  }
  for (let k = 0; k < FILLERS; k++)
    tasks.push({
      id: `trgm_t_p1_filler_${String(k).padStart(4, "0")}_${suffix}`, project: "p1", title: fillerText(k),
      description: k % 2 ? `<p>${fillerText(k + FILLERS)}</p>` : null, archived: false,
      position: 10 + k, createdAt: at(-k), updatedAt: at(-10_000 - k),
    });
  await db.task.createMany({ data: tasks.map((t) => ({
    id: t.id, projectId: projects[t.project].id, statusId: statuses[t.project].id, title: t.title,
    description: t.description, archived: t.archived, position: t.position, createdAt: t.createdAt, updatedAt: t.updatedAt,
  })) });

  for (const [key, wid, type, members] of [
    ["joined", "main", "PUBLIC", ["admin", "member"]],
    ["private", "main", "PRIVATE", ["admin", "member"]],
    ["notJoined", "main", "PUBLIC", ["other"]],
    ["adminOnly", "main", "PRIVATE", ["admin", "other"]],
    ["foreign", "foreign", "PUBLIC", ["foreign", "member"]],
  ]) {
    channels[key] = await db.chatChannel.create({ data: {
      workspaceId: workspaces[wid].id, name: `trgm-${key}`, type, createdById: users[members[0]].id,
      members: { create: members.map((name) => ({ userId: users[name].id })) },
    } });
  }
  for (const channel of Object.keys(channels)) {
    TEXTS.forEach((text, i) => messages.push({
      id: `trgm_m_${channel}_${String(i).padStart(2, "0")}_${suffix}`, channel, content: text,
      // Equal timestamps in pairs: the ID orders them.
      createdAt: at(Math.floor(i / 2)), deletedAt: i === 9 ? at(500) : null,
    }));
  }
  for (let k = 0; k < FILLERS; k++)
    messages.push({
      id: `trgm_m_filler_${String(k).padStart(4, "0")}_${suffix}`, channel: "joined", content: fillerText(k),
      createdAt: at(-1000 - k), deletedAt: null,
    });
  await db.chatMessage.createMany({ data: messages.map((m) => ({
    id: m.id, channelId: channels[m.channel].id, userId: users.admin.id, content: m.content,
    createdAt: m.createdAt, deletedAt: m.deletedAt,
  })) });

  for (const [key, wid] of [["main", "main"], ["second", "main"], ["foreign", "foreign"]]) {
    const space = await db.wikiSpace.create({ data: { workspaceId: workspaces[wid].id, name: `Trigram ${key}`, slug: `trgm-${key}-${suffix}` } });
    TEXTS.forEach((text, i) => pages.push({
      id: `trgm_w_${key}_${String(i).padStart(2, "0")}_${suffix}`, workspace: wid, spaceId: space.id,
      title: `${text} page`, updatedAt: at(3000 - pages.length * 2),
    }));
  }
  const mainSpace = pages[0].spaceId;
  for (let k = 0; k < FILLERS; k++)
    pages.push({
      id: `trgm_w_filler_${String(k).padStart(4, "0")}_${suffix}`, workspace: "main", spaceId: mainSpace,
      title: fillerText(k), updatedAt: at(-10_000 - k),
    });
  await db.wikiPage.createMany({ data: pages.map((p) => ({
    id: p.id, spaceId: p.spaceId, title: p.title, createdById: users.admin.id, updatedAt: p.updatedAt,
  })) });

  for (const [owner, wid, trashed] of [["member", "main", false], ["other", "main", false], ["member", "main", true], ["foreign", "foreign", false]]) {
    TEXTS.forEach((text, i) => files.push({
      id: `trgm_f_${owner}_${wid}_${trashed ? "t" : "l"}_${String(i).padStart(2, "0")}_${suffix}`,
      workspace: wid, owner, trashed, name: `${text}.txt`,
      // Equal sizes in pairs, and one without a size.
      size: i === 5 ? null : Math.floor(i / 2) * 100,
    }));
  }
  for (let k = 0; k < FILLERS; k++)
    files.push({
      id: `trgm_f_filler_${String(k).padStart(4, "0")}_${suffix}`, workspace: "main", owner: "member", trashed: false,
      name: fillerText(k), size: k,
    });
  await db.file.createMany({ data: files.map((f) => ({
    id: f.id, workspaceId: workspaces[f.workspace].id, name: f.name, isFolder: false, size: f.size,
    uploadedById: users[f.owner].id, ownerId: users[f.owner].id, trashedAt: f.trashed ? at(10) : null,
  })) });
  for (const table of ["Task", "ChatMessage", "WikiPage", "File"]) await db.$executeRawUnsafe(`ANALYZE "${table}"`);
});

after(async () => {
  try {
    if (app) {
      await app.prisma.file.deleteMany({ where: { workspaceId: { in: Object.values(workspaces).map((w) => w.id) } } });
      await app.prisma.workspace.deleteMany({ where: { id: { in: Object.values(workspaces).map((w) => w.id) } } });
      await app.prisma.rotatedRefreshToken.deleteMany({ where: { familyId: { in: families } } });
      await app.prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
    }
  } finally {
    await Promise.allSettled([indexed.$disconnect(), scanned.$disconnect()]);
    await app?.close();
    await rm(storage, { recursive: true, force: true });
  }
});

describe("migration", () => {
  test("pg_trgm is installed and the five trigram indexes are valid GIN indexes", async () => {
    const extensions = await app.prisma.$queryRaw`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`;
    assert.deepEqual(extensions.map((e) => e.extname), ["pg_trgm"]);
    const rows = await app.prisma.$queryRaw`
      SELECT c.relname AS name, t.relname AS "table", am.amname AS method,
             i.indisvalid AS valid, i.indisready AS ready,
             (SELECT string_agg(a.attname, ',' ORDER BY k.n)
                FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, n)
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS columns,
             (SELECT string_agg(o.opcname, ',' ORDER BY k.n)
                FROM unnest(i.indclass::oid[]) WITH ORDINALITY k(opclass, n)
                JOIN pg_opclass o ON o.oid = k.opclass) AS opclasses
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_am am ON am.oid = c.relam
      WHERE c.relname LIKE '%trgm%' AND t.relnamespace = to_regnamespace(current_schema())
      ORDER BY c.relname`;
    assert.deepEqual(
      rows.map((r) => [r.name, r.table, r.columns, r.opclasses, r.method, r.valid, r.ready]),
      Object.entries(INDEXES).map(([name, [table, columns, opclasses]]) => [name, table, columns, opclasses, "gin", true, true]),
    );
  });

  test("each search path's own ILIKE predicate can use its trigram index", async () => {
    // Every statement with an ILIKE that a path runs, as Prisma writes it. The
    // predicate is a plain column ILIKE parameter, which the trigram index of
    // that column serves; checked per predicate, so the join plan of the
    // whole statement (cost-based on this small data) does not matter here.
    const expectations = [
      ["global search", ["ChatMessage.content", "Task.description", "Task.title", "WikiPage.title"],
        (db, term) => Promise.all([
          searchTasks(db, workspaces.main.id, users.member.id, "MEMBER", term, 50),
          searchWikiPages(db, workspaces.main.id, term, 10),
          searchMessages(db, workspaces.main.id, users.member.id, term, undefined, undefined, 10),
        ])],
      ["chat search: one channel", ["ChatMessage.content"], paths("member")["chat search: one channel"]],
      ["drive search (member)", ["File.name"], paths("member")["drive search"]],
      ["drive search (admin)", ["File.name"], paths("admin")["drive search"]],
      ["task list search", ["Task.title"], paths("member")["task list search"]],
      ["board search", ["Task.title"], paths("member")["board search"]],
    ];
    for (const [label, expected, run] of expectations) {
      const statements = await searchStatements(() => run(indexed, "warehouse"));
      const seen = new Set();
      for (const event of statements) {
        const params = JSON.parse(event.params);
        for (const [, table, column, n] of event.query.matchAll(/"public"\."(\w+)"\."(\w+)" ILIKE \$(\d+)/g)) {
          assert.equal(params[n - 1], "%warehouse%", `${label}: the term is bound as %term%`);
          const [{ "QUERY PLAN": plan }] = await indexed.$queryRawUnsafe(
            `EXPLAIN (FORMAT JSON) SELECT 1 FROM "public"."${table}" WHERE "public"."${table}"."${column}" ILIKE $1`,
            params[n - 1],
          );
          assert.match(JSON.stringify(plan), new RegExp(`"Index Name":"${indexFor(table, column)}"`), `${label}: ${table}.${column}`);
          seen.add(`${table}.${column}`);
        }
      }
      assert.deepEqual([...seen].sort(), expected, `${label}: ILIKE columns`);
    }
  });
});

describe("parity: index and table scan return the same rows in the same order", () => {
  // The joined channel (2,013 messages) counts as large here, so the
  // one-channel path may use the trigram index too (see "one-channel chat
  // search" for the small-channel plan).
  before(() => { chatSearchPlan.smallChannelMessages = 100; });
  after(() => { chatSearchPlan.smallChannelMessages = 20_000; });
  for (const actor of ["member", "admin"])
    test(`every path and term (${actor})`, async (t) => {
      let compared = 0, nonEmpty = 0;
      const throughIndex = {};
      for (const [label, run] of Object.entries(paths(actor))) {
        throughIndex[label] = 0;
        for (const term of TERMS) {
          let viaIndex;
          const statements = await searchStatements(async () => { viaIndex = await run(indexed, term); });
          const viaScan = await run(scanned, term);
          assert.deepEqual(viaIndex, viaScan, `${label} "${term}"`);
          compared++;
          if (viaScan.length) nonEmpty++;
          // Whether the index client's plan for this statement read a
          // trigram index (cost-based; counted, not required per term).
          // Prisma's logged parameters are not valid JSON when they hold a
          // backslash; those terms are not counted.
          for (const event of statements) {
            let params;
            try { params = JSON.parse(event.params); } catch { break; }
            const [{ "QUERY PLAN": plan }] = await indexed.$queryRawUnsafe(`EXPLAIN (FORMAT JSON) ${event.query}`, ...params);
            if (/"Index Name":"\w+_trgm_idx"/.test(JSON.stringify(plan))) { throughIndex[label]++; break; }
          }
        }
      }
      t.diagnostic(`terms whose statements read a trigram index, per path: ${JSON.stringify(throughIndex)}`);
      // The comparison went through the trigram indexes on every path.
      for (const [label, count] of Object.entries(throughIndex))
        assert.ok(count > 0, `${label}: no statement read a trigram index (${JSON.stringify(throughIndex)})`);
      assert.equal(compared, Object.keys(paths(actor)).length * TERMS.length);
      assert.ok(nonEmpty > compared / 2, `${nonEmpty} of ${compared} lists have rows`);
    });
});

describe("results, order and access scoping match the ILIKE semantics", () => {
  test("global search: tasks by title then description, wiki pages and chat, per role", async () => {
    for (const term of ASCII_TERMS) {
      const q = encodeURIComponent(term);
      for (const actor of ["member", "admin"]) {
        const body = await ok(actor, `/api/workspaces/${workspaces.main.id}/search?q=${q}&limit=50`);
        assert.deepEqual(ids(body.data), expectedGlobalTasks(actor, term, 50), `tasks "${term}" (${actor})`);
        assert.deepEqual(ids(body.wikiPages), expectedWiki(term, 10), `wiki "${term}" (${actor})`);
        assert.deepEqual(ids(body.chatMessages), expectedMessages(actor, term, 10), `chat "${term}" (${actor})`);
      }
      // A small limit: description matches fill what title matches leave.
      const small = await ok("member", `/api/workspaces/${workspaces.main.id}/search?q=${q}&limit=3`);
      assert.deepEqual(ids(small.data), expectedGlobalTasks("member", term, 3), `tasks "${term}" limit 3`);
    }
    // Another workspace's member sees nothing of this one.
    const foreign = await get("foreign", `/api/workspaces/${workspaces.main.id}/search?q=warehouse`);
    assert.equal(foreign.statusCode, 403);
  });

  test("chat search: member channels across the workspace, one readable channel, cursor pages", async () => {
    for (const term of ASCII_TERMS) {
      const q = encodeURIComponent(term);
      for (const actor of ["member", "admin"]) {
        const body = await ok(actor, `/api/chat/${workspaces.main.id}/messages/search?q=${q}&limit=50`);
        assert.deepEqual(ids(body.data), expectedMessages(actor, term, 50), `"${term}" (${actor})`);
      }
      const joined = await ok("member", `/api/chat/${workspaces.main.id}/channels/${channels.joined.id}/messages/search?q=${q}&limit=50`);
      assert.deepEqual(ids(joined.data), expectedMessages("member", term, 50, "joined"), `"${term}" in one channel`);
      // A public channel can be searched without joining it.
      const open = await ok("member", `/api/chat/${workspaces.main.id}/channels/${channels.notJoined.id}/messages/search?q=${q}&limit=50`);
      assert.deepEqual(ids(open.data), expectedMessages("member", term, 50, "notJoined"), `"${term}" in a public channel`);
    }
    const hidden = await get("member", `/api/chat/${workspaces.main.id}/channels/${channels.adminOnly.id}/messages/search?q=warehouse`);
    assert.equal(hidden.statusCode, 403);
    // Cursor pages of one match at a time cover the list once, in order.
    const expected = expectedMessages("member", "in", 1000);
    const seen = [];
    let cursor;
    do {
      const page = await ok("member", `/api/chat/${workspaces.main.id}/messages/search?q=in&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...ids(page.data));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, expected);
  });

  test("drive search: own files for members, the workspace for admins, never trashed or foreign", async () => {
    for (const term of ASCII_TERMS) {
      const q = encodeURIComponent(term);
      for (const actor of ["member", "admin"]) {
        const seen = [];
        let cursor;
        const expected = await expectedFiles(actor, term);
        const limit = expected.length > 40 ? 100 : 4;
        do {
          const page = await ok(actor, `/api/workspaces/${workspaces.main.id}/files?search=${q}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
          seen.push(...ids(page.data));
          cursor = page.nextCursor;
        } while (cursor);
        assert.deepEqual(seen, expected, `"${term}" (${actor})`);
      }
    }
  });

  test("task list and board search stay inside the project and its access check", async () => {
    for (const term of ASCII_TERMS) {
      const q = encodeURIComponent(term);
      const list = await ok("member", `/api/projects/${projects.p1.id}/tasks?search=${q}&limit=100`);
      assert.deepEqual(ids(list.data), expectedTaskList(term).slice(0, 100), `list "${term}"`);
      assert.equal(list.pagination.total, expectedTaskList(term).length, `total "${term}"`);
      const board = await ok("member", `/api/projects/${projects.p1.id}/tasks?view=board&search=${q}`);
      assert.deepEqual(ids(board.data).sort(), [...expectedTaskList(term)].sort(), `board "${term}"`);
    }
    const denied = await get("member", `/api/projects/${projects.p2.id}/tasks?search=warehouse`);
    assert.equal(denied.statusCode, 403);
  });

  test("%, _ and \\ keep their LIKE meaning (unchanged: contains does not escape them)", async () => {
    const titles = async (term) => {
      const body = await ok("admin", `/api/workspaces/${workspaces.main.id}/search?q=${encodeURIComponent(term)}&limit=50`);
      return [...new Set(body.data.filter((t) => t.projectId === projects.p1.id && TEXTS.includes(t.title)).map((t) => t.title))].sort();
    };
    const titleMatches = (term) => [...new Set(TEXTS.filter((text) => ilike(text, term)))].sort();
    // "50%" is "50" followed by anything; "\%" is a literal percent sign.
    assert.ok((await titles("50%")).includes("rate 50 percent invoice"));
    assert.deepEqual((await titles("\\%")).filter((t) => titleMatches("\\%").includes(t)), titleMatches("\\%"));
    assert.ok(!titleMatches("\\%").includes("rate 50 percent invoice"));
    // "_" is any one character; "\_" is a literal underscore.
    assert.ok(titleMatches("snake_case").includes("snakeXcase name"));
    assert.deepEqual(titleMatches("\\_"), ["snake_case name"]);
    // A trailing backslash escapes the appended %, so the text must end in "%".
    assert.deepEqual(titleMatches("\\"), ["ends with 50\\%"]);
    assert.deepEqual(titleMatches("\\\\"), ["back\\slash path", "ends with 50\\%"]);
    for (const term of ["50%", "\\%", "snake_case", "\\_", "\\", "\\\\", "%", "_"]) {
      const viaApi = await titles(term);
      const descriptionOnly = viaApi.filter((t) => !titleMatches(term).includes(t));
      assert.deepEqual(viaApi.filter((t) => titleMatches(term).includes(t)), titleMatches(term), `"${term}"`);
      // Anything else came from a description match of the same pattern.
      for (const title of descriptionOnly) {
        const task = tasks.find((t) => t.project === "p1" && t.title === title);
        assert.ok(ilike(task.description, term), `"${term}" matched "${title}" by its description`);
      }
    }
  });

  test("case-insensitive for ASCII and non-ASCII letters alike, through index and scan", async () => {
    const run = paths("admin")["global search: wiki pages"];
    const upper = await run(indexed, "ÄPFEL");
    const lower = await run(indexed, "äpfel");
    assert.deepEqual(upper, lower);
    assert.deepEqual(upper, await run(scanned, "ÄPFEL"));
    assert.deepEqual(await run(indexed, "WAREHOUSE SYNC"), await run(indexed, "warehouse sync"));
    assert.deepEqual(await run(indexed, "WAREHOUSE SYNC"), expectedWiki("warehouse sync", 50));
  });
});

describe("plans per term", () => {
  test("search statements are planned for their term every time; other statements keep the default", async () => {
    const single = client(null);
    try {
      const wid = workspaces.main.id;
      // Ten searches on one connection: past the five custom plans after
      // which PostgreSQL may switch a prepared statement to a generic plan.
      for (let i = 0; i < 10; i++) {
        const term = i % 2 ? "in" : "warehouse";
        await searchMessages(single, wid, users.member.id, term, undefined, undefined, 20);
        await searchMessages(single, wid, users.member.id, term, channels.joined.id, undefined, 20);
        await searchTasks(single, wid, users.member.id, "MEMBER", term, 20);
        await searchWikiPages(single, wid, term, 10);
        await listFiles(single, wid, FileQuerySchema.parse({ search: term }), { workspaceId: wid, userId: users.member.id, workspaceRole: "MEMBER" });
        await listTasks(single, projects.p1.id, TaskQuerySchema.parse({ search: term }));
        await listTasks(single, projects.p1.id, TaskQuerySchema.parse({ search: term, view: "board" }));
      }
      const prepared = await single.$queryRaw`
        SELECT statement, generic_plans::int AS generic, custom_plans::int AS custom
        FROM pg_prepared_statements WHERE position(' IL' || 'IKE ' IN statement) > 0`;
      // Title, description (one statement per number of excluded title
      // matches), wiki, both chat searches, files, task page, task count and
      // board.
      assert.ok(prepared.length >= 9, `${prepared.length} prepared search statements`);
      for (const row of prepared)
        assert.equal(row.generic, 0, `generic plan for ${row.statement.slice(0, 120)}`);
      assert.ok(prepared.filter((row) => row.custom >= 10).length >= 6,
        "most search statements ran ten times, each with its own plan");
      // Control: the same kind of statement outside withSearchPlans switches
      // to a generic plan after five executions, so the check above can fail.
      for (let i = 0; i < 10; i++)
        await single.chatMessage.findMany({
          where: { channelId: channels.joined.id, content: { contains: i % 2 ? "in" : "warehouse", mode: "insensitive" } },
          select: { id: true },
        });
      const [control] = await single.$queryRaw`
        SELECT generic_plans::int AS generic FROM pg_prepared_statements
        WHERE position(' IL' || 'IKE ' IN statement) > 0 AND position('"ChatMessage"."id" FROM' IN statement) > 0
          AND position('ORDER BY' IN statement) = 0`;
      assert.ok(control?.generic > 0, `control statement generic plans: ${control?.generic}`);
      // The setting ended with each search transaction.
      const [{ mode }] = await single.$queryRaw`SELECT current_setting('plan_cache_mode') AS mode`;
      assert.equal(mode, "auto");
    } finally {
      await single.$disconnect();
    }
  });
});

// ─── Case folding: libc and ICU databases ────────────────────────────────

const backendDir = fileURLToPath(new URL("../../", import.meta.url));
const prismaPackage = createRequire(import.meta.url).resolve("prisma/package.json");
const prismaCli = path.resolve(path.dirname(prismaPackage), JSON.parse(await readFile(prismaPackage, "utf8")).bin.prisma);
const run = promisify(execFile);

/**
 * Index against scan over every code point whose lower() or upper() differs
 * from itself, in data rows c / lower(c) / upper(c) inside a word and at a
 * word start, and patterns of the same shapes. The scan side is ILIKE in a
 * join; the index side a forced GIN bitmap scan per pattern. Temporary
 * tables, rolled back. Returns the pair counts.
 */
async function caseFoldSweep(db) {
  let result;
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE cf_d (id serial PRIMARY KEY, cp int, s text) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE cf_p (id serial PRIMARY KEY, cp int, pat text) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`
        WITH cps AS (SELECT cp, chr(cp) c FROM generate_series(1, 1114111) cp
          WHERE cp NOT BETWEEN 55296 AND 57343 AND (lower(chr(cp)) <> chr(cp) OR upper(chr(cp)) <> chr(cp)))
        INSERT INTO cf_d (cp, s) SELECT cp, shape FROM cps,
          LATERAL (VALUES (c), (lower(c)), (upper(c))) v(x),
          LATERAL (VALUES ('qa' || x || 'bq'), ('qa ' || x || 'bq'), ('Qa' || upper(x) || 'Bq')) t(shape)`);
      await tx.$executeRawUnsafe(`
        INSERT INTO cf_p (cp, pat) SELECT DISTINCT d.cp, shape FROM (SELECT DISTINCT cp FROM cf_d) d,
          LATERAL (VALUES (chr(d.cp)), (lower(chr(d.cp))), (upper(chr(d.cp)))) v(y),
          LATERAL (VALUES ('%a' || y || 'b%'), ('% ' || y || 'bq%')) p(shape)`);
      await tx.$executeRawUnsafe(`CREATE INDEX cf_d_trgm ON cf_d USING gin (s gin_trgm_ops)`);
      await tx.$executeRawUnsafe(`ANALYZE cf_d`);
      await tx.$executeRawUnsafe(`ANALYZE cf_p`);
      const [scan] = await tx.$queryRawUnsafe(`
        SELECT count(*)::int AS n FROM cf_p p JOIN cf_d d ON d.cp = p.cp WHERE d.s ILIKE p.pat`);
      await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
      await tx.$executeRawUnsafe(`SET LOCAL enable_hashjoin = off`);
      await tx.$executeRawUnsafe(`SET LOCAL enable_mergejoin = off`);
      await tx.$executeRawUnsafe(`SET LOCAL enable_indexscan = off`);
      const [plan] = await tx.$queryRawUnsafe(`
        EXPLAIN (FORMAT JSON) SELECT p.id, d.id FROM cf_p p
        CROSS JOIN LATERAL (SELECT id, cp FROM cf_d WHERE s ILIKE p.pat) d WHERE d.cp = p.cp`);
      assert.match(JSON.stringify(plan), /"Index Name":"cf_d_trgm"/, "the sweep's index side reads the trigram index");
      const [rows] = await tx.$queryRawUnsafe(`
        WITH ref AS (SELECT p.id pid, d.id did FROM cf_p p JOIN cf_d d ON d.cp = p.cp
                     WHERE d.s || '' ILIKE p.pat),
             idx AS (SELECT p.id pid, d.id did FROM cf_p p
                     CROSS JOIN LATERAL (SELECT id, cp FROM cf_d WHERE s ILIKE p.pat) d WHERE d.cp = p.cp)
        SELECT (SELECT count(*)::int FROM (SELECT DISTINCT cp FROM cf_d) c) AS codepoints,
               (SELECT count(*)::int FROM ref) AS scan,
               (SELECT count(*)::int FROM idx) AS index,
               (SELECT count(*)::int FROM (SELECT * FROM ref EXCEPT SELECT * FROM idx) m) AS missing,
               (SELECT count(*)::int FROM (SELECT * FROM idx EXCEPT SELECT * FROM ref) x) AS extra`);
      assert.equal(rows.scan, scan.n, "the scan side does not use the index");
      result = rows;
      throw new Error("rollback");
    }, { timeout: 300_000, maxWait: 10_000 });
  } catch (error) {
    if (error.message !== "rollback") throw error;
  }
  return result;
}

describe("case folding", () => {
  test("libc database: the trigram index finds every row ILIKE finds, for every cased character", async (t) => {
    const [{ provider }] = await app.prisma.$queryRaw`
      SELECT to_jsonb(d) ->> 'datlocprovider' AS provider FROM pg_database d WHERE d.datname = current_database()`;
    if ((provider ?? "c") !== "c") return t.skip(`the test database's default collation provider is ${provider}`);
    const sweep = await caseFoldSweep(app.prisma);
    t.diagnostic(`libc: ${JSON.stringify(sweep)}`);
    assert.ok(sweep.codepoints > 1000 && sweep.scan > 10_000, JSON.stringify(sweep));
    assert.equal(sweep.missing, 0);
    assert.equal(sweep.extra, 0);
    // The startup check is quiet when the indexes are there.
    const warnings = [];
    assert.equal(await checkSearchIndexes(app.prisma, { warn: (...a) => warnings.push(a) }), "ok");
    assert.deepEqual(warnings, []);
    // It reports an index with an expected name but another definition (the
    // migration's IF NOT EXISTS would skip it), and a missing one.
    for (const replacement of [`CREATE INDEX "WikiPage_title_trgm_idx" ON "WikiPage" ("title")`, null]) {
      const found = [];
      try {
        await app.prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`DROP INDEX "WikiPage_title_trgm_idx"`);
          if (replacement) await tx.$executeRawUnsafe(replacement);
          assert.equal(await checkSearchIndexes(tx, { warn: (...a) => found.push(a) }), "warned");
          throw new Error("rollback");
        });
      } catch (error) {
        if (error.message !== "rollback") throw error;
      }
      assert.deepEqual(found.map(([details]) => details), [{ missing: ["WikiPage_title_trgm_idx"], collationProvider: "libc" }]);
      assert.match(found[0][1], /missing, invalid or defined differently/);
    }
    // The check looks in the tables' schema, not the role's current schema:
    // another existing schema first on the search_path is no reason to warn.
    const first = `r18b_first_${suffix.replaceAll("-", "")}`;
    await app.prisma.$executeRawUnsafe(`CREATE SCHEMA "${first}"`);
    const pathed = client(`-c search_path=${first},public`);
    try {
      const [{ schema }] = await pathed.$queryRaw`SELECT current_schema() AS schema`;
      assert.equal(schema, first);
      const quiet = [];
      assert.equal(await checkSearchIndexes(pathed, { warn: (...a) => quiet.push(a) }), "ok");
      assert.deepEqual(quiet, []);
    } finally {
      await pathed.$disconnect();
      await app.prisma.$executeRawUnsafe(`DROP SCHEMA "${first}"`);
    }
    // A check that cannot read the catalog warns and keeps searches off the
    // trigram indexes; the next successful check on libc lets them back.
    let failing = true;
    const flaky = {
      $queryRaw: (...args) => (failing ? Promise.reject(new Error("connection refused")) : app.prisma.$queryRaw(...args)),
    };
    const failed = [];
    assert.equal(await checkSearchIndexes(flaky, { warn: (...a) => failed.push(a) }), "failed");
    assert.deepEqual(failed.map(([details]) => details), [{ err: "connection refused" }]);
    assert.match(failed[0][1], /Could not check/);
    assert.equal(searchAvoidsTrigramIndexes(flaky), true);
    const silent = [];
    assert.equal(await checkSearchIndexes(flaky, { warn: (...a) => silent.push(a) }, "public", { reportFailure: false }), "failed");
    assert.deepEqual(silent, []);
    failing = false;
    assert.equal(await checkSearchIndexes(flaky, { warn: (...a) => silent.push(a) }), "ok");
    assert.equal(searchAvoidsTrigramIndexes(flaky), false);
    assert.deepEqual(silent, []);
  });

  describe("ICU databases", () => {
    const databases = [];
    let skip = null;
    const TEXTS_ICU = [
      "ΟΔΟΣ", "ΟΔΟΣ Α", "οδος κεντρική", "IŞIK lamba", "ışık lamba", "ISTANBUL ofis", "İstanbul ofis",
      "istanbul ofis", "ⓐⓑⓒ circled", "ⒶⒷⒸ CIRCLED", "STRAẞE groß", "Straße", "Café Résumé", "plain warehouse sync",
    ];
    const TERMS_ICU = [
      "οδος", "ΟΔΟΣ", "οδοσ", "ışık", "IŞIK", "ıstanbul", "istanbul", "İstanbul", "ISTANBUL", "ⓐⓑⓒ", "ⒶⒷⒸ",
      "straße", "STRASSE", "café", "warehouse", "sync",
    ];

    before(async () => {
      const [{ version, icu }] = await app.prisma.$queryRaw`
        SELECT current_setting('server_version_num')::int AS version,
               EXISTS (SELECT 1 FROM pg_collation WHERE collprovider = 'i') AS icu`;
      if (version < 150000 || !icu) {
        skip = "PostgreSQL without ICU database locales (version 15 or later built with ICU)";
        return;
      }
      const base = new URL(process.env.TEST_DATABASE_URL);
      for (const [key, locale] of [["und", "und"], ["tr", "tr-TR"]]) {
        const name = `${base.pathname.slice(1)}_icu_${key}_${suffix.replaceAll("-", "")}`.slice(0, 63);
        try {
          await app.prisma.$executeRawUnsafe(
            `CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE '${locale}'`);
        } catch (error) {
          skip = `cannot create an ICU database: ${error.message}`;
          return;
        }
        const url = new URL(process.env.TEST_DATABASE_URL);
        url.pathname = `/${name}`;
        url.searchParams.set("connection_limit", "2");
        databases.push({ key, name, url: url.toString() });
      }
      for (const db of databases) {
        const { stdout } = await run(process.execPath, [prismaCli, "migrate", "deploy", "--schema", path.join(backendDir, "prisma/schema.prisma")], {
          cwd: backendDir, env: { ...process.env, DATABASE_URL: db.url }, maxBuffer: 8 * 1024 * 1024,
        });
        db.deployOutput = stdout;
        db.prisma = new PrismaClient({ datasourceUrl: db.url });
        // A workspace with one task, message, page and file per text.
        const user = await db.prisma.user.create({ data: { email: `icu-${suffix}@example.test`, displayName: "ICU", emailVerified: true } });
        const workspace = await db.prisma.workspace.create({ data: {
          name: "ICU", slug: `icu-${suffix}`, members: { create: { userId: user.id, role: "ADMIN" } },
        } });
        const project = await db.prisma.project.create({ data: { workspaceId: workspace.id, name: "ICU", members: { create: { userId: user.id } } } });
        const status = await db.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open", position: 0 } });
        const channel = await db.prisma.chatChannel.create({ data: {
          workspaceId: workspace.id, name: "icu", type: "PUBLIC", createdById: user.id, members: { create: { userId: user.id } },
        } });
        const space = await db.prisma.wikiSpace.create({ data: { workspaceId: workspace.id, name: "ICU", slug: "icu" } });
        await db.prisma.task.createMany({ data: TEXTS_ICU.map((text, i) => ({
          projectId: project.id, statusId: status.id, title: text, description: `<p>${text}</p>`, position: i, updatedAt: at(i),
        })) });
        await db.prisma.chatMessage.createMany({ data: TEXTS_ICU.map((text, i) => ({
          channelId: channel.id, userId: user.id, content: text, createdAt: at(i),
        })) });
        await db.prisma.wikiPage.createMany({ data: TEXTS_ICU.map((text, i) => ({
          spaceId: space.id, title: text, createdById: user.id, updatedAt: at(i),
        })) });
        await db.prisma.file.createMany({ data: TEXTS_ICU.map((text) => ({
          workspaceId: workspace.id, name: text, isFolder: false, uploadedById: user.id, ownerId: user.id,
        })) });
        Object.assign(db, { user, workspace, project, channel });
      }
    });

    after(async () => {
      for (const db of databases) {
        await db.prisma?.$disconnect();
        await app.prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db.name}" WITH (FORCE)`);
      }
    });

    test("the migration applies and creates neither pg_trgm nor any trigram index; the startup check warns", async (t) => {
      if (skip) return t.skip(skip);
      for (const db of databases) {
        assert.match(db.deployOutput, /20261105180000_search_trigram_indexes/);
        const [state] = await db.prisma.$queryRaw`
          SELECT (SELECT datlocprovider::text FROM pg_database WHERE datname = current_database()) AS provider,
                 (SELECT count(*)::int FROM pg_extension WHERE extname = 'pg_trgm') AS extensions,
                 (SELECT count(*)::int FROM pg_class WHERE relname LIKE '%trgm%') AS indexes,
                 (SELECT count(*)::int FROM _prisma_migrations
                   WHERE migration_name = '20261105180000_search_trigram_indexes' AND finished_at IS NOT NULL) AS applied`;
        assert.deepEqual(state, { provider: "i", extensions: 0, indexes: 0, applied: 1 }, db.key);
        const warnings = [];
        assert.equal(await checkSearchIndexes(db.prisma, { warn: (...a) => warnings.push(a) }), "warned");
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0][0].collationProvider, "icu");
        assert.match(warnings[0][1], /collation provider is icu/);
      }
    });

    test("every search path returns ILIKE's rows, as main does", async (t) => {
      if (skip) return t.skip(skip);
      for (const db of databases) {
        const userId = db.user.id;
        const wid = db.workspace.id;
        for (const term of TERMS_ICU) {
          const scan = async (table, column, order) => (await db.prisma.$queryRawUnsafe(
            `SELECT id FROM "${table}" WHERE "${column}" ILIKE '%' || $1 || '%' ORDER BY ${order}`, term)).map((r) => r.id);
          const tasks = (await searchTasks(db.prisma, wid, userId, "ADMIN", term, 50)).data.map((r) => r.id);
          const byTitle = await scan("Task", "title", `"updatedAt" DESC`);
          const byDescription = (await scan("Task", "description", `"updatedAt" DESC`)).filter((id) => !byTitle.includes(id));
          assert.deepEqual(tasks, [...byTitle, ...byDescription], `${db.key} tasks "${term}"`);
          assert.deepEqual(ids(await searchWikiPages(db.prisma, wid, term, 50)), await scan("WikiPage", "title", `"updatedAt" DESC`), `${db.key} wiki "${term}"`);
          const messages = await scan("ChatMessage", "content", `"createdAt" DESC, id DESC`);
          assert.deepEqual(ids((await searchMessages(db.prisma, wid, userId, term, undefined, undefined, 50)).data), messages, `${db.key} chat "${term}"`);
          assert.deepEqual(ids((await searchMessages(db.prisma, wid, userId, term, db.channel.id, undefined, 50)).data), messages, `${db.key} channel "${term}"`);
          const files = ids((await listFiles(db.prisma, wid, FileQuerySchema.parse({ search: term, limit: "100" }), { workspaceId: wid, userId, workspaceRole: "ADMIN" })).data);
          assert.deepEqual([...files].sort(), [...await scan("File", "name", "id")].sort(), `${db.key} drive "${term}"`);
          assert.deepEqual(ids((await listTasks(db.prisma, db.project.id, TaskQuerySchema.parse({ search: term, limit: "100" }))).data).sort(),
            [...byTitle].sort(), `${db.key} task list "${term}"`);
        }
      }
      // The case the migration avoids: on ICU, a trigram index (built here in
      // a rolled-back transaction) would drop rows that ILIKE matches.
      const und = databases.find((db) => db.key === "und");
      const sweep = await (async () => {
        let out;
        try {
          await und.prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`CREATE EXTENSION pg_trgm`);
            await tx.$executeRawUnsafe(`CREATE INDEX icu_probe ON "ChatMessage" USING gin (content gin_trgm_ops)`);
            // Distinct statement texts: a statement without parameters keeps
            // its first plan, whatever the settings at its next execution.
            await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
            const viaIndex = await tx.$queryRawUnsafe(`SELECT content /* index */ FROM "ChatMessage" WHERE content ILIKE '%οδος%' ORDER BY content`);
            await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = on`);
            await tx.$executeRawUnsafe(`SET LOCAL enable_bitmapscan = off`);
            const viaScan = await tx.$queryRawUnsafe(`SELECT content /* scan */ FROM "ChatMessage" WHERE content ILIKE '%οδος%' ORDER BY content`);
            out = { viaIndex: viaIndex.map((r) => r.content), viaScan: viaScan.map((r) => r.content).sort() };
            throw new Error("rollback");
          });
        } catch (error) {
          if (error.message !== "rollback") throw error;
        }
        return out;
      })();
      t.diagnostic(`ICU "οδος" through a trigram index: ${JSON.stringify(sweep.viaIndex)}; by scan: ${JSON.stringify(sweep.viaScan)}`);
      assert.deepEqual(sweep.viaScan, ["οδος κεντρική", "ΟΔΟΣ", "ΟΔΟΣ Α"].sort(), "ICU ILIKE applies the final-sigma rule");
      // And the search above returned them, from a scan.
      assert.deepEqual(
        (await searchMessages(und.prisma, und.workspace.id, und.user.id, "οδος", undefined, undefined, 50)).data.map((m) => m.content).sort(),
        sweep.viaScan);
      // Turkish ICU: the dotless and dotted i fold as in Turkish.
      const tr = databases.find((db) => db.key === "tr");
      const found = async (term) => (await searchMessages(tr.prisma, tr.workspace.id, tr.user.id, term, undefined, undefined, 50)).data.map((m) => m.content);
      assert.ok((await found("ışık")).includes("IŞIK lamba"));
      assert.ok((await found("ıstanbul")).includes("ISTANBUL ofis"));
    });

    test("a libc dump restored into an ICU database: the check warns with the drop statements and search avoids the indexes", async (t) => {
      if (skip) return t.skip(skip);
      const und = databases.find((db) => db.key === "und");
      // What a restore of a libc database brings along: the extension and
      // the five indexes, built as the migration builds them on libc.
      await und.prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      // One of them renamed: the check finds trigram indexes by definition.
      for (const [name, table, column] of [
        ["Task_title_trgm_idx", "Task", "title"], ["Task_description_trgm_idx", "Task", "description"],
        ["restored_chat_search", "ChatMessage", "content"], ["WikiPage_title_trgm_idx", "WikiPage", "title"],
        ["File_name_trgm_idx", "File", "name"],
      ]) await und.prisma.$executeRawUnsafe(`CREATE INDEX "${name}" ON "${table}" USING GIN ("${column}" gin_trgm_ops)`);
      // Sessions in which every row read costs far more than an index page,
      // so the planner takes the trigram index wherever bitmap scans are
      // allowed. The checked client keeps sequential scans, its fallback;
      // the unchecked one has none, so it shows what the index returns.
      const sessions = "-c enable_indexscan=off -c enable_nestloop=off -c cpu_tuple_cost=10 -c cpu_operator_cost=10";
      const url = (options) => {
        const u = new URL(und.url);
        u.searchParams.set("options", options);
        return u.toString();
      };
      const unchecked = new PrismaClient({ datasourceUrl: url(`${sessions} -c enable_seqscan=off`) });
      const checked = new PrismaClient({ datasourceUrl: url(sessions) });
      try {
        const warnings = [];
        assert.equal(await checkSearchIndexes(checked, { warn: (...a) => warnings.push(a) }), "warned");
        assert.equal(searchAvoidsTrigramIndexes(checked), true);
        assert.equal(warnings.length, 1);
        const [details, message] = warnings[0];
        assert.equal(details.collationProvider, "icu");
        assert.deepEqual([...details.trigramIndexes].sort(), [
          "File_name_trgm_idx", "Task_description_trgm_idx", "Task_title_trgm_idx", "WikiPage_title_trgm_idx", "restored_chat_search",
        ].sort());
        assert.deepEqual([...details.drop].sort(), [
          'DROP INDEX "public"."File_name_trgm_idx";', 'DROP INDEX "public"."Task_description_trgm_idx";',
          'DROP INDEX "public"."Task_title_trgm_idx";', 'DROP INDEX "public"."WikiPage_title_trgm_idx";',
          'DROP INDEX "public"."restored_chat_search";',
        ].sort());
        for (const statement of details.drop) assert.ok(message.includes(statement), statement);
        const contents = async (db) =>
          (await searchMessages(db, und.workspace.id, und.user.id, "οδος", undefined, undefined, 50)).data.map((m) => m.content).sort();
        // The checked client avoids the indexes and returns ILIKE's rows.
        assert.deepEqual(await contents(checked), ["ΟΔΟΣ", "ΟΔΟΣ Α", "οδος κεντρική"].sort());
        const [{ version }] = await und.prisma.$queryRaw`SELECT current_setting('server_version_num')::int AS version`;
        const lost = await contents(unchecked);
        t.diagnostic(`"οδος" through the restored index: ${JSON.stringify(lost)}`);
        if (version < 180000) assert.ok(lost.length < 3, `the restored index drops matches without the check: ${JSON.stringify(lost)}`);
        // After the drop statements, the check reports the plain ICU state
        // and no longer keeps the client off the (gone) indexes.
        for (const statement of details.drop) await und.prisma.$executeRawUnsafe(statement);
        const after = [];
        assert.equal(await checkSearchIndexes(checked, { warn: (...a) => after.push(a) }), "warned");
        assert.match(after[0][1], /are not created on a database whose default collation provider is icu/);
        assert.equal(searchAvoidsTrigramIndexes(checked), false);
      } finally {
        await Promise.allSettled([unchecked.$disconnect(), checked.$disconnect()]);
        await und.prisma.$executeRawUnsafe(`DROP EXTENSION IF EXISTS pg_trgm CASCADE`);
      }
    });

    test("an ICU database's own trigram index would miss matches (why the migration skips it)", async (t) => {
      if (skip) return t.skip(skip);
      const und = databases.find((db) => db.key === "und");
      await und.prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      try {
        const sweep = await caseFoldSweep(und.prisma);
        t.diagnostic(`ICU und: ${JSON.stringify(sweep)}`);
        assert.equal(sweep.extra, 0);
        const [{ version }] = await und.prisma.$queryRaw`SELECT current_setting('server_version_num')::int AS version`;
        // PostgreSQL 16 and 17: pg_trgm lowercases with libc. (Re-check the
        // migration's provider condition if a later version reports 0.)
        if (version < 180000) assert.ok(sweep.missing > 0, JSON.stringify(sweep));
      } finally {
        await und.prisma.$executeRawUnsafe(`DROP EXTENSION IF EXISTS pg_trgm`);
      }
    });
  });
});

// ─── One-channel chat search in a small channel ──────────────────────────

describe("one-channel chat search", () => {
  /**
   * The plan of the service's page query for a one-channel search, EXPLAINed
   * after the service's own settings statement in one transaction.
   */
  async function channelSearchPlan(db, term, channelId) {
    const all = [];
    const listener = (event) => all.push(event);
    db.$on("query", listener);
    await searchMessages(db, workspaces.main.id, users.member.id, term, channelId, undefined, 20);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settings = all.find((event) => event.query.includes("set_config('enable_bitmapscan'"));
    const page = all.find((event) => event.query.startsWith("SELECT ") && event.query.includes(" ILIKE ") && event.query.includes("ORDER BY"));
    assert.ok(settings && page, "the service sends the channel-size settings and the page query");
    return db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(settings.query, ...JSON.parse(settings.params));
      const [{ "QUERY PLAN": plan }] = await tx.$queryRawUnsafe(`EXPLAIN (FORMAT JSON) ${page.query}`, ...JSON.parse(page.params));
      return JSON.stringify(plan);
    });
  }

  test("a small channel is read through its own index; above the limit the trigram index may be used", async () => {
    // The joined channel holds 2,013 messages.
    assert.equal(chatSearchPlan.smallChannelMessages, 20_000);
    // Default planner settings, apart from the service's own.
    const plain = client(null, true);
    try {
      const small = await channelSearchPlan(plain, "warehouse", channels.joined.id);
      assert.doesNotMatch(small, /_trgm_idx/);
      assert.match(small, /"Index Name":"ChatMessage_channelId_createdAt_idx"/);
    } finally {
      await plain.$disconnect();
    }
    // Above the limit the service leaves the scans to the planner; on this
    // small data only the index client prefers the trigram index.
    chatSearchPlan.smallChannelMessages = 100;
    try {
      assert.match(await channelSearchPlan(indexed, "warehouse", channels.joined.id), /"Index Name":"ChatMessage_content_trgm_idx"/);
    } finally {
      chatSearchPlan.smallChannelMessages = 20_000;
    }
  });

  test("both plans return the same messages, in order, as a scan and as ILIKE", async () => {
    const wid = workspaces.main.id;
    const reference = {};
    for (const term of TERMS)
      reference[term] = ids((await searchMessages(scanned, wid, users.member.id, term, channels.joined.id, undefined, 50)).data);
    for (const term of ASCII_TERMS)
      assert.deepEqual(reference[term], expectedMessages("member", term, 50, "joined"), `"${term}"`);
    for (const limit of [20_000, 100]) {
      chatSearchPlan.smallChannelMessages = limit;
      try {
        for (const term of TERMS)
          for (const db of [app.prisma, indexed])
            assert.deepEqual(
              ids((await searchMessages(db, wid, users.member.id, term, channels.joined.id, undefined, 50)).data),
              reference[term],
              `"${term}", limit ${limit}`,
            );
      } finally {
        chatSearchPlan.smallChannelMessages = 20_000;
      }
    }
  });
});
