import assert from "node:assert/strict";
import { test } from "node:test";
import { BackupFileSchema } from "@pm/shared";

const { scopePositions, uniqueNames, assetMatcher, rewriteAssetPaths, planRestore, mapUsers, emptyCounts } =
  await import("../src/modules/backup/restore-plan.ts");
const { validateBackup, isStorableText, MAX_RESTORE_JSON_DEPTH } = await import(
  "../src/modules/backup/restore-validation.ts"
);

const META = {
  version: "1.1",
  exportedAt: "2026-01-01T00:00:00.000Z",
  sourceWorkspace: { name: "Unit", slug: "unit" },
  userRefs: [],
};
const parse = (file) => BackupFileSchema.parse({ metadata: META, ...file });
const nested = (levels) => {
  let value = 0;
  for (let i = 0; i < levels; i++) value = i % 2 ? { c: value } : [value];
  return value;
};

test("positions are kept when distinct int32 values, else renumbered in their order", () => {
  assert.deepEqual(scopePositions([0, 5, 2]), { positions: [0, 5, 2], renumbered: false });
  assert.deepEqual(scopePositions([]), { positions: [], renumbered: false });
  assert.deepEqual(scopePositions([3, 3, 1]), { positions: [1, 2, 0], renumbered: true });
  assert.deepEqual(scopePositions([0.5, -1, 2 ** 31, Infinity, 0]), {
    positions: [2, 0, 3, 4, 1],
    renumbered: true,
  });
  assert.deepEqual(scopePositions([2_147_483_647, 0]).renumbered, false);
});

test("repeated names get the first free numbered suffix within the column length", () => {
  assert.deepEqual(uniqueNames(["Bug", "Bug", "Bug (2)", "Bug"], 100), {
    names: ["Bug", "Bug (3)", "Bug (2)", "Bug (4)"],
    renamed: [
      ["Bug", "Bug (3)"],
      ["Bug", "Bug (4)"],
    ],
  });
  // The suffix replaces the end of a name at the limit, by characters.
  const long = "😀".repeat(10);
  const result = uniqueNames([long, long], 10);
  assert.equal(result.names[1], `${"😀".repeat(6)} (2)`);
  assert.equal(Array.from(result.names[1]).length, 10);
});

test("repairing many repeated names takes linear time and stays within the column", () => {
  const started = performance.now();
  const many = uniqueNames(Array(50_000).fill("Bug"), 100);
  assert.equal(new Set(many.names).size, 50_000);
  assert.deepEqual(many.names.slice(0, 3), ["Bug", "Bug (2)", "Bug (3)"]);
  assert.equal(many.names.at(-1), "Bug (50000)");
  // Names already in the list are never reused, and each blocks one number.
  const blocked = uniqueNames(["Bug", ...Array.from({ length: 1_000 }, (_, i) => `Bug (${i + 2})`), "Bug"], 100);
  assert.equal(blocked.names.at(-1), "Bug (1002)");
  // Long names that differ only at the end share one stem and its numbers.
  const long = Array.from({ length: 20_000 }, (_, i) => `${"x".repeat(95)}${String(i % 10_000).padStart(5, "0")}`);
  const cut = uniqueNames(long, 100);
  assert.equal(new Set(cut.names).size, long.length);
  assert.ok(cut.names.every((name) => Array.from(name).length <= 100));
  assert.equal(cut.renamed.length, 10_000);
  // The quadratic version took several minutes for these.
  const ms = performance.now() - started;
  assert.ok(ms < 2_000, `${Math.round(ms)} ms`);
});

test("each assets/ occurrence costs at most the longest archive path", () => {
  // 1,000 archive paths of distinct lengths, none of them in the text.
  const urls = new Map(Array.from({ length: 1_000 }, (_, i) => [`assets/${"q".repeat(i + 1)}`, `/storage/${i}`]));
  urls.set("assets/hit.png", "/storage/hit");
  const matcher = assetMatcher(urls);
  const text = "assets/".repeat(1_000_000) + "assets/hit.png";
  const hits = new Set();
  const started = performance.now();
  const rewritten = rewriteAssetPaths(text, matcher, hits);
  const ms = performance.now() - started;
  assert.ok(rewritten.endsWith("/storage/hit"));
  assert.equal(rewritten.length, text.length - "assets/hit.png".length + "/storage/hit".length);
  assert.deepEqual([...hits], ["assets/hit.png"]);
  // Trying every path length took about 0.25 ms per occurrence (minutes here).
  assert.ok(ms < 2_000, `${Math.round(ms)} ms`);
});

test("asset paths are rewritten longest first and untouched values are shared", () => {
  const content = [
    { type: "image", props: { url: "assets/a.png" } },
    { type: "paragraph", content: [{ text: "See assets/b.png and assets/a.png" }] },
    { untouched: { deep: ["no files here"] } },
  ];
  const hits = new Set();
  const matcher = assetMatcher(
    new Map([
      ["assets/a.png", "/storage/a"],
      ["assets/c.png", "/storage/c"],
    ]),
  );
  const rewritten = rewriteAssetPaths(content, matcher, hits);
  assert.deepEqual([...hits], ["assets/a.png"]);
  assert.equal(rewritten[0].props.url, "/storage/a");
  assert.equal(rewritten[1].content[0].text, "See assets/b.png and /storage/a");
  assert.equal(rewritten[2], content[2]);
  assert.equal(content[0].props.url, "assets/a.png");
  assert.equal(rewriteAssetPaths(content, assetMatcher(new Map())), content);

  // A shorter archive path never consumes part of a longer one, in either
  // archive order.
  for (const order of [
    ["assets/a", "assets/a.png"],
    ["assets/a.png", "assets/a"],
  ]) {
    const urls = new Map(order.map((p) => [p, `/storage/${p.slice(7)}`]));
    const found = new Set();
    const text = rewriteAssetPaths("x assets/a.png y assets/a z assets/ab", assetMatcher(urls), found);
    assert.equal(text, "x /storage/a.png y /storage/a z /storage/ab");
    assert.deepEqual([...found].sort(), ["assets/a", "assets/a.png"]);
    const only = new Set();
    rewriteAssetPaths(["assets/a.png"], assetMatcher(urls), only);
    assert.deepEqual([...only], ["assets/a.png"]);
  }

  // A "__proto__" member stays an ordinary member.
  const proto = JSON.parse('{"__proto__": "assets/a.png", "x": 1}');
  const out = rewriteAssetPaths(proto, matcher);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(out, "__proto__").value, "/storage/a");
  assert.equal(JSON.stringify(out), '{"__proto__":"/storage/a","x":1}');
});

test("storable text: no U+0000 and no unpaired surrogate", () => {
  assert.equal(isStorableText("plain ü 😀 \t\n"), true);
  assert.equal(isStorableText("a\u0000b"), false);
  assert.equal(isStorableText("a\ud800"), false);
  assert.equal(isStorableText("\udc00b"), false);
  assert.equal(isStorableText("😀"), true);
});

test("validation counts characters as PostgreSQL does and limits JSON depth", () => {
  const space = (pages) => parse({ wikiSpaces: [{ space: { name: "s" }, pages }] });
  const page = (parts) => ({ _originalId: "p", title: "t", position: 0, ...parts });
  // 100 emoji are 200 UTF-16 units but 100 characters.
  validateBackup(parse({ projects: [{ project: { name: "p" }, labels: [{ _originalId: "l", name: "😀".repeat(100), color: "#000" }] }] }));
  assert.throws(
    () => validateBackup(parse({ projects: [{ project: { name: "p" }, labels: [{ _originalId: "l", name: "😀".repeat(101), color: "#000" }] }] })),
    { message: "Invalid backup file: a label name in project 1 is longer than 100 characters" },
  );
  validateBackup(space([page({ content: nested(MAX_RESTORE_JSON_DEPTH) })]));
  assert.throws(() => validateBackup(space([page({ content: nested(MAX_RESTORE_JSON_DEPTH + 1) })])), {
    statusCode: 400,
    message: `Invalid backup file: the content of a page in wiki space 1 is nested more than ${MAX_RESTORE_JSON_DEPTH} levels deep`,
  });
  assert.throws(() => validateBackup(space([page({ content: { "bad\ud800key": 1 } })])), {
    message: "Invalid backup file: the content of a page in wiki space 1 contains a character that cannot be stored",
  });
});

test("the plan resolves references inside their own project and yields parents first", () => {
  const file = parse({
    projects: [
      {
        project: { name: "A" },
        statuses: [{ _originalId: "s", name: "Open", position: 0, isCompletion: false }],
        tasks: [{ _originalId: "t", title: "A", priority: "NONE", position: 0, statusRef: "s" }],
      },
      {
        project: { name: "B" },
        statuses: [{ _originalId: "s", name: "Todo", position: 0, isCompletion: false }],
        tasks: [
          { _originalId: "t", title: "B", priority: "NONE", position: 0, statusRef: "s", dependencies: [{ blockingTaskRef: "u" }] },
          { _originalId: "u", title: "B2", priority: "NONE", position: 1, statusRef: "s" },
        ],
      },
    ],
    wikiSpaces: [
      {
        space: { name: "W" },
        pages: [
          { _originalId: "child", title: "Child", position: 0, parentRef: "root" },
          { _originalId: "root", title: "Root", position: 0 },
        ],
      },
    ],
  });
  validateBackup(file);
  let next = 0;
  const warnings = [];
  const target = {
    workspaceId: "ws",
    adminUserId: "admin",
    members: [],
    takenSlugs: new Set(["w"]),
    nextWikiSpacePosition: 3,
    assetUrls: new Map(),
  };
  const rows = [...planRestore(file, target, mapUsers(file, [], "admin"), () => `id${++next}`, warnings)];
  assert.deepEqual(warnings, []);
  const ids = new Map(rows.map((r) => [r.data.id, r]));
  const seen = new Set();
  for (const row of rows) {
    for (const key of ["projectId", "statusId", "taskId", "blockedTaskId", "blockingTaskId", "spaceId", "parentId"]) {
      const value = row.data[key];
      if (typeof value === "string" && ids.has(value)) assert.ok(seen.has(value), `${row.table}.${key} before its target`);
    }
    seen.add(row.data.id);
  }
  const byTable = (table) => rows.filter((r) => r.table === table).map((r) => r.data);
  const [projectA, projectB] = byTable("project");
  const [statusA, statusB] = byTable("statusColumn");
  const tasks = byTable("task");
  assert.deepEqual(tasks.map((t) => [t.title, t.projectId, t.statusId]), [
    ["A", projectA.id, statusA.id],
    ["B", projectB.id, statusB.id],
    ["B2", projectB.id, statusB.id],
  ]);
  assert.deepEqual(byTable("taskDependency").map((d) => [d.blockedTaskId, d.blockingTaskId]), [[tasks[1].id, tasks[2].id]]);
  const [space] = byTable("wikiSpace");
  assert.deepEqual([space.slug, space.position], ["w-2", 3]);
  const pages = byTable("wikiPage");
  assert.deepEqual(pages.map((p) => [p.title, p.parentId]), [
    ["Root", null],
    ["Child", pages[0].id],
  ]);
  const counts = emptyCounts();
  for (const row of rows) counts[row.table]++;
  assert.equal(counts.task, 3);
});
