import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";

// A listening Unix socket at a Drive blob path must be the same 403 a FIFO
// or a directory already is. A missing path stays 410 on the Drive read and
// 404 where that error is reported as not found. An ENXIO that is not this
// open stays 500.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:1/unit_test";
process.env.JWT_SECRET ??= "storage-socket-unit-jwt-secret";
process.env.COOKIE_SECRET ??= "storage-socket-unit-cookie-secret";
process.env.LOG_LEVEL = "error";

const { default: errors } = await import("../src/plugins/errors.ts");
const { LocalStorageProvider, MissingBlobError } = await import("../src/services/storage.ts");
const { NotFoundError } = await import("../src/utils/errors.ts");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = path.join(repoRoot, "t", "http");
after(() => fs.rm(scratch, { recursive: true, force: true }));

async function layout(name) {
  const root = path.join(scratch, name, "r");
  const dir = path.join(root, "a/b");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "file.bin"), "own bytes");
  execFileSync("mkfifo", [path.join(dir, "pipe")]);
  await fs.mkdir(path.join(dir, "folder"));
  const socketPath = path.join(dir, "sock");
  assert.ok(Buffer.byteLength(socketPath) < 107, `socket path is too long: ${socketPath}`);
  const listener = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(socketPath, () => resolve());
    });
  } catch (error) {
    await fs.rm(path.join(scratch, name), { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    close: () => new Promise((resolve) => listener.close(resolve)),
  };
}

async function app(root, procFd) {
  const storage = new LocalStorageProvider(root, { procFd, log: { warn() {}, info() {} } });
  await storage.init();
  const server = Fastify({ logger: false });
  await server.register(errors);
  const open = (relative) => storage.openReadStream(relative);
  // Drive, attachments and share links let a missing blob stay 410.
  server.get("/drive", async (request, reply) => {
    const relative = request.query.path;
    return reply.send(await open(relative));
  });
  // Uploaded media and /storage/:ws/uploads/* turn that same miss into 404.
  server.get("/uploads", async (request, reply) => {
    const relative = request.query.path;
    try {
      return reply.send(await open(relative));
    } catch (error) {
      if (error instanceof MissingBlobError) throw new NotFoundError("File not found");
      throw error;
    }
  });
  server.get("/other-enxio", async () => {
    const error = new Error("device missing");
    error.code = "ENXIO";
    throw error;
  });
  await server.ready();
  return server;
}

function read(server, route, relative) {
  const url = relative ? `${route}?path=${encodeURIComponent(relative)}` : route;
  return server.inject({ method: "GET", url });
}

for (const proc of [true, false]) {
  const mode = proc ? "descriptor" : "path";
  test(`${mode}: socket, FIFO and directory at a blob path are 403`, async () => {
    const planted = await layout(mode);
    const server = await app(planted.root, proc);
    try {
      for (const route of ["/drive", "/uploads"]) {
        const socket = await read(server, route, "a/b/sock");
        assert.equal(socket.statusCode, 403, `${route} socket: ${socket.body}`);
        assert.equal(socket.json().message, "Stored file is not accessible");
        const fifo = await read(server, route, "a/b/pipe");
        assert.equal(fifo.statusCode, 403, `${route} fifo: ${fifo.body}`);
        const folder = await read(server, route, "a/b/folder");
        assert.equal(folder.statusCode, 403, `${route} folder: ${folder.body}`);
        const file = await read(server, route, "a/b/file.bin");
        assert.equal(file.statusCode, 200, `${route} file: ${file.body}`);
        assert.equal(file.body, "own bytes");
      }
      const missingDrive = await read(server, "/drive", "a/b/absent.bin");
      assert.equal(missingDrive.statusCode, 410, missingDrive.body);
      const missingUploads = await read(server, "/uploads", "a/b/absent.bin");
      assert.equal(missingUploads.statusCode, 404, missingUploads.body);
      const other = await read(server, "/other-enxio");
      assert.equal(other.statusCode, 500, other.body);
      assert.notEqual(other.json().message, "Stored file is not accessible");
    } finally {
      await server.close();
      await planted.close();
    }
  });
}
