import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

for (const [workspace, script, rootScript] of [
  ["frontend", "test", "test"],
  ["backend", "test:integration", "test:integration"],
]) {
  test(`${workspace} ${script}: required gate rejects missing scripts and propagates execution failures`, () => {
    // Run the actual root script in a disposable workspace. Only suite bodies are
    // fixtures, so package.json's pnpm dispatch and optional scripts remain real.
    const dir = mkdtempSync(join(tmpdir(), "werkyn-required-gate-"));
    const marker = join(dir, "gate-ran");
    const packagePath = join(dir, "packages", workspace, "package.json");
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
      writeFileSync(
        join(dir, "pnpm-workspace.yaml"),
        "packages:\n  - packages/*\n",
      );
      mkdirSync(join(dir, ".github", "tests"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "tests", "dispatch-fixture.test.mjs"),
        'import test from "node:test"; test("fixture policy check", () => {});',
      );
      for (const name of ["shared", "backend", "frontend"]) {
        const directory = join(dir, "packages", name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, "package.json"),
          JSON.stringify({
            name: `@pm/${name}`,
            version: "0.0.1",
            private: true,
            scripts:
              name === "shared" ? { build: 'node -e "process.exit(0)"' } : {},
          }),
        );
      }
      const writeScripts = (scripts) =>
        writeFileSync(
          packagePath,
          JSON.stringify({
            name: `@pm/${workspace}`,
            version: "0.0.1",
            private: true,
            scripts,
          }),
        );
      const run = () =>
        spawnSync("pnpm", [rootScript], {
          cwd: dir,
          env: { ...process.env, AUDIT_TEST_MARKER: marker },
          encoding: "utf8",
          timeout: 30000,
        });

      let result = run();
      assert.notEqual(
        result.status,
        0,
        `Missing ${workspace} ${script} silently passed ${rootScript}`,
      );
      assert.equal(result.error, undefined);

      writeScripts({
        [script]: `node -e "require('node:fs').writeFileSync(process.env.AUDIT_TEST_MARKER, '${workspace}')"`,
      });
      result = run();
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(readFileSync(marker, "utf8"), workspace);

      writeScripts({ [script]: 'node -e "process.exit(7)"' });
      result = run();
      assert.notEqual(
        result.status,
        0,
        `Failed ${workspace} ${script} silently passed ${rootScript}`,
      );
      assert.equal(result.error, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
