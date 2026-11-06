import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fss from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import {
  StorageRefusedError,
  StorageRoot,
  findStorageLinks,
} from "../src/services/storage-paths.ts";
import { LocalStorageProvider, MissingBlobError } from "../src/services/storage.ts";

// R33: below the storage root no symbolic link is followed, by any read,
// write or delete. Each case runs with /proc/self/fd (Linux, how the server
// runs) and with the path-based fallback used where /proc is missing.
const PROC = fss.existsSync("/proc/self/fd");
const MODES = PROC ? [true, false] : [false];
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "werkyn-storage-paths-"));
after(() => fs.rm(scratch, { recursive: true, force: true }));
const SECRET = "outside secret: must never be read, written or removed";

let fixtures = 0;
/**
 * root/        (the storage root)
 *   wsA/files/u1/own.txt          a member's blob
 *   wsB/files/u2/foreign.txt      another workspace's blob
 * outside/secret.txt              a file outside the root
 */
async function fixture() {
  const base = path.join(scratch, `case-${++fixtures}`);
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  await fs.mkdir(path.join(root, "wsA/files/u1"), { recursive: true });
  await fs.mkdir(path.join(root, "wsB/files/u2"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, "wsA/files/u1/own.txt"), "own bytes");
  await fs.writeFile(path.join(root, "wsB/files/u2/foreign.txt"), "foreign bytes");
  await fs.writeFile(path.join(outside, "secret.txt"), SECRET);
  return { base, root, outside, at: (relative) => path.join(root, relative) };
}

/** Every entry below `dir` with its type and (for files) contents. */
async function snapshot(dir) {
  const entries = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const stat = await fs.lstat(full);
    entries[path.relative(dir, full)] = stat.isSymbolicLink()
      ? `link -> ${await fs.readlink(full)}`
      : stat.isFile() ? await fs.readFile(full, "utf8") : "dir";
  }
  return entries;
}

const refused = (reason = "symbolic-link") => (error) => {
  assert.ok(error instanceof StorageRefusedError, `expected a refusal, got ${error?.code ?? error}`);
  assert.equal(error.reason, reason);
  assert.equal(error.statusCode, 403);
  return true;
};

/** Plant each kind of link a hostile process could leave below the root. */
const PLANTED = {
  "leaf links outside the root": async (f) =>
    fs.symlink(path.join(f.outside, "secret.txt"), f.at("wsA/files/u1/target.txt")),
  "leaf links to another workspace": async (f) =>
    fs.symlink(f.at("wsB/files/u2/foreign.txt"), f.at("wsA/files/u1/target.txt")),
  "leaf link is relative": async (f) =>
    fs.symlink("../../../wsB/files/u2/foreign.txt", f.at("wsA/files/u1/target.txt")),
  "leaf link is dangling": async (f) =>
    fs.symlink(path.join(f.outside, "missing.txt"), f.at("wsA/files/u1/target.txt")),
  "parent folder links outside the root": async (f) => {
    await fs.writeFile(path.join(f.outside, "target.txt"), SECRET);
    await fs.rm(f.at("wsA/files/u1"), { recursive: true });
    await fs.symlink(f.outside, f.at("wsA/files/u1"));
  },
  "parent folder links to another workspace": async (f) => {
    await fs.writeFile(f.at("wsB/files/u2/target.txt"), "foreign bytes");
    await fs.rm(f.at("wsA/files/u1"), { recursive: true });
    await fs.symlink(f.at("wsB/files/u2"), f.at("wsA/files/u1"));
  },
  "workspace folder is a link": async (f) => {
    await fs.mkdir(path.join(f.outside, "files/u1"), { recursive: true });
    await fs.writeFile(path.join(f.outside, "files/u1/target.txt"), SECRET);
    await fs.rm(f.at("wsA"), { recursive: true });
    await fs.symlink(f.outside, f.at("wsA"));
  },
};

for (const proc of MODES) {
  const mode = proc ? "/proc/self/fd" : "path fallback";

  test(`${mode}: regular files below the root are read, written and removed`, async () => {
    const f = await fixture();
    const root = new StorageRoot(f.root, { procFd: proc });
    const opened = await root.openFile("wsA/files/u1/own.txt");
    try {
      assert.equal((await opened.handle.readFile()).toString(), "own bytes");
      assert.equal(opened.procPath !== undefined, proc);
    } finally {
      await opened.handle.close();
    }
    const created = await root.createFile("wsA/files/new/deeper/blob.bin");
    await created.handle.writeFile("new bytes");
    await created.handle.close();
    assert.equal(created.createdFrom, 2, "wsA/files/new and below were made");
    assert.equal(await fs.readFile(f.at("wsA/files/new/deeper/blob.bin"), "utf8"), "new bytes");
    assert.equal(await root.exists("wsA/files/new/deeper/blob.bin"), true);
    assert.equal(await root.unlink("wsA/files/new/deeper/blob.bin"), "removed");
    assert.equal(await root.unlink("wsA/files/new/deeper/blob.bin"), "missing");
    assert.equal(await root.exists("wsA/files/new/deeper/blob.bin"), false);
    await assert.rejects(root.openFile("wsA/files/u1/absent.txt"), { code: "ENOENT" });
    await assert.rejects(root.openFile("wsA/files/absent/x.txt"), { code: "ENOENT" });
    // A file where a folder is expected is missing, not a refusal.
    await assert.rejects(root.openFile("wsA/files/u1/own.txt/x"), { code: "ENOTDIR" });
    for (const escape of ["../outside/secret.txt", "wsA/../../outside/secret.txt", "/etc/passwd", "", "."]) {
      await assert.rejects(root.openFile(escape), /Path traversal detected/);
      await assert.rejects(root.createFile(escape), /Path traversal detected/);
      await assert.rejects(root.unlink(escape), /Path traversal detected/);
    }
  });

  for (const [label, plant] of Object.entries(PLANTED)) {
    test(`${mode}: ${label}: reads, writes and deletes refuse it`, async () => {
      const f = await fixture();
      await plant(f);
      const before = { outside: await snapshot(f.outside), foreign: await snapshot(f.at("wsB")) };
      const root = new StorageRoot(f.root, { procFd: proc });
      await assert.rejects(root.openFile("wsA/files/u1/target.txt"), refused());
      await assert.rejects(root.exists("wsA/files/u1/target.txt"), refused());
      // A new file is never created through a link, whether it names the
      // link itself or a new file below a linked folder.
      await assert.rejects(root.createFile("wsA/files/u1/target.txt"), refused());
      if (label.startsWith("parent") || label.startsWith("workspace")) {
        await assert.rejects(root.createFile("wsA/files/u1/fresh.txt"), refused());
        await assert.rejects(root.createFile("wsA/files/u1/new/fresh.txt"), refused());
        await assert.rejects(root.unlink("wsA/files/u1/target.txt"), refused());
      } else {
        // A link at the blob's own path is removed itself; its target stays.
        assert.equal(await root.unlink("wsA/files/u1/target.txt"), "link-removed");
        await assert.rejects(fs.lstat(f.at("wsA/files/u1/target.txt")), { code: "ENOENT" });
      }
      assert.deepEqual(await snapshot(f.outside), before.outside, "nothing outside the root changed");
      assert.deepEqual(await snapshot(f.at("wsB")), before.foreign, "the other workspace did not change");
    });
  }

  test(`${mode}: a link where a missing folder would be made is refused, not followed`, async () => {
    const f = await fixture();
    await fs.symlink(f.outside, f.at("wsA/files/made"));
    const root = new StorageRoot(f.root, { procFd: proc });
    await assert.rejects(root.createFile("wsA/files/made/deeper/x.bin"), refused());
    assert.deepEqual(await fs.readdir(f.outside), ["secret.txt"], "no folder was made outside");
  });

  test(`${mode}: FIFOs, sockets and folders are refused without blocking`, async () => {
    const f = await fixture();
    execFileSync("mkfifo", [f.at("wsA/files/u1/pipe.bin")]);
    await fs.mkdir(f.at("wsA/files/u1/folder.bin"));
    const root = new StorageRoot(f.root, { procFd: proc });
    const started = performance.now();
    await assert.rejects(root.openFile("wsA/files/u1/pipe.bin"), refused("not-a-file"));
    assert.ok(performance.now() - started < 1000, "opening the FIFO did not wait for a writer");
    await assert.rejects(root.exists("wsA/files/u1/pipe.bin"), refused("not-a-file"));
    await assert.rejects(root.openFile("wsA/files/u1/folder.bin"), refused("not-a-file"));
    await assert.rejects(root.unlink("wsA/files/u1/folder.bin"), refused("not-a-file"));
    assert.ok((await fs.stat(f.at("wsA/files/u1/folder.bin"))).isDirectory());
  });

  test(`${mode}: a hard link is an ordinary entry and an existing name is never overwritten`, async () => {
    const f = await fixture();
    // Hard links are allowed (docs/remediation/r33-storage-symlinks.md):
    // backup tools such as rsync --link-dest share inodes with live storage.
    await fs.link(f.at("wsA/files/u1/own.txt"), f.at("wsA/files/u1/hard.txt"));
    const root = new StorageRoot(f.root, { procFd: proc });
    const opened = await root.openFile("wsA/files/u1/hard.txt");
    assert.equal((await opened.handle.readFile()).toString(), "own bytes");
    await opened.handle.close();
    // Writes create new files only, so a write cannot reach a shared inode.
    await assert.rejects(root.createFile("wsA/files/u1/hard.txt"), { code: "EEXIST" });
    assert.equal(await root.unlink("wsA/files/u1/hard.txt"), "removed");
    assert.equal(await fs.readFile(f.at("wsA/files/u1/own.txt"), "utf8"), "own bytes");
  });
}

test("the storage root itself may be a link or reached through one", async () => {
  const f = await fixture();
  const linkedRoot = path.join(f.base, "linked-root");
  await fs.symlink(f.root, linkedRoot);
  const storage = new LocalStorageProvider(linkedRoot, { log: { warn() {}, info() {} } });
  assert.equal(await storage.init(), await fs.realpath(f.root));
  assert.equal(storage.rootPath, await fs.realpath(f.root));
  assert.equal(await storage.accessMode(), PROC ? "descriptor" : "path");
  assert.equal(await new StorageRoot(f.root, { procFd: false }).accessMode(), "path");
  assert.equal((await storage.read("wsA/files/u1/own.txt")).toString(), "own bytes");
  const saved = await storage.save("wsA/uploads", "wiki/space", "image", ".bin", Buffer.from("linked"));
  assert.equal(await fs.readFile(path.join(f.root, saved), "utf8"), "linked");
  await storage.delete(saved);
  await assert.rejects(fs.access(path.join(f.root, saved)), { code: "ENOENT" });
  // A missing root is created at startup, then resolved.
  const fresh = new LocalStorageProvider(path.join(f.base, "made/at/startup"), { log: { warn() {}, info() {} } });
  assert.equal(await fresh.init(), await fs.realpath(path.join(f.base, "made/at/startup")));
});

test("the provider logs each refusal and answers missing blobs as before", async () => {
  const f = await fixture();
  await fs.symlink(path.join(f.outside, "secret.txt"), f.at("wsA/files/u1/link.txt"));
  const warned = [];
  const storage = new LocalStorageProvider(f.root, { log: { warn: (...args) => warned.push(args), info() {} } });
  await assert.rejects(storage.openReadStream("wsA/files/u1/link.txt"), refused());
  await assert.rejects(storage.read("wsA/files/u1/link.txt"), refused());
  await assert.rejects(storage.open("wsA/files/u1/link.txt"), refused());
  await assert.rejects(storage.exists("wsA/files/u1/link.txt"), refused());
  await assert.rejects(
    storage.saveStream("wsA/files/u1", "", "link", ".txt", Readable.from(["x"])),
    refused(),
  );
  const chunks = [];
  await assert.rejects(
    (async () => { for await (const chunk of storage.readStream("wsA/files/u1/link.txt")) chunks.push(chunk); })(),
    refused(),
  );
  assert.deepEqual(chunks, []);
  assert.deepEqual(
    warned.map(([fields]) => [fields.storagePath, fields.reason, fields.operation]),
    [
      ["wsA/files/u1/link.txt", "symbolic-link", "read"],
      ["wsA/files/u1/link.txt", "symbolic-link", "read"],
      ["wsA/files/u1/link.txt", "symbolic-link", "read"],
      ["wsA/files/u1/link.txt", "symbolic-link", "exists"],
      ["wsA/files/u1/link.txt", "symbolic-link", "write"],
      ["wsA/files/u1/link.txt", "symbolic-link", "read"],
    ],
  );
  warned.length = 0;
  await storage.delete("wsA/files/u1/link.txt");
  assert.equal(warned.length, 1, "removing a planted link is logged");
  assert.equal(await fs.readFile(path.join(f.outside, "secret.txt"), "utf8"), SECRET);
  await assert.rejects(storage.openReadStream("wsA/files/u1/absent.txt"), MissingBlobError);
  await assert.rejects(storage.open("wsA/files/absent/x.txt"), MissingBlobError);
  await storage.delete("wsA/files/absent/x.txt");
  assert.equal(await storage.exists("wsA/files/absent/x.txt"), false);
  // Range reads still work on regular files.
  const ranged = await storage.openReadStream("wsA/files/u1/own.txt", { start: 4, end: 8 });
  let text = "";
  for await (const chunk of ranged) text += chunk;
  assert.equal(text, "bytes");
});

/**
 * Deterministic check-to-use races (/proc only): once the folder holding the
 * blob has been opened, it is renamed away and a link to the outside put in
 * its place, just before the blob itself is opened, created or removed. The
 * access must land in the folder that was checked, never behind the link.
 */
if (PROC) {
  async function raced(t, operation, act) {
    const f = await fixture();
    await fs.writeFile(path.join(f.outside, "own.txt"), SECRET);
    const root = new StorageRoot(f.root, { procFd: true });
    const open = fs.open;
    const unlink = fs.unlink;
    let swapped = false;
    const swap = (args) => {
      if (swapped || !String(args[0]).endsWith(`${path.sep}${operation === "create" ? "new.txt" : "own.txt"}`)) return;
      swapped = true;
      fss.renameSync(f.at("wsA/files/u1"), f.at("wsA/files/u1-moved"));
      fss.symlinkSync(f.outside, f.at("wsA/files/u1"));
    };
    t.mock.method(fs, "open", async (...args) => { swap(args); return open(...args); });
    t.mock.method(fs, "unlink", async (...args) => { swap(args); return unlink(...args); });
    try {
      await act(root);
    } finally {
      t.mock.restoreAll();
    }
    assert.equal(swapped, true, "the folder was replaced by a link between check and use");
    assert.deepEqual(await fs.readdir(f.outside), ["own.txt", "secret.txt"]);
    assert.equal(await fs.readFile(path.join(f.outside, "own.txt"), "utf8"), SECRET);
    return f;
  }

  test("race: a folder swapped for a link after it was checked does not redirect a read", async (t) => {
    await raced(t, "read", async (root) => {
      const opened = await root.openFile("wsA/files/u1/own.txt");
      try {
        assert.equal((await opened.handle.readFile()).toString(), "own bytes", "the checked folder's file was read");
      } finally {
        await opened.handle.close();
      }
    });
  });

  test("race: a folder swapped for a link after it was checked does not redirect a write", async (t) => {
    const f = await raced(t, "create", async (root) => {
      const created = await root.createFile("wsA/files/u1/new.txt");
      await created.handle.writeFile("written");
      await created.handle.close();
    });
    assert.equal(await fs.readFile(f.at("wsA/files/u1-moved/new.txt"), "utf8"), "written");
  });

  test("race: a folder swapped for a link after it was checked does not redirect a delete", async (t) => {
    const f = await raced(t, "unlink", async (root) => {
      assert.equal(await root.unlink("wsA/files/u1/own.txt"), "removed");
    });
    await assert.rejects(fs.access(f.at("wsA/files/u1-moved/own.txt")), { code: "ENOENT" });
  });

  test("race: a folder flipping between a directory and a link never leaks the outside file", { timeout: 60_000 }, async (t) => {
    const f = await fixture();
    await fs.writeFile(path.join(f.outside, "own.txt"), SECRET);
    // Another process flips wsA/files/u1 between the real folder and a link
    // to the outside folder (which has an own.txt too) as fast as it can.
    const flipper = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      const [dir, parked, outside] = process.argv.slice(1);
      const tmp = dir + ".link";
      for (;;) {
        try {
          fs.symlinkSync(outside, tmp);
          fs.renameSync(dir, parked);
          fs.renameSync(tmp, dir);
          fs.unlinkSync(dir);
          fs.renameSync(parked, dir);
        } catch {}
      }`, f.at("wsA/files/u1"), path.join(f.base, "parked"), f.outside], { stdio: "ignore" });
    const counts = { own: 0, refused: 0, missing: 0, leaked: 0 };
    try {
      const root = new StorageRoot(f.root, { procFd: true });
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        try {
          const opened = await root.openFile("wsA/files/u1/own.txt");
          const text = (await opened.handle.readFile()).toString();
          await opened.handle.close();
          if (text === SECRET) counts.leaked++;
          else counts.own++;
        } catch (error) {
          if (error instanceof StorageRefusedError) counts.refused++;
          else if (error.code === "ENOENT" || error.code === "ENOTDIR") counts.missing++;
          else throw error;
        }
      }
    } finally {
      flipper.kill("SIGKILL");
    }
    t.diagnostic(JSON.stringify(counts));
    assert.equal(counts.leaked, 0, JSON.stringify(counts));
    assert.ok(counts.own > 0 && counts.refused > 0, `both states were observed: ${JSON.stringify(counts)}`);
  });
}

test("the storage-link report lists every link and special file without following any", async () => {
  const f = await fixture();
  await fs.symlink(path.join(f.outside, "secret.txt"), f.at("wsA/files/u1/leaf-link.txt"));
  await fs.symlink(f.outside, f.at("wsA/files/folder-link"));
  await fs.symlink(f.at("wsB"), f.at("workspace-link"));
  execFileSync("mkfifo", [f.at("wsB/files/u2/pipe")]);
  // Inside the linked outside folder: must not be visited.
  await fs.symlink("/etc/passwd", path.join(f.outside, "beyond-link"));
  const linkedRoot = path.join(f.base, "linked-root");
  await fs.symlink(f.root, linkedRoot);
  const before = await snapshot(f.base);
  const { storageLinkReport } = await import("../src/scripts/storage-link-report.ts");
  const report = await storageLinkReport(linkedRoot);
  assert.equal(report.storageRoot, await fs.realpath(f.root));
  assert.deepEqual(
    report.findings.map(({ path: p, kind, target }) => [p, kind, target]).sort(),
    [
      ["workspace-link", "symbolic-link", f.at("wsB")],
      ["wsA/files/folder-link", "symbolic-link", f.outside],
      ["wsA/files/u1/leaf-link.txt", "symbolic-link", path.join(f.outside, "secret.txt")],
      ["wsB/files/u2/pipe", "fifo", undefined],
    ],
  );
  assert.equal(report.total, 4);
  assert.deepEqual(report.unreadable, []);
  assert.deepEqual(await snapshot(f.base), before, "the report changed nothing");
  const limited = await findStorageLinks(report.storageRoot, { limit: 1 });
  assert.equal(limited.findings.length, 1);
  assert.equal(limited.total, 4);
  // As a command: exit status 2 when something was found, 0 when clean.
  const run = (dir) => {
    try {
      execFileSync(process.execPath, ["--import", "tsx", "src/scripts/storage-link-report.ts", "--json", `--dir=${dir}`], { stdio: "pipe" });
      return 0;
    } catch (error) {
      return error.status;
    }
  };
  assert.equal(run(linkedRoot), 2);
  const clean = path.join(f.base, "clean");
  await fs.mkdir(path.join(clean, "ws/files"), { recursive: true });
  assert.equal(run(clean), 0);
});

for (const proc of MODES) {
  test(`${proc ? "/proc/self/fd" : "path fallback"}: the report never enters a folder swapped for a link after it was listed`, async (t) => {
    const f = await fixture();
    // Would be reported as wsA/files/u1/beyond-link if the swapped folder were entered.
    await fs.symlink("/etc/passwd", path.join(f.outside, "beyond-link"));
    const open = fs.open;
    let swapped = false;
    t.mock.method(fs, "open", async (...args) => {
      // wsA/files has been listed and u1 queued; it becomes a link just
      // before the report opens it.
      if (!swapped && String(args[0]).endsWith(`${path.sep}u1`)) {
        swapped = true;
        fss.renameSync(f.at("wsA/files/u1"), path.join(f.base, "u1-moved"));
        fss.symlinkSync(f.outside, f.at("wsA/files/u1"));
      }
      return open(...args);
    });
    let report;
    try {
      report = await findStorageLinks(f.root, { procFd: proc });
    } finally {
      t.mock.restoreAll();
    }
    assert.equal(swapped, true);
    assert.deepEqual(
      report.findings.map(({ path: p, kind, target }) => [p, kind, target]),
      [["wsA/files/u1", "symbolic-link", f.outside]],
    );
  });
}
