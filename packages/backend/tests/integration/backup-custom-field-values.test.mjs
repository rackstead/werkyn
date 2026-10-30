import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "backup-custom-field-values-secret",
  COOKIE_SECRET: "backup-custom-field-values-cookie",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-backup-cfv-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");

let app, admin, workspace, token;
let requests = 0;

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 12);
  admin = await app.prisma.user.create({
    data: { email: `backup-cfv-${suffix}@example.test`, displayName: "Backup CFV", emailVerified: true },
  });
  token = signAccessToken({ sub: admin.id, email: admin.email });
  workspace = await app.prisma.workspace.create({
    data: { name: "Backup CFV", slug: `backup-cfv-${suffix}`, members: { create: { userId: admin.id, role: "ADMIN" } } },
  });
});

after(async () => {
  try {
    if (workspace) await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
    if (admin) await app.prisma.user.deleteMany({ where: { id: admin.id } });
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

function upload(action, json) {
  const boundary = `cfv-${crypto.randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.json"\r\nContent-Type: application/json\r\n\r\n`,
    ),
    Buffer.from(json),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: "POST",
    url: `/api/workspaces/${workspace.id}/backup/${action}`,
    payload,
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` },
    remoteAddress: `127.0.5.${1 + (++requests % 200)}`,
  });
}

const task = (id, customFieldValues) => ({
  _originalId: id,
  title: `Task ${id}`,
  priority: "MEDIUM",
  position: 0,
  statusRef: "s1",
  customFieldValues,
});

test("custom field values without a value key restore as empty, whatever the entry's size", async () => {
  // A small entry is validated in a batch; one over 512 values is walked on its
  // own. Neither has a `value` key, which Zod 3 accepted and restore skips.
  const walked = { fieldRef: "cf1", note: Array(600).fill(0) };
  const json = JSON.stringify({
    metadata: { version: "1.1", exportedAt: new Date().toISOString(), sourceWorkspace: { name: "Src", slug: "src" }, userRefs: [] },
    projects: [
      {
        project: { name: "Custom field values" },
        statuses: [{ _originalId: "s1", name: "To Do", position: 0, isCompletion: false }],
        customFields: [{ _originalId: "cf1", name: "Notes", type: "TEXT", options: null, required: false, position: 0 }],
        tasks: [task("small", [{ fieldRef: "cf1" }]), task("walked", [walked]), task("kept", [{ fieldRef: "cf1", value: "kept" }])],
      },
    ],
  });
  for (const action of ["preview", "restore"]) {
    const response = await upload(action, json);
    assert.equal(response.statusCode, 200, `${action}: ${response.body}`);
  }
  const project = await app.prisma.project.findFirst({ where: { workspaceId: workspace.id, name: "Custom field values" } });
  const tasks = await app.prisma.task.findMany({
    where: { projectId: project.id },
    select: { title: true, customFieldValues: { select: { value: true } } },
    orderBy: { title: "asc" },
  });
  assert.deepEqual(
    tasks.map((t) => [t.title, t.customFieldValues.map((v) => v.value)]),
    [
      ["Task kept", ["kept"]],
      ["Task small", []],
      ["Task walked", []],
    ],
  );
});
