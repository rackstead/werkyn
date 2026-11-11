import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");
}
const testURL = new URL(process.env.TEST_DATABASE_URL);
const testDatabase = decodeURIComponent(testURL.pathname.slice(1));
assert.equal(testDatabase === "werkyn_ci" || testDatabase.startsWith("werkyn_audit_"), true, testDatabase);
assert.equal(["127.0.0.1", "localhost", "[::1]"].includes(testURL.hostname), true);
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-upload-crash-"));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "upload-crash-blob-queue-jwt-secret",
  COOKIE_SECRET: "upload-crash-blob-queue-cookie-secret",
  STORAGE_DIR: storageDir,
});

const { PrismaClient } = await import("@prisma/client");
const { LocalStorageProvider } = await import("../../src/services/storage.ts");
const { uploadFileStream } = await import("../../src/modules/files/files.service.ts");
const { processBlobCleanup } = await import("../../src/services/blob-cleanup.ts");

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMwTjuDFTEMLQkAuYZZQQ0kCIcAAAAASUVORK5CYII=",
  "base64",
);
const observerUrl = new URL(process.env.TEST_DATABASE_URL);
observerUrl.searchParams.set("connection_limit", "2");
const prisma = new PrismaClient();
const observer = new PrismaClient({ datasourceUrl: observerUrl.toString() });
const storage = new LocalStorageProvider(storageDir);
let user;
let workspace;

function holdFileCreate(tx, onCreate) {
  return new Proxy(tx, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "file") return typeof value === "function" ? value.bind(target) : value;
      return new Proxy(value, {
        get(fileTarget, fileProp) {
          const method = Reflect.get(fileTarget, fileProp, fileTarget);
          if (fileProp !== "create") {
            return typeof method === "function" ? method.bind(fileTarget) : method;
          }
          return (args) => onCreate(args, method.bind(fileTarget));
        },
      });
    },
  });
}

async function stageRow(storagePath) {
  const rows = await observer.$queryRaw`
    SELECT "attempts", "lastError",
      ((EXTRACT(EPOCH FROM ("availableAt" - "createdAt"))) * 1000)::double precision AS "graceMs"
    FROM "BlobCleanup" WHERE "storagePath" = ${storagePath}`;
  assert.equal(rows.length <= 1, true);
  return rows[0] ?? null;
}

async function exercise({ fileName, mimeType, bytes, fail }) {
  const originalTransaction = prisma.$transaction.bind(prisma);
  const originalDelete = storage.delete.bind(storage);
  const deletes = [];
  let releaseHold = () => {};
  const hold = new Promise((resolve) => {
    releaseHold = resolve;
  });
  let notifyCreate = () => {};
  const atCreate = new Promise((resolve) => {
    notifyCreate = resolve;
  });
  storage.delete = async (storagePath) => {
    deletes.push(storagePath);
    return originalDelete(storagePath);
  };
  prisma.$transaction = (fn, options) => {
    if (typeof fn !== "function") return originalTransaction(fn, options);
    return originalTransaction(async (tx) => fn(holdFileCreate(tx, async (args, create) => {
      notifyCreate(args.data);
      await hold;
      if (fail) throw new Error("forced upload create failure");
      return create(args);
    })), options);
  };

  const pending = uploadFileStream(
    prisma,
    storage,
    workspace.id,
    user.id,
    undefined,
    fileName,
    mimeType,
    Readable.from([bytes]),
    { workspaceId: workspace.id, userId: user.id, workspaceRole: "ADMIN" },
  ).then(
    (file) => ({ ok: true, file }),
    (error) => ({ ok: false, error }),
  );
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseHold();
  };
  let timeout;
  try {
    const winner = await Promise.race([
      atCreate.then((data) => ({ kind: "held", data })),
      pending.then((result) => ({ kind: "settled", result })),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), 60_000);
      }),
    ]);
    clearTimeout(timeout);
    if (winner.kind !== "held") {
      throw new Error(`upload did not pause before file.create (${winner.kind})`);
    }
    const data = winner.data;
    const paths = [data.storagePath, data.thumbnailPath].filter(Boolean);
    let lockHeld = false;
    try {
      await observer.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspace.id} FOR NO KEY UPDATE NOWAIT`;
    } catch (error) {
      if (error?.code === "P2010" && error?.meta?.code === "55P03") lockHeld = true;
      else throw error;
    }
    const during = [];
    for (const storagePath of paths) {
      const onDisk = await storage.exists(storagePath);
      const body = onDisk ? await storage.read(storagePath) : Buffer.alloc(0);
      during.push({
        storagePath,
        row: await stageRow(storagePath),
        onDisk,
        sameBytes: storagePath === data.storagePath && body.equals(bytes),
        byteLength: body.length,
      });
    }
    const filesDuring = await observer.file.count({
      where: {
        workspaceId: workspace.id,
        OR: [{ storagePath: { in: paths } }, { thumbnailPath: { in: paths } }],
      },
    });
    release();
    const settled = await pending;
    const after = [];
    for (const storagePath of paths) {
      after.push({
        storagePath,
        row: await stageRow(storagePath),
        onDisk: await storage.exists(storagePath),
      });
    }
    const filesAfter = await prisma.file.findMany({
      where: { workspaceId: workspace.id, storagePath: data.storagePath },
    });
    let keptBytes = null;
    if (settled.ok) keptBytes = await storage.read(settled.file.storagePath);
    return { data, paths, during, after, filesDuring, filesAfter, settled, deletes, lockHeld, keptBytes };
  } finally {
    clearTimeout(timeout);
    release();
    await pending;
    prisma.$transaction = originalTransaction;
    storage.delete = originalDelete;
  }
}

function assertWindow(result, bytes) {
  assert.equal(result.lockHeld, true, "create transaction still holds the workspace lock");
  assert.equal(result.filesDuring, 0);
  assert.equal(result.during.length, result.paths.length);
  assert.ok(result.paths.includes(result.data.storagePath));
  for (const entry of result.during) {
    assert.equal(entry.onDisk, true, entry.storagePath);
    assert.ok(entry.row, entry.storagePath);
    assert.equal(entry.row.attempts, 0);
    assert.equal(entry.row.lastError, null);
    assert.equal(entry.row.graceMs, 3_600_000);
    assert.equal(entry.byteLength > 0, true);
  }
  const main = result.during.find((entry) => entry.storagePath === result.data.storagePath);
  assert.equal(main.sameBytes, true);
  assert.equal(main.byteLength, bytes.length);
}

function assertCommitted(result, bytes) {
  assertWindow(result, bytes);
  assert.equal(result.settled.ok, true);
  assert.equal(result.filesAfter.length, 1);
  assert.equal(result.filesAfter[0].id, result.settled.file.id);
  assert.equal(result.deletes.length, 0);
  assert.ok(result.keptBytes.equals(bytes));
  for (const entry of result.after) {
    assert.equal(entry.row, null, entry.storagePath);
    assert.equal(entry.onDisk, true, entry.storagePath);
  }
  if (result.data.thumbnailPath) {
    assert.equal(result.paths.includes(result.data.thumbnailPath), true);
    assert.equal(result.data.thumbnailPath.endsWith("_thumb.webp"), true);
  }
}

function assertRolledBack(result, bytes) {
  assertWindow(result, bytes);
  assert.equal(result.settled.ok, false);
  assert.match(String(result.settled.error?.message ?? result.settled.error), /forced upload create failure/);
  assert.equal(result.filesAfter.length, 0);
  for (const entry of result.after) {
    assert.equal(entry.row, null, entry.storagePath);
    assert.equal(entry.onDisk, false, entry.storagePath);
  }
}

before(async () => {
  await prisma.$connect();
  await observer.$connect();
  await storage.init();
  const suffix = crypto.randomBytes(4).toString("hex");
  user = await prisma.user.create({
    data: { email: `upload-crash-${suffix}@example.test`, displayName: "Upload crash", emailVerified: true },
  });
  workspace = await prisma.workspace.create({
    data: {
      name: "Upload crash",
      slug: `uplcrash-${suffix}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
});

after(async () => {
  try {
    if (workspace) {
      await prisma.workspace.deleteMany({ where: { id: workspace.id } });
      await prisma.blobCleanup.deleteMany({ where: { storagePath: { startsWith: `${workspace.id}/` } } });
    }
    if (user) await prisma.user.deleteMany({ where: { id: user.id } });
  } finally {
    await observer.$disconnect();
    await prisma.$disconnect();
    await rm(storageDir, { recursive: true, force: true });
  }
});

describe("upload crash blob queue", { concurrency: false }, () => {
test("a held create sees the queued blob, then commit keeps the bytes and drops the row", { timeout: 120_000 }, async () => {
  const bytes = Buffer.from("upload crash window fixture\n");
  const result = await exercise({ fileName: "notes.txt", mimeType: "text/plain", bytes, fail: false });
  assertCommitted(result, bytes);
  assert.equal(result.data.thumbnailPath, null);
  assert.equal(result.paths.length, 1);
});

test("a forced failure after the write leaves no file and no bytes", { timeout: 120_000 }, async () => {
  const bytes = Buffer.from("upload crash window failure\n");
  const result = await exercise({ fileName: "notes.txt", mimeType: "text/plain", bytes, fail: true });
  assertRolledBack(result, bytes);
  assert.equal(result.paths.length, 1);
});

test("a thumbnail queued before it is written is kept with the file and cleared from the queue", { timeout: 120_000 }, async () => {
  const saved = await exercise({ fileName: "dot.png", mimeType: "image/png", bytes: png, fail: false });
  assert.ok(saved.data.thumbnailPath);
  assert.equal(saved.paths.length, 2);
  assertCommitted(saved, png);
  const failed = await exercise({ fileName: "dot.png", mimeType: "image/png", bytes: png, fail: true });
  assert.equal(failed.paths.length, 2);
  assert.ok(failed.data.thumbnailPath);
  assertRolledBack(failed, png);
});

test("a late write keeps its cleanup row when a worker already owns the claim", { timeout: 30_000 }, async () => {
  const bytes = Buffer.from("late upload write\n");
  const originalSave = storage.saveStream.bind(storage);
  const originalDeleteMany = prisma.blobCleanup.deleteMany.bind(prisma.blobCleanup);
  let releaseDelete = () => {};
  const gate = new Promise((resolve) => {
    releaseDelete = resolve;
  });
  let noteDelete = () => {};
  const deleteReached = new Promise((resolve) => {
    noteDelete = resolve;
  });
  let held = false;
  let planned;
  let worker;
  prisma.blobCleanup.deleteMany = async (args) => {
    if (!held) {
      held = true;
      noteDelete();
      await gate;
    }
    return originalDeleteMany(args);
  };
  storage.saveStream = async (...args) => {
    planned = path.join(args[0], args[1], `${args[2]}${args[3]}`);
    await prisma.$executeRaw`
      UPDATE "BlobCleanup" SET "availableAt" = CURRENT_TIMESTAMP - interval '1 second'
      WHERE "storagePath" = ${planned}`;
    worker = processBlobCleanup(prisma, storage, { paths: [planned], limit: 1 });
    worker.catch(() => {});
    let waitTimer;
    try {
      await Promise.race([
        deleteReached,
        new Promise((_, reject) => {
          waitTimer = setTimeout(() => reject(new Error("worker did not reach row delete")), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(waitTimer);
    }
    return originalSave(...args);
  };
  try {
    const pending = uploadFileStream(
      prisma,
      storage,
      workspace.id,
      user.id,
      undefined,
      "late.txt",
      "text/plain",
      Readable.from([bytes]),
      { workspaceId: workspace.id, userId: user.id, workspaceRole: "ADMIN" },
    ).then(
      (file) => ({ ok: true, file }),
      (error) => ({ ok: false, error }),
    );
    let settleTimer;
    const settled = await Promise.race([
      pending,
      new Promise((resolve) => {
        settleTimer = setTimeout(() => resolve({ ok: false, error: new Error("late write did not settle") }), 15_000);
      }),
    ]);
    clearTimeout(settleTimer);
    const claimed = await observer.blobCleanup.findUnique({ where: { storagePath: planned } });
    assert.equal(settled.ok, false);
    assert.equal(settled.error.statusCode, 503);
    assert.equal(await prisma.file.count({ where: { storagePath: planned } }), 0);
    assert.equal(await storage.exists(planned), true);
    assert.equal(Buffer.from(await storage.read(planned)).equals(bytes), true);
    assert.equal(claimed?.attempts, 1);
    const renewedAt = claimed.availableAt;
    releaseDelete();
    const sweep = await worker;
    const afterWorker = await observer.blobCleanup.findUnique({ where: { storagePath: planned } });
    assert.equal(sweep.claimed, 1);
    assert.equal(sweep.deleted, 1);
    assert.equal(afterWorker?.attempts, 1);
    assert.equal(afterWorker.availableAt.getTime(), renewedAt.getTime());
    assert.equal(await storage.exists(planned), true);
  } finally {
    releaseDelete();
    if (worker) await worker.catch(() => {});
    prisma.blobCleanup.deleteMany = originalDeleteMany;
    storage.saveStream = originalSave;
  }
});
});

