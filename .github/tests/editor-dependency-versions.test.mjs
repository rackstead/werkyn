import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

// YAML is already a direct backend dependency; use that workspace's resolution.
const require = createRequire(
  new URL("../../packages/backend/package.json", import.meta.url),
);
const { parse } = require("yaml");
const lockfile = parse(
  readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"),
);

// TipTap and ProseMirror compare steps, transforms and nodes with `instanceof`,
// so two copies of one of these packages in the bundle break editor commands
// (for example Shift+Enter over a selection leaving the new break selected).
// pnpm can keep an older copy for some dependents when only one dependent asks
// for a newer range, so the lockfile must resolve each to exactly one version.
const EDITOR_PACKAGE = /^(@tiptap\/[^@]+|prosemirror-[^@]+)$/;

function editorPackageVersions(packages) {
  const versions = new Map();
  for (const entry of Object.keys(packages ?? {})) {
    // Snapshot keys carry peer suffixes such as `(@tiptap/pm@3.30.6)`.
    const key = entry.replace(/\(.*$/, "");
    const at = key.lastIndexOf("@");
    if (at <= 0) continue;
    const name = key.slice(0, at);
    if (!EDITOR_PACKAGE.test(name)) continue;
    const version = key.slice(at + 1);
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(version);
  }
  return versions;
}

test("the lockfile resolves every @tiptap/* and prosemirror-* package to one version", () => {
  const versions = editorPackageVersions(lockfile.packages);
  assert.ok(versions.has("@tiptap/core"), "expected @tiptap/core in the lockfile");
  assert.ok(versions.has("prosemirror-transform"), "expected prosemirror-transform in the lockfile");
  const duplicated = [...versions]
    .filter(([, set]) => set.size > 1)
    .map(([name, set]) => `${name}: ${[...set].sort().join(", ")}`);
  assert.deepEqual(duplicated, [], `more than one version resolved:\n${duplicated.join("\n")}`);
});

test("the duplicate check sees versions behind peer suffixes and scopes", () => {
  const versions = editorPackageVersions({
    "@tiptap/core@3.30.6": {},
    "@tiptap/core@3.19.0(@tiptap/pm@3.19.0)": {},
    "prosemirror-transform@1.12.4": {},
    "y-prosemirror@1.3.7": {},
  });
  assert.deepEqual([...versions.get("@tiptap/core")].sort(), ["3.19.0", "3.30.6"]);
  assert.deepEqual([...versions.get("prosemirror-transform")], ["1.12.4"]);
  assert.equal(versions.has("y-prosemirror"), false);
});
