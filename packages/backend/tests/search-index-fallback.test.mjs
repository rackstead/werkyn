// The search-index fallback (docs/remediation/p02c.md): a catalog check that
// fails avoids trigram indexes until a later check succeeds, and that
// recovery is logged once. A check that never fails does not log it.
import assert from "node:assert/strict";
import test from "node:test";

const {
  SEARCH_TRIGRAM_INDEXES,
  checkSearchIndexes,
  searchAvoidsTrigramIndexes,
  startSearchIndexCheck,
  withSearchPlans,
} = await import("../src/utils/text-search.ts");

const RECOVERY =
  "The search-index fallback ended; indexed plans are in use again (docs/remediation/p02c.md)";
const FAILURE =
  "Could not check the search trigram indexes; search avoids them until a check succeeds (docs/remediation/p02c.md)";

function sqlOf(strings) {
  if (strings && Array.isArray(strings.raw)) return strings.raw.join(" ");
  if (Array.isArray(strings)) return strings.join(" ");
  return String(strings ?? "");
}

function validIndexes() {
  return SEARCH_TRIGRAM_INDEXES.map(([name, table, column]) => ({
    name,
    table,
    valid: true,
    plain: true,
    method: "gin",
    columns: [`${column}:gin_trgm_ops`],
  }));
}

/** A catalog stand-in. `search_probe` queries are searches, not checks. */
function client({ failCatalog, indexes, provider }) {
  let catalogCalls = 0;
  const settings = [];
  return {
    settings,
    $queryRaw(strings) {
      const sql = sqlOf(strings);
      if (sql.includes("search_probe")) return Promise.resolve([{ n: 1 }]);
      if (failCatalog()) return Promise.reject(new Error("connection refused"));
      const which = catalogCalls++ % 2;
      return Promise.resolve(which === 0 ? indexes() : [{ provider: provider() }]);
    },
    $executeRaw(strings) {
      settings.push(sqlOf(strings));
      return Promise.resolve(0);
    },
    $transaction(queries) {
      return Promise.all(queries);
    },
  };
}

function recorder() {
  const warnings = [];
  const infos = [];
  return {
    warnings,
    infos,
    log: {
      warn: (...args) => warnings.push(args),
      info: (...args) => infos.push(args),
    },
  };
}

/** Fires startSearchIndexCheck rechecks one at a time. */
function manualTimer() {
  const state = { pending: null, intervals: [] };
  state.timer = (recheck, ms) => {
    assert.equal(state.pending, null, "one recheck is scheduled at a time");
    const entry = { recheck };
    state.pending = entry;
    state.intervals.push(ms);
    return () => {
      if (state.pending === entry) state.pending = null;
    };
  };
  state.fire = async () => {
    const entry = state.pending;
    assert.ok(entry, "a recheck is scheduled");
    state.pending = null;
    await entry.recheck();
  };
  return state;
}

test("a failed search-index check logs recovery once when a later check succeeds", async () => {
  let failing = true;
  const { warnings, infos, log } = recorder();
  const db = client({
    failCatalog: () => failing,
    indexes: validIndexes,
    provider: () => "c",
  });
  const rechecks = manualTimer();
  const loop = await startSearchIndexCheck(db, log, "public", { timer: rechecks.timer });
  try {
    assert.equal(loop.result, "failed");
    assert.equal(searchAvoidsTrigramIndexes(db), true);
    assert.deepEqual(warnings.map(([, message]) => message), [FAILURE]);
    assert.deepEqual(warnings[0][0], { err: "connection refused" });
    assert.deepEqual(infos, []);
    assert.deepEqual(rechecks.intervals, [60_000]);

    await withSearchPlans(db, [db.$queryRaw`SELECT 1 AS search_probe`]);
    assert.equal(infos.length, 0, "a search during the fallback does not log recovery");
    assert.ok(
      db.settings.some((sql) => sql.includes("enable_bitmapscan") && sql.includes("'off'")),
      "the fallback still turns bitmap scans off",
    );

    await rechecks.fire();
    await rechecks.fire();
    assert.equal(infos.length, 0, "failed rechecks do not log recovery");
    assert.equal(warnings.length, 1, "the startup warning is not repeated");
    assert.equal(searchAvoidsTrigramIndexes(db), true);

    failing = false;
    await rechecks.fire();
    assert.equal(searchAvoidsTrigramIndexes(db), false);
    assert.equal(rechecks.pending, null, "a healthy check does not keep rechecking");
    assert.deepEqual(rechecks.intervals, [60_000, 60_000, 60_000]);
    assert.equal(infos.length, 1);
    assert.deepEqual(infos[0][0], {});
    assert.equal(infos[0][1], RECOVERY);
    const encoded = JSON.stringify(infos);
    assert.doesNotMatch(encoded, /postgres(ql)?:\/\//i);
    assert.doesNotMatch(encoded, /SELECT/i);
    assert.doesNotMatch(encoded, /connection refused/);

    const before = db.settings.length;
    await withSearchPlans(db, [db.$queryRaw`SELECT 1 AS search_probe`]);
    await withSearchPlans(db, [db.$queryRaw`SELECT 1 AS search_probe`]);
    await withSearchPlans(db, [db.$queryRaw`SELECT 1 AS search_probe`]);
    assert.equal(await checkSearchIndexes(db, log), "ok");
    assert.equal(infos.length, 1, "later searches and later checks do not log recovery again");
    const after = db.settings.slice(before).join("\n");
    assert.match(after, /plan_cache_mode/);
    assert.doesNotMatch(after, /enable_bitmapscan/);
  } finally {
    loop.stop();
  }
});

test("a search-index check that never fails does not log recovery", async () => {
  const { warnings, infos, log } = recorder();
  const db = client({
    failCatalog: () => false,
    indexes: validIndexes,
    provider: () => "c",
  });
  const rechecks = manualTimer();
  const loop = await startSearchIndexCheck(db, log, "public", { timer: rechecks.timer });
  try {
    assert.equal(loop.result, "ok");
    assert.equal(searchAvoidsTrigramIndexes(db), false);
    assert.deepEqual(warnings, []);
    assert.deepEqual(infos, []);
    assert.equal(rechecks.pending, null);
    assert.deepEqual(rechecks.intervals, []);
    await withSearchPlans(db, [db.$queryRaw`SELECT 1 AS search_probe`]);
    await withSearchPlans(db, [db.$queryRaw`SELECT 1 AS search_probe`]);
    assert.deepEqual(infos, []);
    assert.ok(db.settings.every((sql) => !sql.includes("enable_bitmapscan")));
  } finally {
    loop.stop();
  }
});

test("a failed check that finds the indexes missing does not claim they are in use", async () => {
  let failing = true;
  const { warnings, infos, log } = recorder();
  const db = client({
    failCatalog: () => failing,
    indexes: () => [],
    provider: () => "c",
  });
  const rechecks = manualTimer();
  const loop = await startSearchIndexCheck(db, log, "public", { timer: rechecks.timer });
  try {
    assert.equal(loop.result, "failed");
    failing = false;
    await rechecks.fire();
    assert.equal(searchAvoidsTrigramIndexes(db), false);
    assert.equal(rechecks.pending, null);
    assert.deepEqual(infos, []);
    assert.equal(warnings.length, 2);
    assert.match(warnings[1][1], /missing, invalid or defined differently/);
  } finally {
    loop.stop();
  }
});

test("dropping restored indexes on an ICU database does not log indexed-plan recovery", async () => {
  let present = true;
  const { warnings, infos, log } = recorder();
  const db = client({
    failCatalog: () => false,
    indexes: () => (present
      ? [{
        name: "ChatMessage_content_trgm_idx",
        table: "ChatMessage",
        valid: true,
        plain: true,
        method: "gin",
        columns: ["content:gin_trgm_ops"],
      }]
      : []),
    provider: () => "i",
  });
  const rechecks = manualTimer();
  const loop = await startSearchIndexCheck(db, log, "public", { timer: rechecks.timer });
  try {
    assert.equal(loop.result, "warned");
    assert.equal(searchAvoidsTrigramIndexes(db), true);
    assert.deepEqual(infos, []);
    present = false;
    await rechecks.fire();
    assert.equal(searchAvoidsTrigramIndexes(db), false);
    assert.equal(rechecks.pending, null);
    assert.deepEqual(infos, []);
    assert.match(warnings.at(-1)[1], /are not created/);
  } finally {
    loop.stop();
  }
});
