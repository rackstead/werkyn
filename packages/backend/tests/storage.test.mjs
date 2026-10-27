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
