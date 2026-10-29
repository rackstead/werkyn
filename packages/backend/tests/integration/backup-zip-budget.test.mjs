import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, before, test } from "node:test";
import {
  craftZip,
  crc32,
  crc32ZeroPadded,
  DEFLATED,
  storedLocalRecord,
  zip64Extra,
} from "../fixtures/crafted-zip.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
const childEnv = {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "backup-zip-budget-integration-jwt-secret",
  COOKIE_SECRET: "backup-zip-budget-integration-cookie-secret",
};
Object.assign(process.env, childEnv);
const { PrismaClient } = await import("@prisma/client");
const { signAccessToken } = await import("../../src/utils/tokens.ts");

const MiB = 1 << 20;
const INVALID = "Invalid backup ZIP: the archive is damaged or uses unsupported ZIP features";
const TOO_LARGE = "Invalid backup ZIP: the archive exceeds the restore limits";
const backendDir = new URL("../..", import.meta.url);
const suffix = crypto.randomUUID().slice(0, 8);
const prisma = new PrismaClient();
const root = await mkdtemp(path.join(os.tmpdir(), "werkyn-backup-budget-"));
const storageDir = path.join(root, "storage");
const casesDir = path.join(root, "cases");
let admin, workspace;

before(async () => {
  await mkdir(storageDir);
  await mkdir(casesDir);
  await mkdir(path.join(root, "outside"));
  await writeFile(path.join(root, "outside", "sentinel.txt"), "unchanged");
  admin = await prisma.user.create({
    data: {
      email: `backup-budget-${suffix}@example.test`,
      displayName: "Backup budget admin",
      emailVerified: true,
    },
  });
  workspace = await prisma.workspace.create({
    data: {
      name: "Backup budget",
      slug: `backup-budget-${suffix}`,
      members: { create: { userId: admin.id, role: "ADMIN" } },
    },
  });
});

after(async () => {
  // Rows are created here, not in the child, so a crashed child leaves nothing.
  try {
    if (workspace) await prisma.workspace.deleteMany({ where: { id: workspace.id } });
    if (admin) await prisma.user.deleteMany({ where: { id: admin.id } });
  } finally {
    await prisma.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
});

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** Every file under the test root (except the archives) with its digest. */
async function tree(dir = root, out = new Map()) {
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    if (full === casesDir) continue;
    const info = await lstat(full);
    if (info.isDirectory()) await tree(full, out);
    else out.set(path.relative(root, full), info.isFile() ? sha256(await readFile(full)) : "other");
  }
  return out;
}

function backupJson(label, urls = []) {
  return Buffer.from(
    JSON.stringify({
      metadata: {
        version: "1.1",
        exportedAt: new Date().toISOString(),
        sourceWorkspace: { name: "Crafted", slug: "crafted" },
        userRefs: [],
      },
      projects: [],
      channels: [],
      wikiSpaces: [
        {
          space: { name: label },
          pages: [
            {
              _originalId: "page",
              title: label,
              position: 0,
              content: urls.map((url) => ({ type: "image", props: { url } })),
            },
          ],
        },
      ],
    }),
  );
}

/** Raw deflate of `bytes` zero bytes without allocating them at once. */
async function deflateZeros(bytes) {
  const deflate = zlib.createDeflateRaw({ level: 9 });
  const chunks = [];
  deflate.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    deflate.on("end", resolve);
    deflate.on("error", reject);
  });
  const zeros = Buffer.alloc(MiB);
  for (let left = bytes; left > 0; left -= zeros.length) {
    if (!deflate.write(left >= zeros.length ? zeros : zeros.subarray(0, left)))
      await new Promise((resolve) => deflate.once("drain", resolve));
  }
  deflate.end();
  await done;
  return Buffer.concat(chunks);
}

/** Upload every case from a child limited to 1 GiB of data and a 256 MiB heap. */
async function runChild(cases) {
  const manifest = path.join(casesDir, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      workspaceId: workspace.id,
      token: signAccessToken({ sub: admin.id, email: admin.email }),
      cases,
    }),
  );
  const child = spawn(
    "/bin/sh",
    [
      "-c",
      'ulimit -S -d 1048576 || exit 90; exec "$@"',
      "sh",
      process.execPath,
      "--max-old-space-size=256",
      "--import",
      "tsx",
      "tests/integration/support/backup-upload-child.mjs",
      manifest,
    ],
    {
      cwd: backendDir,
      env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), ...childEnv, STORAGE_DIR: storageDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
  const [code, signal] = await new Promise((resolve) =>
    child.on("close", (...result) => resolve(result)),
  );
  clearTimeout(timer);
  // The app's own error logs share stdout; keep only the child's result lines.
  const lines = stdout
    .split("\n")
    .filter((line) => line.startsWith('{"label":'))
    .map((line) => JSON.parse(line));
  return { code, signal, stderr, lines };
}

test("hostile backup archives get a 400 from a memory-limited server process", async (t) => {
  const hello = Buffer.from("hello");
  const json = (label, urls) => ({ name: "backup.json", content: backupJson(label, urls) });
  const label = (name) => `Budget ${name} ${suffix}`;
  const legitAssets = {
    "assets/photo.png": crypto.randomBytes(64 * 1024),
    "assets/notes.100%25.txt": Buffer.alloc(256 * 1024, "werkyn "),
  };
  const outerName = "assets/outer.png";
  const huge = 520 * MiB;

  // [name, archive, expected message or null for success, actions]
  const cases = [
    ["legit", craftZip([
      json(label("legit"), Object.keys(legitAssets)),
      ...Object.entries(legitAssets).map(([name, content], i) => ({
        name,
        content,
        method: i ? DEFLATED : undefined,
      })),
    ]), null],
    // Exactly at the entry, name-length and depth limits.
    ["at-limits", craftZip([
      json(label("at-limits")),
      { name: `assets/${"d/".repeat(14)}${"n".repeat(989)}`, content: hello },
      ...Array.from({ length: 10_000 - 17 }, (_, i) => ({ name: `assets/${i}`, content: Buffer.from("x") })),
    ]), null, ["preview"]],
    ["duplicate-json", craftZip([json(label("dup-json-1")), json(label("dup-json-2"))]), INVALID],
    ["duplicate-asset", craftZip([
      json(label("dup-asset"), ["assets/dup-secret.png"]),
      { name: "assets/dup-secret.png", content: Buffer.from("first") },
      { name: "assets/dup-secret.png", content: Buffer.from("second") },
    ]), INVALID],
    ["duplicate-decoded", craftZip([
      json(label("dup-decoded")),
      { rawName: Buffer.from([0x61, 0x2f, 0xff]), content: Buffer.from("1") },
      { rawName: Buffer.from([0x61, 0x2f, 0xfe]), content: Buffer.from("2") },
    ]), INVALID],
    ["directory-count", craftZip([json(label("dir-count")), { name: "assets/a.png", content: hello }], { entryCount: 3 }), INVALID],
    ["directory-cut", (() => {
      const zip = craftZip([json(label("dir-cut")), { name: "assets/a.png", content: hello }]);
      const end = zip.length - 22;
      return Buffer.concat([zip.subarray(0, end - 8), zip.subarray(end)]);
    })(), INVALID],
    ["end-record-cut", craftZip([json(label("end-cut"))]).subarray(0, -5), INVALID],
    ["trailing-data", craftZip([json(label("trailing"))], { trailing: Buffer.from("junk") }), INVALID],
    ["zip64-extra", craftZip([
      json(label("zip64")),
      { name: "assets/z.png", content: hello, extra: zip64Extra(5, 5) },
    ]), INVALID],
    ["encrypted", craftZip([json(label("encrypted")), { name: "assets/e.png", content: hello, flags: 0x0801 }]), INVALID],
    ["bzip2", craftZip([json(label("bzip2")), { name: "assets/b.png", content: hello, method: 12, data: hello }]), INVALID],
    ["overlapping", craftZip([
      json(label("overlap")),
      { name: outerName, content: storedLocalRecord("assets/inner.png", hello) },
      {
        name: "assets/inner.png",
        content: hello,
        localOffset: 30 + 11 + backupJson(label("overlap")).length + 30 + outerName.length,
      },
    ]), INVALID],
    ["declared-too-small", craftZip([json(label("lie")), { name: "assets/l.png", content: hello, method: DEFLATED, size: 1000 }]), INVALID],
    ["checksum", craftZip([json(label("crc")), { name: "assets/crc-secret.png", content: hello, method: DEFLATED, crc: crc32(hello) ^ 1 }]), INVALID],
    ["legacy-json-as-zip", backupJson(label("legacy")), INVALID],
    ["declared-entry", craftZip([json(label("declared")), { name: "assets/d.png", content: hello, method: DEFLATED, size: 600 * MiB }]), TOO_LARGE],
    ["declared-total", craftZip([
      json(label("total")),
      ...[0, 1, 2].map((i) => ({ name: `assets/t${i}.png`, content: hello, method: DEFLATED, size: 400 * MiB })),
    ]), TOO_LARGE],
    ["many-entries", craftZip([
      json(label("many")),
      ...Array.from({ length: 20_000 }, (_, i) => ({ name: `junk/${i}.txt`, content: Buffer.from("x") })),
    ]), TOO_LARGE],
    ["implied-folders", craftZip([
      json(label("folders")),
      ...Array.from({ length: 3_400 }, (_, i) => ({ name: `f${i}/a/b/x`, content: Buffer.from("x") })),
    ]), TOO_LARGE],
    // About 120 KB: one name nested 30,000 levels deep.
    ["deep-name", craftZip([
      json(label("deep")),
      { name: `assets/${"d/".repeat(30_000)}deep-secret.png`, content: hello },
    ]), TOO_LARGE],
    // 520 MiB of real zeros, honestly declared, in about 0.5 MB.
    ["honest-huge", craftZip([
      json(label("huge")),
      {
        name: "assets/huge.bin",
        method: DEFLATED,
        data: await deflateZeros(huge),
        size: huge,
        crc: crc32ZeroPadded(Buffer.alloc(0), huge),
      },
    ]), TOO_LARGE],
  ];

  const manifest = [];
  for (const [name, zip, , actions = ["preview", "restore"]] of cases) {
    const file = path.join(casesDir, `${name}.zip`);
    await writeFile(file, zip);
    manifest.push({ label: name, file, actions });
  }
  const before = await tree();
  const { code, signal, stderr, lines } = await runChild(manifest);
  assert.notEqual(code, 90, "could not set the data-segment limit");
  const results = new Map(lines.map((line) => [`${line.label} ${line.action}`, line]));
  t.diagnostic(`child exit: ${code ?? signal}; ${lines.length} responses`);
  for (const line of lines)
    t.diagnostic(`${line.label} ${line.action}: ${line.statusCode} ${line.maxRssMiB} MiB`);
  if (code !== 0) t.diagnostic(`child stderr: ${stderr.slice(-300).replace(/\s+/g, " ")}`);

  for (const [name, , expected, actions = ["preview", "restore"]] of cases) {
    for (const action of actions) {
      const result = results.get(`${name} ${action}`);
      assert.ok(
        result,
        `${name} ${action}: no response; child exited ${code ?? signal}: ${stderr.slice(-400)}`,
      );
      if (expected === null) {
        assert.equal(result.statusCode, 200, `${name} ${action}: ${JSON.stringify(result.body)}`);
        continue;
      }
      assert.equal(result.statusCode, 400, `${name} ${action}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.message, expected, `${name} ${action}`);
      assert.ok(!JSON.stringify(result.body).includes("secret"), `${name} ${action}`);
    }
  }
  assert.equal(code, 0, stderr.slice(-400));
  assert.equal(results.get("legit preview").body.data.images, 2);
  assert.equal(results.get("at-limits preview").body.data.images, 10_000 - 16);
  // The 520 MiB entry was refused without being inflated.
  const rssGrowth =
    results.get("honest-huge restore").maxRssMiB - results.get("deep-name restore").maxRssMiB;
  assert.ok(rssGrowth < 128, `${rssGrowth} MiB`);

  // Only the legitimate restore wrote files, all under imports/, byte for byte.
  const now = await tree();
  for (const [rel, digest] of before) assert.equal(now.get(rel), digest, rel);
  const added = [...now.keys()].filter((rel) => !before.has(rel));
  assert.equal(added.length, 2);
  for (const rel of added)
    assert.equal(path.dirname(rel), path.join("storage", workspace.id, "uploads", "wiki", "imports"));
  assert.deepEqual(
    added.map((rel) => now.get(rel)).sort(),
    Object.values(legitAssets).map(sha256).sort(),
  );
  const spaces = await prisma.wikiSpace.findMany({
    where: { workspaceId: workspace.id },
    select: { name: true },
  });
  assert.deepEqual(spaces.map((space) => space.name), [label("legit")]);
});
