// HTTP benchmark for a server running on a scripts/perf/seed.ts database.
// Times the main read endpoints (and, with "write", task create/move and chat
// send) one request at a time and prints p50/p95 per endpoint.
//
//   BENCH_URL=http://127.0.0.1:3901 JWT_SECRET=<the server's> DATABASE_URL=... \
//     pnpm --dir packages/backend perf:bench [read|write|all] [--samples=30] [--out=results.json]
//
// Actors and ids are looked up in the database, so runs against copies of the
// same fixture use the same requests. Each request uses a new connection from
// a rotating 127.0.0.x source address, so the per-address rate limit does not
// throttle the run; the server must listen on all loopback addresses.

import http from "node:http";
import { writeFileSync } from "node:fs";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith("--")) ?? "read";
const option = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const SAMPLES = Number(option("samples") ?? "30");
const WARMUP = Number(option("warmup") ?? "3");
const OUT = option("out");
const ONLY = option("only");
const base = new URL(process.env.BENCH_URL ?? "http://127.0.0.1:3901");
const secret = process.env.JWT_SECRET;
if (!secret) throw new Error("JWT_SECRET must match the server's");

const prisma = new PrismaClient();
let source = 2;

interface Response {
  status: number;
  ms: number;
  bytes: number;
  body: unknown;
}

function request(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const localAddress = `127.0.0.${source}`;
  source = source >= 250 ? 2 : source + 1;
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const req = http.request(
      {
        host: base.hostname,
        port: base.port,
        path: `/api${path}`,
        method,
        localAddress,
        agent: false,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // keep text
          }
          resolve({ status: res.statusCode ?? 0, ms, bytes: Buffer.byteLength(text), body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function percentile(sorted: number[], p: number) {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function itemCount(body: unknown) {
  const data = (body as { data?: unknown })?.data;
  return Array.isArray(data) ? data.length : Array.isArray(body) ? body.length : undefined;
}

interface Result {
  name: string;
  samples: number;
  p50: number;
  p95: number;
  mean: number;
  max: number;
  bytes: number;
  items?: number;
}

async function measure(name: string, run: (i: number) => Promise<Response>, samples = SAMPLES, warmup = WARMUP): Promise<Result> {
  for (let i = 0; i < warmup; i++) await check(name, await run(-1 - i));
  const times: number[] = [];
  let last: Response | undefined;
  for (let i = 0; i < samples; i++) {
    last = await check(name, await run(i));
    times.push(last.ms);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const result = {
    name,
    samples,
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    mean: round(times.reduce((a, b) => a + b, 0) / times.length),
    max: round(sorted[sorted.length - 1]),
    bytes: last!.bytes,
    items: itemCount(last!.body),
  };
  console.log(`${name.padEnd(44)} p50 ${String(result.p50).padStart(8)} ms  p95 ${String(result.p95).padStart(8)} ms  ${result.items ?? "-"} items  ${result.bytes} B`);
  return result;
}

async function check(name: string, res: Response) {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${name}: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  return res;
}

const round = (n: number) => Math.round(n * 10) / 10;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function fixture() {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: "perf-large" } });
  const wid = workspace.id;
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: "perf-user-0000@perf.invalid" } });
  // The member with the most assignments: the heaviest "my tasks" and board user.
  const [member] = await prisma.$queryRaw<{ id: string; email: string }[]>`
    SELECT u.id, u.email FROM "User" u
    JOIN "WorkspaceMember" wm ON wm."userId" = u.id AND wm."workspaceId" = ${wid} AND wm.role = 'MEMBER'
    JOIN "TaskAssignee" ta ON ta."userId" = u.id
    GROUP BY u.id, u.email ORDER BY count(*) DESC, u.id LIMIT 1`;
  const projects = await prisma.$queryRaw<{ id: string; tasks: number }[]>`
    SELECT p.id, count(t.id)::int AS tasks FROM "Project" p
    JOIN "ProjectMember" pm ON pm."projectId" = p.id AND pm."userId" = ${member.id}
    LEFT JOIN "Task" t ON t."projectId" = p.id AND NOT t.archived
    WHERE p."workspaceId" = ${wid} AND NOT p.archived
    GROUP BY p.id ORDER BY tasks DESC, p.id`;
  const big = projects[0];
  const median = projects[Math.floor(projects.length / 2)];
  const statuses = await prisma.statusColumn.findMany({ where: { projectId: big.id }, orderBy: { position: "asc" } });
  const task = await prisma.task.findFirstOrThrow({
    where: { projectId: big.id, archived: false, activities: { some: {} } },
    orderBy: { id: "asc" },
  });
  const general = await prisma.chatChannel.findFirstOrThrow({ where: { workspaceId: wid, name: "general" } });
  const [thread] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "parentId" AS id FROM "ChatMessage" WHERE "channelId" = ${general.id} AND "parentId" IS NOT NULL
    GROUP BY "parentId" ORDER BY count(*) DESC, "parentId" LIMIT 1`;
  const [olderPage] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "ChatMessage" WHERE "channelId" = ${general.id} AND "parentId" IS NULL
    ORDER BY "createdAt" DESC OFFSET 2000 LIMIT 1`;
  const [folder] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT f.id FROM "File" f JOIN "File" c ON c."parentId" = f.id AND c."trashedAt" IS NULL
    WHERE f."workspaceId" = ${wid} AND f."ownerId" = ${member.id} AND f."isFolder" AND f."trashedAt" IS NULL
    GROUP BY f.id ORDER BY count(*) DESC, f.id LIMIT 1`;
  const [team] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT t.id FROM "TeamFolder" t JOIN "TeamFolderMember" m ON m."teamFolderId" = t.id AND m."userId" = ${member.id}
    JOIN "File" f ON f."teamFolderId" = t.id
    WHERE t."workspaceId" = ${wid} GROUP BY t.id ORDER BY count(*) DESC, t.id LIMIT 1`;
  const [space] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT s.id FROM "WikiSpace" s JOIN "WikiPage" p ON p."spaceId" = s.id
    WHERE s."workspaceId" = ${wid} GROUP BY s.id ORDER BY count(*) DESC, s.id LIMIT 1`;
  const [wikiParent] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "parentId" AS id FROM "WikiPage" WHERE "spaceId" = ${space.id} AND "parentId" IS NOT NULL
    GROUP BY "parentId" ORDER BY count(*) DESC, "parentId" LIMIT 1`;
  return { wid, admin, member, big, median, statuses, task, general, thread, olderPage, folder, team, space, wikiParent };
}

function token(user: { id: string; email: string }) {
  return jwt.sign({ sub: user.id, email: user.email, sid: "perf-bench" }, secret!, { expiresIn: "2h" });
}

async function readBench(f: Awaited<ReturnType<typeof fixture>>) {
  const m = token(f.member);
  const a = token(f.admin);
  const get = (t: string, path: string) => () => request("GET", path, t);
  const week = `startDate=${day(-6)}&endDate=${day(0)}`;
  const quarter = `startDate=${day(-90)}&endDate=${day(0)}`;
  const endpoints: [string, () => Promise<Response>][] = [
    ["tasks: board, largest project", get(m, `/projects/${f.big.id}/tasks?view=board`)],
    ["tasks: board, median project", get(m, `/projects/${f.median.id}/tasks?view=board`)],
    ["tasks: list page 1 (position)", get(m, `/projects/${f.big.id}/tasks`)],
    ["tasks: list page 50 (position)", get(m, `/projects/${f.big.id}/tasks?page=50`)],
    ["tasks: list by due date", get(m, `/projects/${f.big.id}/tasks?sort=dueDate`)],
    ["tasks: list, assignee filter", get(m, `/projects/${f.big.id}/tasks?assignee=${f.member.id}`)],
    ["tasks: task activity", get(m, `/tasks/${f.task.id}/activity`)],
    ["workspace: my tasks", get(m, `/workspaces/${f.wid}/my-tasks`)],
    ["workspace: dashboard (member)", get(m, `/workspaces/${f.wid}/dashboard`)],
    ["workspace: dashboard (admin)", get(a, `/workspaces/${f.wid}/dashboard`)],
    ["workspace: activity (member)", get(m, `/workspaces/${f.wid}/activity?limit=30`)],
    ["workspace: activity (admin)", get(a, `/workspaces/${f.wid}/activity?limit=30`)],
    ["workspace: projects list", get(m, `/workspaces/${f.wid}/projects`)],
    ["search: common term", get(m, `/workspaces/${f.wid}/search?q=invoice`)],
    ["search: no match", get(m, `/workspaces/${f.wid}/search?q=qzxv`)],
    ["chat: channel list", get(m, `/chat/${f.wid}/channels`)],
    ["chat: history, newest page", get(m, `/chat/${f.wid}/channels/${f.general.id}/messages`)],
    ["chat: history, older page", get(m, `/chat/${f.wid}/channels/${f.general.id}/messages?cursor=${f.olderPage.id}`)],
    ["chat: thread replies", get(m, `/chat/${f.wid}/messages/${f.thread.id}/thread`)],
    ["chat: unread counts", get(m, `/chat/${f.wid}/unread`)],
    ["notifications: list", get(m, `/notifications`)],
    ["notifications: mentions widget", get(m, `/notifications?type=CHAT_MENTION,COMMENT_MENTION&limit=10`)],
    ["notifications: unread count", get(m, `/notifications/unread-count`)],
    ["drive: root (member)", get(m, `/workspaces/${f.wid}/files`)],
    ["drive: root (admin)", get(a, `/workspaces/${f.wid}/files`)],
    ["drive: largest personal folder", get(m, `/workspaces/${f.wid}/files?parentId=${f.folder.id}`)],
    ["drive: team folder", get(m, `/workspaces/${f.wid}/files?teamFolderId=${f.team.id}`)],
    ["drive: recent files widget", get(m, `/workspaces/${f.wid}/files?sortBy=updatedAt&sortOrder=desc`)],
    ["drive: trash", get(m, `/workspaces/${f.wid}/files?trashed=true`)],
    ["drive: starred", get(m, `/workspaces/${f.wid}/files/starred`)],
    ["drive: shared with me", get(m, `/workspaces/${f.wid}/files/shared-with-me`)],
    ["drive: shared by me", get(m, `/workspaces/${f.wid}/files/shared-by-me`)],
    ["wiki: spaces", get(m, `/workspaces/${f.wid}/wiki/spaces`)],
    ["wiki: tree root, largest space", get(m, `/wiki/spaces/${f.space.id}/pages/tree`)],
    ["wiki: tree children, largest parent", get(m, `/wiki/spaces/${f.space.id}/pages/tree?parentId=${f.wikiParent.id}`)],
    ["time: my entries, week", get(m, `/workspaces/${f.wid}/time/entries?${week}&userId=${f.member.id}`)],
    ["time: report 90 days (admin)", get(a, `/workspaces/${f.wid}/time/reports?${quarter}`)],
  ];
  const results: Result[] = [];
  for (const [name, run] of endpoints) {
    if (ONLY && !name.includes(ONLY)) continue;
    results.push(await measure(name, run));
  }
  return results;
}

async function writeBench(f: Awaited<ReturnType<typeof fixture>>) {
  const m = token(f.member);
  const created: string[] = [];
  const results: Result[] = [];
  const target = f.statuses[2];
  const n = Math.max(SAMPLES, 20);
  results.push(
    await measure(
      "write: create task",
      async (i) => {
        const res = await request("POST", `/projects/${f.big.id}/tasks`, m, { title: `Bench task ${i}` });
        created.push((res.body as { data: { id: string } }).data?.id);
        return res;
      },
      n,
      2,
    ),
  );
  let next = 0;
  results.push(
    await measure(
      "write: move task to column end",
      () => request("PATCH", `/tasks/${created[next++]}/move`, m, { statusId: target.id, position: 1_000_000 }),
      Math.floor(n / 2) - 1,
      1,
    ),
  );
  results.push(
    await measure(
      "write: move task to column top",
      () => request("PATCH", `/tasks/${created[next++]}/move`, m, { statusId: f.statuses[3].id, position: 0 }),
      Math.floor(n / 2) - 1,
      1,
    ),
  );
  results.push(
    await measure(
      "write: send chat message",
      (i) => request("POST", `/chat/${f.wid}/channels/${f.general.id}/messages`, m, { content: `Bench message ${i}` }),
      n,
      2,
    ),
  );
  return results;
}

async function main() {
  const f = await fixture();
  console.log(
    `Fixture: workspace ${f.wid}, member ${f.member.email}, largest project ${f.big.id} (${f.big.tasks} active tasks), median project ${f.median.id} (${f.median.tasks})`,
  );
  const output: Record<string, unknown> = { mode, samples: SAMPLES, at: new Date().toISOString(), fixture: { member: f.member.email, big: f.big, median: f.median } };
  if (mode === "read" || mode === "all") output.read = await readBench(f);
  if (mode === "write" || mode === "all") output.write = await writeBench(f);
  if (OUT) writeFileSync(OUT, JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
