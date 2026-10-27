import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

// YAML is already a direct backend dependency; use that workspace's resolution.
const require = createRequire(
  new URL("../../packages/backend/package.json", import.meta.url),
);
const { parse } = require("yaml");
const workflow = parse(
  readFileSync(
    new URL("../workflows/docker-image.yml", import.meta.url),
    "utf8",
  ),
);

function publicationAllowed({
  event = "push",
  ref = "refs/heads/main",
  enabled = "true",
  validate = "success",
  image = "success",
  fork = false,
} = {}) {
  // This workflow uses only property access, string equality and &&, whose behavior
  // agrees with JavaScript for these string-only event fixtures. This is not a
  // general GitHub expression interpreter or proof of hosted execution.
  const expression = workflow.jobs.publish.if
    .trim()
    .replace(/^\$\{\{\s*/, "")
    .replace(/\s*\}\}$/, "");
  return vm.runInNewContext(
    expression,
    {
      github: {
        event_name: event,
        ref,
        event: { pull_request: { head: { repo: { fork } } } },
      },
      vars: { ENABLE_IMAGE_PUBLICATION: enabled },
      needs: { validate: { result: validate }, build_image: { result: image } },
    },
    { timeout: 100 },
  );
}

test("publication requires an authorized main push and successful checks", () => {
  for (const fork of [false, true]) {
    assert.equal(
      publicationAllowed({
        event: "pull_request",
        ref: "refs/pull/1/merge",
        fork,
      }),
      false,
    );
    // A crafted main-looking ref must still fail the PR event boundary.
    assert.equal(publicationAllowed({ event: "pull_request", fork }), false);
  }
  for (const enabled of [undefined, "", "false", "0"]) {
    assert.equal(publicationAllowed({ enabled: enabled ?? "" }), false);
  }
  assert.equal(publicationAllowed({ ref: "refs/heads/feature" }), false);
  assert.equal(publicationAllowed({ event: "workflow_dispatch" }), false);
  for (const outcome of ["failure", "cancelled", "skipped"]) {
    assert.equal(publicationAllowed({ validate: outcome }), false);
    assert.equal(publicationAllowed({ image: outcome }), false);
  }
  assert.equal(publicationAllowed(), true);
});

test("PR checks have no registry credentials or write permissions", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.on, {
    push: { branches: ["main"] },
    pull_request: { branches: ["main"] },
  });
  assert.deepEqual(workflow.jobs.publish.needs.toSorted(), [
    "build_image",
    "validate",
  ]);
  for (const name of ["validate", "build_image"]) {
    const job = workflow.jobs[name];
    assert.equal(job.permissions, undefined);
    assert.equal(
      job.if,
      undefined,
      "checks must run for fork and same-repository PRs",
    );
    for (const step of job.steps) {
      assert.ok(!step.uses?.startsWith("docker/login-action"));
      assert.ok(!JSON.stringify(step).includes("secrets."));
      if (step.uses?.startsWith("actions/checkout"))
        assert.equal(step.with["persist-credentials"], false);
      if (step.uses?.startsWith("docker/build-push-action"))
        assert.equal(step.with.push, false);
    }
  }
  assert.deepEqual(workflow.jobs.publish.permissions, {
    contents: "read",
    packages: "write",
  });
});

test("validation uses a disposable database and runs the repository gates", () => {
  const { validate } = workflow.jobs;
  assert.equal(validate.services.postgres.env.POSTGRES_DB, "werkyn_ci");
  assert.equal(validate.services.postgres.image, "postgres:16-alpine");
  assert.ok(validate.services.postgres.options.includes("pg_isready"));
  const configure = validate.steps.find(
    (step) => step.name === "Configure disposable database",
  );
  assert.equal(
    configure.env.POSTGRES_PORT,
    "${{ job.services.postgres.ports['5432'] }}",
  );
  const dir = mkdtempSync(join(tmpdir(), "werkyn-ci-policy-"));
  try {
    const envFile = join(dir, "github-env");
    const configured = spawnSync("bash", ["-e", "-c", configure.run], {
      env: { ...process.env, GITHUB_ENV: envFile, POSTGRES_PORT: "32771" },
      encoding: "utf8",
    });
    assert.equal(configured.status, 0, configured.stderr);
    const output = Object.fromEntries(
      readFileSync(envFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
    assert.equal(
      output.DATABASE_URL,
      "postgresql://audit:ci-disposable-only@127.0.0.1:32771/werkyn_ci",
    );
    assert.equal(output.TEST_DATABASE_URL, output.DATABASE_URL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const commands = validate.steps.flatMap((step) =>
    (step.run ?? "").split("\n"),
  );
  for (const command of [
    "pnpm install --frozen-lockfile",
    "pnpm --filter @pm/backend exec prisma validate",
    "pnpm --filter @pm/backend exec prisma generate",
    "pnpm --filter @pm/backend exec prisma migrate deploy",
    "pnpm test",
    "pnpm test:integration",
    "pnpm lint",
    "pnpm build",
  ])
    assert.ok(commands.includes(command), command);
  assert.ok(validate.steps.every((step) => !step["continue-on-error"]));
});
