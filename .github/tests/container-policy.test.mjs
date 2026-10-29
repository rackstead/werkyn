import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

// YAML is already a direct backend dependency; use that workspace's resolution.
const require = createRequire(
  new URL("../../packages/backend/package.json", import.meta.url),
);
const { parse } = require("yaml");

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const dockerfile = read("Dockerfile");
const entrypoint = read("docker-entrypoint.sh");
const compose = parse(read("docker-compose.yml"), { merge: true });

// Joins continuation lines and drops comments, so each entry is one instruction.
const instructions = dockerfile
  .replace(/\\\n/g, " ")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
const stages = [];
for (const line of instructions) {
  if (/^FROM\s/i.test(line)) stages.push([]);
  stages.at(-1)?.push(line);
}

test("the runtime stage ends as a non-root numeric user", () => {
  const runtime = stages.at(-1);
  const users = runtime.filter((line) => /^USER\s/i.test(line));
  assert.ok(users.length > 0, "the runtime stage must set USER");
  const [uid, gid] = users.at(-1).split(/\s+/)[1].split(":");
  for (const id of [uid, gid]) {
    assert.match(id, /^\d+$/, "USER must be numeric so runAsNonRoot can verify it");
    assert.notEqual(Number(id), 0);
  }
  // Nothing after USER may switch back or run build steps as that user.
  const afterUser = runtime.slice(runtime.indexOf(users.at(-1)) + 1);
  assert.ok(afterUser.every((line) => !/^(USER|RUN)\s/i.test(line)), afterUser.join("\n"));
});

test("dependencies and the Prisma CLI come only from the frozen lockfile", () => {
  const installs = instructions.filter((line) => /\bpnpm (install|i)\b/.test(line));
  assert.ok(installs.length >= 2);
  for (const line of installs) assert.match(line, /--frozen-lockfile/, line);
  for (const source of [dockerfile, entrypoint]) {
    assert.doesNotMatch(source, /\b(npx|pnpx|pnpm dlx)\b/);
    assert.doesNotMatch(source, /\b(pnpm add|npm (install|i)|yarn (global )?add)\b/);
  }
  assert.ok(
    instructions.some((line) => /^RUN node \S*link-locked-prisma-cli\.mjs/.test(line)),
    "the build must link and check the locked Prisma CLI",
  );
});

test("external base images are pinned by digest", () => {
  const aliases = new Set();
  for (const stage of stages) {
    const [, image, , alias] = stage[0].split(/\s+/);
    if (!aliases.has(image)) assert.match(image, /^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/, image);
    if (alias) aliases.add(alias);
  }
});

test("the entrypoint is valid sh and drops root before migrating or serving", () => {
  const syntax = spawnSync("sh", ["-n", "docker-entrypoint.sh"], {
    cwd: new URL("../../", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  const dropRoot = entrypoint.indexOf('exec su-exec "$APP_USER"');
  assert.ok(dropRoot > 0);
  assert.ok(entrypoint.indexOf("prisma migrate deploy") > dropRoot);
  assert.ok(entrypoint.indexOf("exec node") > dropRoot);
});

test("the root handover leaves directories outside the data roots alone", () => {
  // Runs the real entrypoint as "root" (a stub id) with a recording chown stub.
  // Every configured directory here resolves outside /app/storage and /app/data,
  // directly or through a symbolic link, so chown must never run.
  const dir = mkdtempSync(join(tmpdir(), "werkyn-handover-"));
  try {
    const bin = join(dir, "bin");
    const calls = join(dir, "chown-calls");
    mkdirSync(bin);
    writeFileSync(join(bin, "id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
    writeFileSync(join(bin, "chown"), `#!/bin/sh\necho "$@" >> '${calls}'\n`, { mode: 0o755 });
    symlinkSync("/etc", join(dir, "etc-link"));
    for (const [storage, dex] of [
      ["/etc", "/usr"],
      [join(dir, "etc-link"), "/"],
    ]) {
      const result = spawnSync("sh", ["docker-entrypoint.sh", "fix-permissions"], {
        cwd: new URL("../../", import.meta.url),
        env: { PATH: `${bin}:${process.env.PATH}`, STORAGE_DIR: storage, DEX_CONFIG_DIR: dex },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const refused = result.stderr.match(/Not changing owners under (\S+):/g) ?? [];
      assert.equal(refused.length, 2, result.stderr);
    }
    assert.equal(existsSync(calls), false, "chown ran outside the data roots");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the handover skips other mounts and multiply linked files", () => {
  // Behaviour is checked against a built image; this keeps both walks aligned.
  const walks = entrypoint.match(/find "\$real" [^\n|]*-user 0[^\n|]*/g) ?? [];
  assert.equal(walks.length, 3, walks.join("\n"));
  for (const walk of walks) assert.match(walk, /-xdev/);
  const [counted, changed] = walks.filter((walk) => !walk.includes("-links +1"));
  for (const walk of [counted, changed])
    assert.match(walk, /\\\( -type d -o -links 1 \\\)/, walk);
  assert.match(changed, /-exec chown -h/);
});

test("a non-root start outside the data roots is told to chown, not to run fix-permissions", (t) => {
  if (process.getuid?.() === 0) return t.skip("needs a non-root user");
  const result = spawnSync("sh", ["docker-entrypoint.sh"], {
    cwd: new URL("../../", import.meta.url),
    env: { PATH: process.env.PATH, STORAGE_DIR: "/etc", DEX_CONFIG_DIR: "/etc" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\/etc is not writable by uid \d+/);
  assert.match(result.stderr, new RegExp(`chown -Rh ${process.getuid()}:${process.getgid()} `));
  assert.doesNotMatch(result.stderr, /<image> fix-permissions/);
});

test("Compose runs the app as the image user after handing over root-owned data", () => {
  const { werkyn, "werkyn-permissions": permissions } = compose.services;
  assert.equal(werkyn.user, undefined, "the app must keep the image's non-root user");
  assert.deepEqual(werkyn.depends_on["werkyn-permissions"], {
    condition: "service_completed_successfully",
  });
  assert.equal(permissions.user, "0");
  assert.deepEqual(permissions.command, ["fix-permissions"]);
  assert.equal(permissions.network_mode, "none");
  assert.equal(permissions.read_only, true);
  assert.deepEqual(permissions.cap_drop, ["ALL"]);
  assert.deepEqual(permissions.cap_add.toSorted(), ["CHOWN", "DAC_READ_SEARCH"]);
  assert.equal(permissions.restart, undefined);
  assert.deepEqual(permissions.volumes, werkyn.volumes);
  for (const name of ["STORAGE_DIR", "DEX_CONFIG_DIR"])
    assert.equal(permissions.environment[name], werkyn.environment[name], name);
});
