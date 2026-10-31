import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(path.join(os.tmpdir(), "werkyn-dex-manager-"));
const logPath = path.join(tmp, "fake-dex.log");
const fakeDex = path.join(tmp, "dex");
const fakeDexScript = fileURLToPath(
  new URL("./fixtures/fake-dex.mjs", import.meta.url),
);
writeFileSync(
  fakeDex,
  `#!/bin/sh\nexec "${process.execPath}" "${fakeDexScript}" "$@"\n`,
  {
    mode: 0o755,
  },
);
const notExecutable = path.join(tmp, "dex-not-executable");
writeFileSync(notExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o644 });

Object.assign(process.env, {
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unit_test",
  JWT_SECRET: "unit-dex-manager-jwt-secret",
  COOKIE_SECRET: "unit-dex-manager-cookie-secret",
  DEX_CONFIG_DIR: path.join(tmp, "config"),
  DEX_STORAGE_TYPE: "sqlite3",
  FAKE_DEX_LOG: logPath,
});
const { env } = await import("../src/config/env.ts");
const dexModule = await import("../src/services/dex-manager.ts");
const { dexManager } = dexModule;

// The SSO settings row as the admin API last saved it.
const sso = {
  enabled: true,
  connectors: [
    {
      type: "ldap",
      connectorId: "ldap",
      name: "config-v1",
      config: {},
      enabled: true,
      position: 0,
    },
  ],
};
let onConfigFileRead = null;
const prisma = {
  ssoConfig: {
    async findUnique(args) {
      await delay(5);
      const snapshot = structuredClone(sso);
      // generateDexConfig orders connectors; the start check does not.
      if (args.include.connectors.orderBy && onConfigFileRead) {
        const hook = onConfigFileRead;
        onConfigFileRead = null;
        hook();
      }
      return snapshot;
    },
  },
};

function createLogger() {
  const entries = [];
  const logger = {};
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
    logger[level] = (...args) => entries.push({ level, args });
  }
  logger.child = () => logger;
  return { logger, entries };
}

function events() {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startedPids() {
  return [
    ...new Set(
      events()
        .filter((e) => e.event === "start")
        .map((e) => e.pid),
    ),
  ];
}

function livePids() {
  return startedPids().filter(isAlive);
}

async function waitFor(condition, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await delay(20);
  }
}

function spawnErrors(entries, code) {
  return entries.filter(
    (entry) =>
      entry.level === "error" &&
      entry.args.some((arg) => arg?.code === code || arg?.err?.code === code),
  );
}

// Give a racing second spawn time to start and record itself.
const SETTLE_MS = 750;

// Every Dex the tests started, so none outlives the run even when a test fails.
const everyPid = new Set();

afterEach(async () => {
  await dexManager.stop();
  for (const pid of startedPids()) everyPid.add(pid);
  delete process.env.FAKE_DEX_IGNORE_TERM;
  delete process.env.FAKE_DEX_EXIT_CODE;
  sso.connectors[0].name = "config-v1";
  onConfigFileRead = null;
  rmSync(logPath, { force: true });
});

after(async () => {
  await dexManager.stop();
  for (const pid of startedPids()) everyPid.add(pid);
  for (const pid of [...everyPid].filter(isAlive)) process.kill(pid, "SIGKILL");
  rmSync(tmp, { recursive: true, force: true });
});

for (const [label, binary, code] of [
  ["missing", () => path.join(tmp, "no-such-dex"), "ENOENT"],
  ["non-executable", () => notExecutable, "EACCES"],
]) {
  test(`a ${label} Dex binary is logged as a failure without crashing the server`, async () => {
    const { logger, entries } = createLogger();
    env.DEX_BINARY_PATH = binary();

    await dexManager.start(prisma, logger);
    await waitFor(
      () => spawnErrors(entries, code).length > 0,
      `no ${code} error was logged`,
    );
    assert.equal(dexManager.isRunning, false);
    assert.deepEqual(livePids(), []);

    // The manager is not wedged: once a working binary is configured, the
    // next settings save starts Dex.
    env.DEX_BINARY_PATH = fakeDex;
    await dexManager.restart(prisma);
    await waitFor(
      () => livePids().length === 1,
      "Dex did not start after the binary was fixed",
    );
    assert.equal(dexManager.isRunning, true);
  });
}

test("a DATABASE_URL repeating a TLS parameter stops Dex from starting with a logged error", async () => {
  const { logger, entries } = createLogger();
  const attempts = [];
  const manager = new dexModule.DexManager({
    restartDelayMs: 20,
    binaryPath: () => {
      attempts.push(Date.now());
      return fakeDex;
    },
  });
  const original = {
    storage: env.DEX_STORAGE_TYPE,
    url: env.DATABASE_URL,
  };
  env.DEX_STORAGE_TYPE = "postgres";
  env.DATABASE_URL =
    "postgresql://u:p@db.example.net/werkyn?sslmode=disable&sslmode=require";
  try {
    await manager.start(prisma, logger);
    await delay(200);
    assert.equal(manager.isRunning, false);
    assert.deepEqual(attempts, [], "Dex was spawned");
    const errors = entries.filter((e) => e.level === "error");
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0].args.at(-1), /Failed to generate Dex config/);
    assert.match(errors[0].args[0].message, /"sslmode" more than once/);
  } finally {
    env.DEX_STORAGE_TYPE = original.storage;
    env.DATABASE_URL = original.url;
    await manager.stop();
  }
});

test("invalid sslaccept stops an existing Dex, logs safely without retrying, and recovers after correction", async () => {
  const { logger, entries } = createLogger();
  const attempts = [];
  const manager = new dexModule.DexManager({
    restartDelayMs: 20,
    binaryPath: () => {
      attempts.push(Date.now());
      return fakeDex;
    },
  });
  const original = { storage: env.DEX_STORAGE_TYPE, url: env.DATABASE_URL };
  env.DEX_STORAGE_TYPE = "postgres";
  const base = "postgresql://private-user:private-password@private-db/private-name?sslmode=require";
  env.DATABASE_URL = `${base}&sslaccept=strict`;
  try {
    await manager.start(prisma, logger);
    await waitFor(() => livePids().length === 1, "Dex did not start with strict verification");
    for (const value of ["bogus", "", "ACCEPT_INVALID_CERTS", "private-token\nprivate-extra"]) {
      const attemptsBefore = attempts.length;
      const errorsBefore = entries.filter((entry) => entry.level === "error").length;
      env.DATABASE_URL = `${base}&ssl%61ccept=${encodeURIComponent(value)}`;
      await manager.restart(prisma);
      await delay(100);
      assert.equal(manager.isRunning, false);
      assert.deepEqual(livePids(), []);
      assert.equal(attempts.length, attemptsBefore, "Dex was spawned or retried");
      const errors = entries.filter((entry) => entry.level === "error");
      assert.equal(errors.length, errorsBefore + 1);
      const error = errors.at(-1);
      assert.equal(error.args.at(-1), "Failed to generate Dex config");
      assert.equal(
        error.args[0].message,
        "DATABASE_URL sslaccept is not supported for Dex; use strict or accept_invalid_certs (case-sensitive), or omit it",
      );
      assert.doesNotMatch(
        `${error.args[0].stack} ${JSON.stringify(error.args)}`,
        /private-user|private-password|private-db|private-name|private-token|private-extra/,
      );
      assert.equal(entries.filter((entry) => /Restarting Dex in/.test(String(entry.args.at(-1)))).length, 0);
    }

    env.DATABASE_URL = `${base}&sslaccept=strict`;
    await manager.restart(prisma);
    await waitFor(() => livePids().length === 1, "Dex did not recover after sslaccept was corrected");
    assert.equal(manager.isRunning, true);
    assert.equal(attempts.length, 2);
  } finally {
    env.DEX_STORAGE_TYPE = original.storage;
    env.DATABASE_URL = original.url;
    await manager.stop();
  }
});

test("start and a settings save racing at boot leave exactly one Dex running", async () => {
  const { logger } = createLogger();
  env.DEX_BINARY_PATH = fakeDex;

  await Promise.all([
    dexManager.start(prisma, logger),
    dexManager.restart(prisma),
  ]);
  await waitFor(() => startedPids().length > 0, "Dex never started");
  await delay(SETTLE_MS);

  assert.equal(
    livePids().length,
    1,
    `live Dex processes: ${JSON.stringify(events())}`,
  );
  assert.equal(dexManager.isRunning, true);
});

test("a settings save during an in-flight restart is applied, leaving one Dex on the newest config", async () => {
  const { logger } = createLogger();
  env.DEX_BINARY_PATH = fakeDex;
  await dexManager.start(prisma, logger);
  await waitFor(() => livePids().length === 1, "Dex did not start");

  // The first save's restart has already read the settings when the second
  // save lands and asks for another restart.
  let second;
  onConfigFileRead = () => {
    sso.connectors[0].name = "config-v2";
    second = dexManager.restart(prisma);
  };
  sso.connectors[0].name = "config-v1b";
  const first = dexManager.restart(prisma);
  await first;
  assert.ok(second, "the second save never ran");
  await second;
  await delay(SETTLE_MS);

  const live = livePids();
  assert.equal(
    live.length,
    1,
    `live Dex processes: ${JSON.stringify(events())}`,
  );
  const started = events().filter(
    (e) => e.event === "start" && e.pid === live[0],
  );
  assert.deepEqual(started[0].connectors, ["config-v2"]);
});

test("stopping during an in-flight restart leaves no Dex running", async () => {
  const { logger } = createLogger();
  env.DEX_BINARY_PATH = fakeDex;
  await dexManager.start(prisma, logger);
  await waitFor(() => livePids().length === 1, "Dex did not start");

  const restarting = dexManager.restart(prisma);
  const stopping = dexManager.stop();
  await Promise.all([restarting, stopping]);
  await delay(SETTLE_MS);

  assert.deepEqual(
    livePids(),
    [],
    `live Dex processes: ${JSON.stringify(events())}`,
  );
  assert.equal(dexManager.isRunning, false);
});

test("start after a stop starts Dex even when restarts were still queued before the stop", async () => {
  const { logger } = createLogger();
  const manager = new dexModule.DexManager({ binaryPath: () => fakeDex });
  try {
    await manager.start(prisma, logger);
    await waitFor(() => livePids().length === 1, "Dex did not start");
    const [first] = livePids();

    await Promise.all([
      manager.restart(prisma),
      manager.restart(prisma),
      manager.stop(),
      manager.start(prisma, logger),
    ]);
    assert.equal(
      manager.isRunning,
      true,
      "start() after stop() left Dex stopped",
    );
    await delay(SETTLE_MS);

    const live = livePids();
    assert.equal(
      live.length,
      1,
      `live Dex processes: ${JSON.stringify(events())}`,
    );
    assert.notEqual(live[0], first);
    // The stop supersedes the restarts queued before it, so they do not
    // spawn a Dex that the stop then has to kill.
    assert.equal(
      startedPids().length,
      2,
      `Dex starts: ${JSON.stringify(events())}`,
    );
  } finally {
    await manager.stop();
  }
});

test("a restart queued before a stop does not start Dex once the stop has run", async () => {
  const { logger } = createLogger();
  const manager = new dexModule.DexManager({ binaryPath: () => fakeDex });
  try {
    await manager.start(prisma, logger);
    await waitFor(() => livePids().length === 1, "Dex did not start");

    await Promise.all([
      manager.restart(prisma),
      manager.stop(),
      manager.restart(prisma),
    ]);
    await delay(SETTLE_MS);
    assert.equal(manager.isRunning, false);
    assert.deepEqual(livePids(), []);
    assert.equal(startedPids().length, 1);
  } finally {
    await manager.stop();
  }
});

test("stop sends SIGKILL to a Dex that ignores SIGTERM and waits for it to exit", async () => {
  const { logger, entries } = createLogger();
  const manager = new dexModule.DexManager({
    stopTimeoutMs: 200,
    killTimeoutMs: 2_000,
    binaryPath: () => fakeDex,
  });
  process.env.FAKE_DEX_IGNORE_TERM = "1";
  try {
    await manager.start(prisma, logger);
    await waitFor(() => livePids().length === 1, "Dex did not start");
    const [pid] = livePids();

    const startedAt = Date.now();
    await manager.stop();
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 2_000, `stop took ${elapsed} ms`);
    assert.equal(
      isAlive(pid),
      false,
      "Dex was still running after stop resolved",
    );
    assert.ok(
      events().some((e) => e.event === "ignored-sigterm" && e.pid === pid),
    );
    assert.ok(
      entries.some(
        (e) => e.level === "warn" && /SIGKILL/.test(String(e.args.at(-1))),
      ),
    );
  } finally {
    await manager.stop();
  }
});

test("repeated start failures back off exponentially up to a cap, and stop cancels the retry", async () => {
  const { logger, entries } = createLogger();
  const attempts = [];
  const manager = new dexModule.DexManager({
    restartDelayMs: 40,
    maxRestartDelayMs: 160,
    binaryPath: () => {
      attempts.push(Date.now());
      return path.join(tmp, "no-such-dex");
    },
  });

  await manager.start(prisma, logger);
  await waitFor(() => attempts.length >= 6, "Dex start was not retried");
  await manager.stop();
  const attemptsAtStop = attempts.length;

  const gaps = attempts.slice(1, 6).map((at, i) => at - attempts[i]);
  // 40, 80, 160, 160, 160 ms plus the settings reads and timer slack.
  assert.ok(gaps[0] >= 35, `gaps ${gaps}`);
  assert.ok(gaps[1] >= 75, `gaps ${gaps}`);
  for (const gap of gaps.slice(2)) {
    assert.ok(gap >= 150 && gap < 1_000, `gaps ${gaps}`);
  }
  assert.ok(spawnErrors(entries, "ENOENT").length >= 6);

  await delay(400);
  assert.equal(
    attempts.length,
    attemptsAtStop,
    "Dex start was retried after stop",
  );
  assert.equal(manager.isRunning, false);
});

test("a Dex that exits on its own is respawned after the backoff delay", async () => {
  const { logger } = createLogger();
  const manager = new dexModule.DexManager({
    restartDelayMs: 50,
    maxRestartDelayMs: 50,
    binaryPath: () => fakeDex,
  });
  process.env.FAKE_DEX_EXIT_CODE = "3";
  try {
    await manager.start(prisma, logger);
    await waitFor(
      () => startedPids().length >= 2,
      "Dex was not respawned after exiting",
    );
    delete process.env.FAKE_DEX_EXIT_CODE;
    await waitFor(
      () => manager.isRunning && livePids().length === 1,
      "respawned Dex did not stay up",
    );
  } finally {
    await manager.stop();
  }
  await delay(200);
  assert.deepEqual(livePids(), []);
});
