import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { LocalStorageProvider } from "../src/services/storage.ts";

test("buffer and streaming writes cannot escape storage root", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "werkyn-storage-test-"));
  try {
    const storage = new LocalStorageProvider(path.join(temp, "storage"));
    for (const components of [
      ["../escaped", "scope", "file", ".txt"],
      ["files", "../../escaped", "file", ".txt"],
      ["files", "scope", "../../../escaped/file", ".txt"],
      ["files", "scope", "file", "/../../../../escaped/file"],
      ["../storage-sibling", "scope", "file", ".txt"],
    ]) {
      await assert.rejects(storage.save(...components, Buffer.from("private")), /Path traversal/);
      await assert.rejects(
        storage.saveStream(...components, Readable.from(["private"])), /Path traversal/,
      );
    }
    await assert.rejects(access(path.join(temp, "escaped")), { code: "ENOENT" });
    await assert.rejects(access(path.join(temp, "storage-sibling")), { code: "ENOENT" });
    await assert.rejects(access(path.join(temp, "storage")), { code: "ENOENT" });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("buffer and streaming writes retain nested storage paths and contents", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "werkyn-storage-test-"));
  try {
    const storage = new LocalStorageProvider(temp);
    const saved = await storage.save("workspace/uploads", "wiki/space", "image", ".txt", Buffer.from("buffer"));
    assert.equal((await storage.read(saved)).toString(), "buffer");
    const streamed = await storage.saveStream("files", "workspace/2026/10", "file", ".txt", Readable.from([Buffer.from("stream")]));
    assert.equal(streamed.size, 6);
    assert.equal(await readFile(path.join(temp, streamed.storagePath), "utf8"), "stream");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

/** saveStream's result, or a failure if it has not settled within `ms`. */
function settled(promise, ms = 2000) {
  return Promise.race([
    promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`saveStream did not settle within ${ms} ms`)), ms)),
  ]);
}

async function storedFiles(dir) {
  const { readdir } = await import("node:fs/promises");
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await storedFiles(full)));
    else found.push(full);
  }
  return found;
}

test("a stream that fails, ends early or was already destroyed is refused and leaves no file", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "werkyn-storage-test-"));
  try {
    const storage = new LocalStorageProvider(temp);
    const cases = {
      // Fails before the file has been opened.
      "fails at once": () =>
        new Readable({
          read() {
            process.nextTick(() => this.destroy(new Error("client went away")));
          },
        }),
      // Fails after some bytes have been written.
      "fails midway": () => {
        let sent = 0;
        return new Readable({
          read() {
            if (sent++ < 4) this.push(Buffer.alloc(64 * 1024, 1));
            else setTimeout(() => this.destroy(new Error("client went away")), 20);
          },
        });
      },
      // Closed without an error and without ending, as the multipart parser
      // does to a file when its request is aborted.
      "closes without ending": () => {
        let sent = 0;
        return new Readable({
          read() {
            if (sent++ < 4) this.push(Buffer.alloc(64 * 1024, 1));
            else setTimeout(() => this.destroy(), 20);
          },
        });
      },
      // Destroyed before saveStream was called.
      "already destroyed": () => {
        const stream = new Readable({ read() {} });
        stream.push(Buffer.alloc(1024, 1));
        stream.destroy();
        return stream;
      },
      "over maxSize": () => Readable.from([Buffer.alloc(600, 1), Buffer.alloc(600, 1)]),
    };
    for (const [label, source] of Object.entries(cases)) {
      const result = await settled(
        storage.saveStream("files", "scope", label.replaceAll(" ", "-"), ".bin", source(), { maxSize: 1000 }),
      );
      assert.ok(result.error, `${label}: resolved ${JSON.stringify(result.value)}`);
      // Give a file opened late the chance to appear.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(await storedFiles(temp), [], label);
      // The folders this write created are removed too.
      const { readdir } = await import("node:fs/promises");
      assert.deepEqual(await readdir(temp), [], label);
    }

    // Folders that already existed, or that another write still uses, stay.
    await storage.save("files", "scope", "kept", ".bin", Buffer.from("kept"));
    const failed = await settled(
      storage.saveStream("files", "scope/new", "x", ".bin", cases["fails midway"](), { maxSize: 1000 }),
    );
    assert.ok(failed.error);
    assert.deepEqual(
      (await storedFiles(temp)).map((file) => path.relative(temp, file)),
      [path.join("files", "scope", "kept.bin")],
    );
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(path.join(temp, "files", "scope")), ["kept.bin"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("a failed write never removes a folder that a concurrent write into it needs", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "werkyn-storage-test-"));
  try {
    const storage = new LocalStorageProvider(temp);
    const { readdir } = await import("node:fs/promises");
    for (let round = 0; round < 200; round++) {
      const scope = `round-${round}/nested`;
      // Both start into the same new folders; one fails as soon as it opens.
      const [failed, saved] = await Promise.allSettled([
        storage.saveStream("files", scope, "fails", ".bin",
          new Readable({ read() { this.destroy(new Error("client went away")); } })),
        storage.saveStream("files", scope, "kept", ".bin", Readable.from([Buffer.from(`round ${round}`)])),
      ]);
      assert.equal(failed.status, "rejected", `round ${round}`);
      assert.equal(saved.status, "fulfilled", `round ${round}: ${saved.reason?.message}`);
      assert.equal(await readFile(path.join(temp, saved.value.storagePath), "utf8"), `round ${round}`);
      assert.deepEqual(await readdir(path.join(temp, "files", scope)), ["kept.bin"]);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
