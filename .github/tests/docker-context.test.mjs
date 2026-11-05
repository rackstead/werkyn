import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inBuildContext, readDockerignore } from "./docker-context.mjs";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const rules = readDockerignore(read(".dockerignore"));
const inContext = (path) => inBuildContext(rules, path);

// Vite reads packages/frontend/.env* during the image build, and a
// packages/backend/prisma/.env would be copied into the runtime image.
test("local environment files stay out of the build context at every depth", () => {
  const secrets = [
    ".env",
    ".env.local",
    ".env.production",
    "packages/frontend/.env",
    "packages/frontend/.env.local",
    "packages/frontend/.env.production",
    "packages/frontend/.env.production.local",
    "packages/frontend/public/.env",
    "packages/frontend/.env/values.json",
    "packages/backend/.env",
    "packages/backend/.env.test",
    "packages/backend/prisma/.env",
    "packages/shared/.env.development",
    "docker/.env",
  ];
  assert.deepEqual(secrets.filter(inContext), []);
});

test("env examples and similarly named sources stay in the build context", () => {
  const kept = [
    ".env.example",
    "packages/backend/.env.example",
    "packages/frontend/.env.example",
    "packages/frontend/.environment",
    "packages/frontend/src/vite-env.d.ts",
    "packages/backend/src/config/env.ts",
  ];
  assert.deepEqual(kept.filter((path) => !inContext(path)), []);
});

test("every tracked file the Dockerfile copies from the context is sent", () => {
  const sources = read("Dockerfile")
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([op, ...args]) => /^COPY$/i.test(op) && !args.some((arg) => arg.startsWith("--from")))
    .flatMap(([, ...args]) => args.filter((arg) => !arg.startsWith("--")).slice(0, -1))
    .map((source) => source.replace(/\/$/, ""));
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const tracked = listed.stdout.split("\0").filter(Boolean);
  const under = (source) => (file) => file === source || file.startsWith(`${source}/`);
  assert.ok(sources.includes("packages/frontend") && sources.includes("packages/backend/prisma"));
  for (const source of sources) assert.ok(tracked.some(under(source)), `nothing tracked at ${source}`);
  const copied = tracked.filter((file) => sources.some((source) => under(source)(file)));
  assert.deepEqual(copied.filter((file) => !inContext(file)), []);
});

// Each case was compared with a BuildKit context export of the same tree.
test("the context check follows Docker's .dockerignore matching", () => {
  const sent = (lines, paths) => {
    const parsed = readDockerignore(lines.join("\n"));
    return paths.filter((path) => inBuildContext(parsed, path));
  };
  // Without "**", a rule is anchored at the context root.
  assert.deepEqual(sent(["*.md", ".env"], ["README.md", "docs/a.md", ".env", "app/.env"]), ["docs/a.md", "app/.env"]);
  // "**/" also matches at the root, and a matched directory takes its contents.
  assert.deepEqual(sent(["**/dist"], ["dist/a.js", "app/web/dist/b.js", "app/distribution/c.js"]), [
    "app/distribution/c.js",
  ]);
  // Comments, a leading "/" and a trailing "/" are normalized away.
  assert.deepEqual(sent(["# storage", "/storage/"], ["storage/a/b", "app/storage/c", "# storage"]), [
    "app/storage/c",
    "# storage",
  ]);
  // The last matching rule wins.
  assert.deepEqual(sent(["**/.env.*", "!**/.env.example"], ["a/.env.example", "a/.env.local"]), ["a/.env.example"]);
  assert.deepEqual(sent(["!keep.txt", "*.txt"], ["keep.txt", "other.bin"]), ["other.bin"]);
  // An excluded directory is skipped unless an exception names a path in it.
  assert.deepEqual(sent(["cache", "!cache/keep"], ["cache/keep", "cache/drop"]), ["cache/keep"]);
  assert.deepEqual(sent(["cache", "!**/keep"], ["cache/keep", "keep"]), ["keep"]);
});
