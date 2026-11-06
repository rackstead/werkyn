// Chromium measurement and smoke test for a long Drive folder
// (docs/remediation/p01c.md). Run from packages/backend with a migrated,
// disposable loopback database whose name starts with werkyn_audit_ and an
// installed PLAYWRIGHT_MODULE (package name or absolute module path):
//
//   TEST_DATABASE_URL=... PLAYWRIGHT_MODULE=... \
//     node --import tsx tests/browser/drive-folder-windowing.mjs
//
// DRIVE_DIST     an already built frontend dist; otherwise one is built into
//                a temporary directory first
// DRIVE_MODE     "measure" (timings only, also usable against builds that
//                render every row), "smoke" (behaviour checks of the
//                windowed folder views) or "all" (default)
// DRIVE_FILES    entries in the long folder, folders included (default 5000)
// DRIVE_RUNS     measured runs per view, each in a fresh browser context
//                (default 3)
// DRIVE_VIEWS    views to measure, comma-separated (list, grid; both by
//                default)
// DRIVE_STEPS    smoke steps to run, comma-separated (see SMOKE_STEPS);
//                all by default
// DRIVE_REPORT   path for the JSON report
// DRIVE_LOAD_SECONDS  how long loading every page of the folder may take
//                (default 600)
// DRIVE_KNOWN_431  "1" for a build that asks for the share status of every
//                loaded entry in one URL: its 431 answers are counted
//                (report.shareStatus) instead of failing the run
// DRIVE_COMPARE  "1" to record the "anchor" step's results in the report
//                instead of failing on them (to compare another build)
// CHROMIUM_EXECUTABLE  a Chromium binary other than Playwright's own
//
// The fixture adds its own users, workspace and team folder and deletes them
// at the end. Only loopback traffic is allowed; other requests are aborted.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import bcrypt from "bcrypt";

const database = new URL(process.env.TEST_DATABASE_URL ?? "invalid:");
assert(["127.0.0.1", "localhost"].includes(database.hostname));
assert.match(database.pathname, /^\/werkyn_audit_/);
Object.assign(process.env, {
  DATABASE_URL: database.toString(),
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "drive-window-browser-fixture-jwt-secret",
  COOKIE_SECRET: "drive-window-browser-fixture-cookie-secret",
  COOKIE_SECURE: "false",
  COOKIE_SAMESITE: "lax",
});
const MODE = process.env.DRIVE_MODE ?? "all";
assert(["measure", "smoke", "all"].includes(MODE));
const ENTRIES = Number(process.env.DRIVE_FILES ?? "5000");
const RUNS = Number(process.env.DRIVE_RUNS ?? "3");
assert(ENTRIES >= 400 && ENTRIES <= 20_000 && RUNS >= 1 && RUNS <= 10);
const VIEWS = (process.env.DRIVE_VIEWS ?? "list,grid").split(",");
assert(VIEWS.every((v) => ["list", "grid"].includes(v)));
const VIEWPORT = { width: 1440, height: 900 };
// Folders in the long folder (listed first); the rest are files.
const FOLDERS = 200;
// Files in the owner's own Drive root.
const PERSONAL = 400;

const scratch = await mkdtemp(path.join(os.tmpdir(), "werkyn-drive-window-"));
process.env.STORAGE_DIR = path.join(scratch, "storage");
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const frontend = path.resolve(import.meta.dirname, "../../../frontend");
const { build, preview } = await import(
  pathToFileURL(path.join(frontend, "node_modules/vite/dist/node/index.js"))
);
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");

const report = {
  mode: MODE,
  entries: ENTRIES,
  runs: {},
  summary: {},
  smoke: [],
  errors: [],
  shareStatus: { requests: 0, maxIds: 0, status431: 0, other: [] },
};
// Set for a baseline build whose share-status requests are known to fail
// with 431 in a long folder.
const KNOWN_431 = process.env.DRIVE_KNOWN_431 === "1";
// Set to record, not assert, the "anchor" step's results (for comparing
// another build).
const COMPARE = process.env.DRIVE_COMPARE === "1";
const log = (...args) => console.error("[drive-window]", ...args);

// ─── Fixture ────────────────────────────────────────────────

let seed = 20261105;
function rand() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const WORDS = [
  "invoice", "migration", "onboarding", "billing", "dashboard", "export",
  "report", "budget", "contract", "minutes", "roadmap", "design", "audit",
];
const pick = (items) => items[Math.floor(rand() * items.length)];
const folderName = (i) => `Folder ${String(i).padStart(4, "0")}`;
const fileName = (i) => `File ${String(i).padStart(5, "0")}`;

// Records what the fixture has written so far, so a failure part-way
// through setup is cleaned up too.
const created = { userIds: [], workspaceId: null };

async function createFixture(prisma) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const password = "Drive-window-browser-password";
  const passwordHash = await bcrypt.hash(password, 10);
  const owner = await prisma.user.create({
    data: {
      email: `drive-owner-${suffix}@fixture.invalid`,
      passwordHash,
      displayName: "Drive Owner",
      emailVerified: true,
    },
  });
  created.userIds.push(owner.id);
  const other = await prisma.user.create({
    data: {
      email: `drive-other-${suffix}@fixture.invalid`,
      passwordHash,
      displayName: "Drive Colleague",
      emailVerified: true,
    },
  });
  created.userIds.push(other.id);
  const workspace = await prisma.workspace.create({
    data: {
      name: "Drive window fixture",
      slug: `drive-window-${suffix}`,
      members: {
        create: [
          { userId: owner.id, role: "ADMIN" },
          { userId: other.id, role: "ADMIN" },
        ],
      },
    },
  });
  created.workspaceId = workspace.id;
  const root = await prisma.file.create({
    data: {
      workspaceId: workspace.id,
      name: "Long folder",
      isFolder: true,
      uploadedById: owner.id,
    },
  });
  const teamFolder = await prisma.teamFolder.create({
    data: {
      workspaceId: workspace.id,
      folderId: root.id,
      name: "Long folder",
      members: { create: [{ userId: owner.id }, { userId: other.id }] },
    },
  });
  const inTeam = { workspaceId: workspace.id, teamFolderId: teamFolder.id };
  const entries = [];
  const base = Date.UTC(2026, 9, 1);
  for (let i = 0; i < ENTRIES; i++) {
    const isFolder = i < FOLDERS;
    const n = isFolder ? i : i - FOLDERS;
    // Every 37th file has a long name that the views cut off.
    const name = isFolder
      ? folderName(n)
      : `${fileName(n)} ${n % 37 === 0 ? `${pick(WORDS)} `.repeat(14).trim() : pick(WORDS)}.txt`;
    entries.push({
      id: `dw${suffix}${String(i).padStart(6, "0")}`,
      ...inTeam,
      parentId: root.id,
      name,
      isFolder,
      mimeType: isFolder ? null : "text/plain",
      size: isFolder ? null : BigInt(100 + Math.floor(rand() * 5_000_000)),
      storagePath: null,
      uploadedById: rand() < 0.5 ? owner.id : other.id,
      createdAt: new Date(base + i * 1000),
      updatedAt: new Date(base + Math.floor(rand() * 30 * 86_400_000)),
    });
  }
  for (let i = 0; i < entries.length; i += 2000)
    await prisma.file.createMany({ data: entries.slice(i, i + 2000) });
  // Nested content: three files in each of the first 20 folders, and a
  // folder inside the first one.
  const nested = [];
  for (let f = 0; f < 20; f++)
    for (let k = 0; k < 3; k++)
      nested.push({
        id: `dn${suffix}${String(f * 3 + k).padStart(6, "0")}`,
        ...inTeam,
        parentId: entries[f].id,
        name: `Nested ${f}-${k}.txt`,
        isFolder: false,
        mimeType: "text/plain",
        size: BigInt(1000 + k),
        uploadedById: owner.id,
      });
  nested.push({
    id: `dn${suffix}inner`,
    ...inTeam,
    parentId: entries[0].id,
    name: "Inner folder",
    isFolder: true,
    uploadedById: owner.id,
  });
  await prisma.file.createMany({ data: nested });
  // The owner's own Drive: enough files that its "My Files" list scrolls
  // below the Starred and Recent sections.
  const personal = Array.from({ length: PERSONAL }, (_, i) => ({
    id: `dp${suffix}${String(i).padStart(6, "0")}`,
    workspaceId: workspace.id,
    ownerId: owner.id,
    name: `Personal ${String(i).padStart(4, "0")}.txt`,
    isFolder: false,
    mimeType: "text/plain",
    size: BigInt(2000 + i),
    uploadedById: owner.id,
  }));
  await prisma.file.createMany({ data: personal });
  return {
    suffix,
    password,
    owner,
    other,
    workspace,
    root,
    teamFolder,
    entries,
  };
}

// Entries of the long folder in the order the Drive lists them by name.
async function listedOrder(prisma, fixture) {
  const rows = await prisma.file.findMany({
    where: { parentId: fixture.root.id, trashedAt: null },
    orderBy: [{ isFolder: "desc" }, { name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, isFolder: true },
  });
  return rows;
}

// ─── Browser helpers ────────────────────────────────────────

const folderPath = (f, view) =>
  `/${f.workspace.slug}/drive?section=drive&folderId=${f.root.id}&teamFolderId=${f.teamFolder.id}&view=${view}`;

async function openContext(browser, origin, fixture) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  // Fonts and anything else off the loopback origin are not fetched, so
  // every run uses the same fallback fonts.
  await context.route(
    (url) => url.origin !== origin,
    (route) => route.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => {
    report.errors.push(`pageerror: ${error.message}`);
    log("page error", error.message);
  });
  // Recent API requests with their outcome, for failure reports.
  const recent = [];
  const note = (request, outcome) => {
    if (!request.url().includes("/api/")) return;
    recent.push(`${request.method()} ${new URL(request.url()).pathname.slice(-48)} ${outcome}`);
    if (recent.length > 30) recent.shift();
  };
  page.on("requestfinished", async (request) => note(request, (await request.response())?.status()));
  page.on("requestfailed", (request) => note(request, request.failure()?.errorText));
  page.recentRequests = recent;
  // Folder listing responses, in arrival order (each page of 50 entries).
  const pages = [];
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith("/files/share-status")) {
      report.shareStatus.requests++;
      report.shareStatus.maxIds = Math.max(
        report.shareStatus.maxIds,
        (url.searchParams.get("fileIds") ?? "").split(",").length,
      );
      if (response.status() === 431) report.shareStatus.status431++;
      else if (response.status() !== 200) report.shareStatus.other.push(response.status());
    }
    if (
      response.request().method() !== "GET" ||
      !/\/api\/workspaces\/[^/]+\/files$/.test(url.pathname) ||
      url.searchParams.get("parentId") !== fixture.root.id
    )
      return;
    const entry = { at: Date.now(), cursor: url.searchParams.get("cursor"), status: response.status() };
    pages.push(entry);
    try {
      const body = await response.json();
      entry.count = body.data.length;
      entry.nextCursor = body.nextCursor;
    } catch {
      entry.failed = true;
    }
  });
  await page.goto(`${origin}/login`);
  await page.getByLabel("Email").fill(fixture.owner.email);
  await page.getByLabel("Password").fill(fixture.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  // Console errors count from here on: the signed-out session check on the
  // login page is an expected 401.
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // Aborted off-origin font requests are expected.
    if (/net::ERR_FAILED/.test(text)) return;
    // Builds that ask for the share status of every loaded entry in one
    // URL get 431 once the folder has some 600 entries loaded; counted
    // separately (see shareStatus431 in the report).
    if (KNOWN_431 && /status of 431/.test(text)) return;
    report.errors.push(`console: ${text}`);
    log("console error", text);
  });
  return { context, page, pages };
}

async function metrics(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

const median = (values) => {
  const sorted = [...values].filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// In-page helpers, installed once per document. They find entries by their
// visible name, so they work for builds that render every row and for the
// windowed build alike.
async function installHelpers(page) {
  await page.evaluate(() => {
    if (window.__drive) return;
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        window.__longTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: "longtask" });
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const nameOf = (el) =>
      (el.querySelector("span[title]") ?? el.querySelector("td span.truncate"))?.textContent ?? null;
    window.__drive = {
      frame,
      frames: async (n = 2) => {
        for (let i = 0; i < n; i++) await frame();
      },
      scroller() {
        const content = document.querySelector("table, [data-drive-grid], .grid.gap-3");
        return content?.closest(".overflow-y-auto") ?? null;
      },
      // Rendered entries (table rows or grid cards) with their names.
      entries() {
        const rows = [...document.querySelectorAll("table tbody tr")];
        const cards = [...document.querySelectorAll("[data-drive-card], .grid.gap-3 > div")];
        return [...rows, ...cards]
          .map((el) => ({ el, name: nameOf(el) }))
          .filter((e) => e.name);
      },
      // Entries intersecting the view, top to bottom, with their top relative
      // to the view.
      inView() {
        const s = this.scroller();
        const view = s.getBoundingClientRect();
        return this.entries()
          .map(({ el, name }) => {
            const r = el.getBoundingClientRect();
            return { name, top: r.top - view.top, left: r.left, bottom: r.bottom - view.top, height: r.height };
          })
          .filter((e) => e.bottom > 0 && e.top < view.height)
          .sort((a, b) => a.top - b.top || a.left - b.left);
      },
      quiet(ms = 2000) {
        const last = window.__longTasks.at(-1);
        const quietSince = last ? last.start + last.duration : 0;
        return performance.now() - quietSince > ms;
      },
      longTasksSince(from) {
        const tasks = window.__longTasks.filter((t) => t.start >= from);
        return {
          longTasks: tasks.length,
          longTaskMs: tasks.reduce((n, t) => n + t.duration, 0),
          blockingMs: tasks.reduce((n, t) => n + Math.max(0, t.duration - 50), 0),
          longestTaskMs: Math.max(0, ...tasks.map((t) => t.duration)),
        };
      },
    };
  });
}

async function settle(page, ms = 1500) {
  await page.waitForFunction((ms) => window.__drive.quiet(ms), ms, {
    polling: 250,
    timeout: 300_000,
  });
}

// Scrolls to the end until the last listing page has arrived and is shown.
async function loadAll(page, pages, lastName) {
  const from = await page.evaluate(() => performance.now());
  const deadline = Date.now() + (Number(process.env.DRIVE_LOAD_SECONDS) || 600) * 1000;
  for (let i = 0; ; i++) {
    if (Date.now() > deadline) {
      const state = await page.evaluate(() => {
        const s = window.__drive.scroller();
        const v = s.getBoundingClientRect();
        const last = s.lastElementChild;
        const blocks = [...(s.querySelector("table, .grid.gap-3")?.parentElement?.children ?? [])].map((e) => {
          const r = e.getBoundingClientRect();
          return { tag: e.tagName, cls: e.className.slice(0, 40), top: r.top - v.top, height: r.height };
        });
        return { scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, blocks, last: last?.tagName };
      });
      assert.fail(`loading every page: ${pages.length} pages, last ${JSON.stringify(pages.at(-1))}, view ${JSON.stringify(state)}`);
    }
    const before = pages.length;
    // The last listing response ends the folder (a refetch can end with
    // entries left for the next page).
    const done = pages.at(-1)?.nextCursor === null;
    const shown = await page.evaluate(async (lastName) => {
      const d = window.__drive;
      const s = d.scroller();
      s.scrollTop = s.scrollHeight;
      await d.frames(2);
      return d.entries().some((e) => e.name.startsWith(lastName));
    }, lastName);
    if (done && shown) break;
    // Wait for the next page to arrive (the end of the list came into view),
    // scrolling to the end again meanwhile, as a user would: a scroll made
    // just before the previous page rendered left the end out of view.
    const next = Date.now() + (done ? 100 : 15_000);
    for (let n = 1; pages.length === before && Date.now() < next; n++) {
      await page.waitForTimeout(5);
      // Every 200 ms: away from the end and back, so the end comes into view
      // again even when the view already was at the end.
      if (n % 40 === 0)
        await page.evaluate(async () => {
          const d = window.__drive;
          const s = d.scroller();
          s.scrollTop = s.scrollHeight - s.clientHeight - 400;
          await d.frames(2);
          s.scrollTop = s.scrollHeight;
        });
    }
  }
  const at = await page.evaluate(() => performance.now());
  return { from, ms: at - from };
}

// ─── Measurement ────────────────────────────────────────────

async function measureRun(browser, origin, fixture, view, run) {
  const { context, page, pages } = await openContext(browser, origin, fixture);
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
    // Start on the (empty) personal Drive, then open the team folder from
    // the sidebar in the same document, as a user does.
    await page.goto(`${origin}/${fixture.workspace.slug}/drive?section=drive&view=${view}`);
    await page.waitForLoadState("networkidle");
    await installHelpers(page);
    await cdp.send("HeapProfiler.collectGarbage");
    const before = await metrics(cdp);
    const start = await page.evaluate(() => performance.now());
    await page.getByRole("button", { name: "Long folder" }).click();
    const firstAt = await page.waitForFunction(
      () =>
        [...document.querySelectorAll("span")].some((s) => s.textContent === "Folder 0000")
          ? performance.now()
          : false,
      undefined,
      { polling: "raf", timeout: 120_000 },
    );
    const firstShown = await firstAt.jsonValue();
    await settle(page);
    const afterOpen = await metrics(cdp);
    const open = await page.evaluate(
      ({ start }) => ({
        ...window.__drive.longTasksSince(start),
        domElements: document.getElementsByTagName("*").length,
      }),
      { start },
    );

    // Load every page by scrolling to the end, as a user reading the whole
    // folder does (each page is 50 entries).
    const lastName = fileName(ENTRIES - FOLDERS - 1);
    const loadBefore = await metrics(cdp);
    const load = await loadAll(page, pages, lastName);
    await settle(page);
    const loadAfter = await metrics(cdp);
    const loaded = await page.evaluate(
      ({ from }) => ({
        ...window.__drive.longTasksSince(from),
        domElements: document.getElementsByTagName("*").length,
        entriesInDom: window.__drive.entries().length,
        viewWidth: window.__drive.scroller().clientWidth,
        contentWidth: window.__drive.scroller().scrollWidth,
        controls: document.querySelectorAll(
          "table button, table input, [data-drive-card] button, [data-drive-card] input, .grid.gap-3 button, .grid.gap-3 input",
        ).length,
      }),
      { from: load.from },
    );
    await cdp.send("HeapProfiler.collectGarbage");
    const settledMemory = await metrics(cdp);
    const dom = await cdp.send("Memory.getDOMCounters");

    // Scroll: from the top, 120 px per frame for 240 frames, then jumps to
    // the middle and the end.
    const scrollBefore = await metrics(cdp);
    const scroll = await page.evaluate(async () => {
      const d = window.__drive;
      const s = d.scroller();
      s.scrollTop = 0;
      await d.frames(3);
      const from = performance.now();
      const frames = [];
      let last = from;
      await new Promise((resolve) => {
        let n = 0;
        const step = (now) => {
          frames.push(now - last);
          last = now;
          if (n++ >= 240) return resolve();
          s.scrollBy(0, 120);
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      const jumps = [];
      for (const fraction of [0.5, 1]) {
        const t0 = performance.now();
        s.scrollTop = fraction * (s.scrollHeight - s.clientHeight);
        await d.frames(2);
        const rect = s.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        jumps.push({
          fraction,
          ms: performance.now() - t0,
          entryAtCenter: !!hit?.closest("tbody tr, [data-drive-card], .grid.gap-3 > div"),
        });
      }
      const sorted = frames.slice(1).sort((a, b) => a - b);
      return {
        frames: sorted.length,
        meanFrameMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
        p95FrameMs: sorted[Math.floor(sorted.length * 0.95)],
        maxFrameMs: sorted.at(-1),
        framesOver50Ms: sorted.filter((f) => f > 50).length,
        ...d.longTasksSince(from),
        jumps,
        scrollHeight: s.scrollHeight,
      };
    });
    const scrollAfter = await metrics(cdp);

    // Select one entry in the middle of the folder: time until its box is
    // checked and the bulk bar shows "1 selected".
    const select = await page.evaluate(async () => {
      const d = window.__drive;
      const s = d.scroller();
      s.scrollTop = (s.scrollHeight - s.clientHeight) / 2;
      await d.frames(3);
      const target = d
        .entries()
        .find(({ el }) => {
          const r = el.getBoundingClientRect();
          const v = s.getBoundingClientRect();
          return r.top > v.top + 100 && r.bottom < v.bottom - 100;
        });
      const box = target.el.querySelector('input[type="checkbox"]');
      const t0 = performance.now();
      box.click();
      for (;;) {
        await d.frame();
        const bar = [...document.querySelectorAll("span")].some((x) => x.textContent === "1 selected");
        if (box.isConnected && box.checked && bar) break;
        if (performance.now() - t0 > 60_000) throw new Error("selection not shown");
      }
      const shownMs = performance.now() - t0;
      box.click();
      for (;;) {
        await d.frame();
        if (!box.checked) break;
      }
      return { shownMs, name: target.name };
    });

    // Start dragging a file (8 px activation distance), time until the drag
    // preview shows, then cancel with Escape.
    let drag = null;
    if (view === "list") {
      const box = await page.evaluate(() => {
        const d = window.__drive;
        const s = d.scroller();
        const v = s.getBoundingClientRect();
        const target = d.entries().find(({ el }) => {
          const r = el.getBoundingClientRect();
          return r.top > v.top + 100 && r.bottom < v.bottom - 100;
        });
        // On the name, right of the icon (main's table can be wider than
        // the view when a long name is loaded).
        const r = target.el.querySelector("td").getBoundingClientRect();
        return { x: r.left + 80, y: r.top + r.height / 2, name: target.name };
      });
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      const t0 = await page.evaluate(() => performance.now());
      await page.mouse.move(box.x + 12, box.y + 12, { steps: 2 });
      const shownAt = await page.waitForFunction(
        () =>
          document.querySelector(".shadow-lg span.truncate.max-w-48") ? performance.now() : false,
        undefined,
        { polling: "raf", timeout: 60_000 },
      );
      drag = { startShownMs: (await shownAt.jsonValue()) - t0 };
      const t1 = await page.evaluate(() => performance.now());
      await page.mouse.move(box.x + 12, box.y + 200, { steps: 10 });
      const moved = await page.evaluate(() => performance.now());
      drag.move10StepsMs = moved - t1;
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await page.waitForFunction(() => !document.querySelector(".shadow-lg span.truncate.max-w-48"));
      // dnd-kit swallows clicks until 50 ms after a drag ends.
      await page.waitForTimeout(200);
    }

    // A refresh of the folder: star an entry in view. The star invalidates
    // the folder's listing, which refetches every loaded page; time until
    // the star shows, and the long tasks while the pages are refetched and
    // shown.
    let refresh = null;
    if (view === "list") {
      const pagesBefore = pages.length;
      const target = await page.evaluate(() => {
        const d = window.__drive;
        const s = d.scroller();
        const v = s.getBoundingClientRect();
        const t = d.entries().find(({ el }) => {
          const r = el.getBoundingClientRect();
          return r.top > v.top + 100 && r.bottom < v.bottom - 100 && el.querySelector('button[title="Star"]');
        });
        return t.name;
      });
      const t0 = await page.evaluate(() => performance.now());
      await page.evaluate((name) => {
        const t = window.__drive.entries().find((e) => e.name === name);
        t.el.querySelector('button[title="Star"]').click();
      }, target);
      const shownAt = await page
        .waitForFunction(
          (name) => {
            const t = window.__drive.entries().find((e) => e.name === name);
            return t?.el.querySelector('button[title="Unstar"]') ? performance.now() : false;
          },
          target,
          { polling: "raf", timeout: 120_000 },
        )
        .catch(async (error) => {
          const state = await page.evaluate((name) => {
            const t = window.__drive.entries().find((e) => e.name === name);
            const s = window.__drive.scroller();
            return {
              rendered: !!t,
              buttons: t ? [...t.el.querySelectorAll("button[title]")].map((b) => b.title) : null,
              scrollTop: s.scrollTop,
              entries: window.__drive.entries().length,
            };
          }, target);
          throw new Error(
            `${error.message}; ${target}: ${JSON.stringify(state)}; pages since: ${pages.length - pagesBefore}; requests: ${JSON.stringify(page.recentRequests)}`,
          );
        });
      const shown = await shownAt.jsonValue();
      await settle(page);
      refresh = {
        shownMs: shown - t0,
        pagesRefetched: pages.length - pagesBefore,
        ...(await page.evaluate((t0) => window.__drive.longTasksSince(t0), t0)),
      };
    }

    const result = {
      run,
      view,
      open: {
        firstEntriesShownMs: firstShown - start,
        ...open,
        scriptMs: (afterOpen.ScriptDuration - before.ScriptDuration) * 1000,
      },
      loadAll: {
        ms: load.ms,
        pages: pages.length,
        ...loaded,
        scriptMs: (loadAfter.ScriptDuration - loadBefore.ScriptDuration) * 1000,
        layoutMs: (loadAfter.LayoutDuration - loadBefore.LayoutDuration) * 1000,
        styleMs: (loadAfter.RecalcStyleDuration - loadBefore.RecalcStyleDuration) * 1000,
      },
      dom: { nodes: dom.nodes, jsEventListeners: dom.jsEventListeners },
      memory: { jsHeapUsedMB: settledMemory.JSHeapUsedSize / 1048576 },
      scroll: {
        ...scroll,
        scriptMs: (scrollAfter.ScriptDuration - scrollBefore.ScriptDuration) * 1000,
        layoutMs: (scrollAfter.LayoutDuration - scrollBefore.LayoutDuration) * 1000,
        styleMs: (scrollAfter.RecalcStyleDuration - scrollBefore.RecalcStyleDuration) * 1000,
      },
      select,
      drag,
      refresh,
    };
    log(`${view} run ${run}`, JSON.stringify(result));
    return result;
  } finally {
    await context.close();
  }
}

function summarize(runs) {
  const at = (p) => runs.map((r) => p.split(".").reduce((o, k) => o?.[k], r));
  const paths = [
    "open.firstEntriesShownMs",
    "open.blockingMs",
    "loadAll.ms",
    "loadAll.longTaskMs",
    "loadAll.blockingMs",
    "loadAll.longestTaskMs",
    "loadAll.scriptMs",
    "loadAll.domElements",
    "loadAll.entriesInDom",
    "loadAll.controls",
    "dom.nodes",
    "dom.jsEventListeners",
    "memory.jsHeapUsedMB",
    "scroll.meanFrameMs",
    "scroll.p95FrameMs",
    "scroll.maxFrameMs",
    "scroll.framesOver50Ms",
    "scroll.longTaskMs",
    "select.shownMs",
    "drag.startShownMs",
    "drag.move10StepsMs",
    "refresh.shownMs",
    "refresh.longTaskMs",
    "refresh.longestTaskMs",
  ];
  return Object.fromEntries(paths.map((p) => [p, median(at(p))]));
}

// ─── Smoke ──────────────────────────────────────────────────

const SMOKE_STEPS = [
  "structure",
  "anchor",
  "bulk",
  "selection",
  "keyboard",
  "menu",
  "drag",
  "upload",
  "grid",
  "above",
  "block",
  "resize",
  "rate",
];
// Rows in view may move by at most this much (CSS pixels) through a change
// above them.
const STILL = 1;

async function smoke({ browser, origin, fixture, prisma }) {
  const steps = (process.env.DRIVE_STEPS ?? SMOKE_STEPS.join(",")).split(",");
  assert(steps.every((step) => SMOKE_STEPS.includes(step)), "unknown step");
  const checks = [];
  const pass = (step, label, detail = {}) => {
    checks.push({ step, label, ...detail });
    log("ok", step, label, JSON.stringify(detail));
  };
  const token = () => signAccessToken({ sub: fixture.other.id, email: fixture.other.email });
  const wid = fixture.workspace.id;
  // A colleague's change, through the API.
  async function colleague(method, url, body) {
    const response = await fetch(`${fixture.apiOrigin}/api/workspaces/${wid}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token()}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) assert.fail(`${method} ${url}: ${response.status} ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }
  const order = () => listedOrder(prisma, fixture);
  const subfolder = async (name) =>
    prisma.file.findFirstOrThrow({ where: { parentId: fixture.root.id, name } });

  const { context, page, pages } = await openContext(browser, origin, fixture);
  try {
    await page.goto(`${origin}${folderPath(fixture, "list")}`);
    await installHelpers(page);
    await page.waitForFunction(() => window.__drive.entries().length > 10);
    await loadAll(page, pages, fileName(ENTRIES - FOLDERS - 1));
    await settle(page, 500);

    // Waits until a refetch of the folder that started after `from` pages
    // has ended (pages are refetched one after another; none for 700 ms),
    // and the result is shown.
    async function refetched(from) {
      const deadline = Date.now() + 120_000;
      while (pages.length === from || Date.now() - pages.at(-1).at < 700) {
        assert(Date.now() < deadline, "refetch did not end");
        await page.waitForTimeout(20);
      }
      await page.evaluate(() => window.__drive.frames(3));
      await page.waitForTimeout(200);
      await page.evaluate(() => window.__drive.frames(2));
    }
    // A refresh the user starts: star (or unstar) an entry in view that is
    // not under the pointer. Starring refetches every loaded page of the
    // folder, which brings colleagues' changes along.
    async function refresh(avoid) {
      const from = pages.length;
      const starred = await page.evaluate((avoid) => {
        const d = window.__drive;
        const inView = d.inView().filter((e) => e.name !== avoid && e.top > 0);
        const target = d.entries().find((e) => e.name === inView.at(-1).name);
        target.el.querySelector('button[title="Star"], button[title="Unstar"]').click();
        return target.name;
      }, avoid);
      await refetched(from);
      return starred;
    }
    async function scrollTo(where) {
      return page.evaluate(async (where) => {
        const d = window.__drive;
        const s = d.scroller();
        const max = s.scrollHeight - s.clientHeight;
        s.scrollTop =
          where === "end" ? max : where === "near-end" ? max - 20 : typeof where === "number" ? where : max / 2;
        await d.frames(3);
        return { scrollTop: s.scrollTop, max };
      }, where);
    }
    // The entry under a point in the middle of the view, and the point on
    // its checkbox where the pointer rests.
    async function restingPoint() {
      return page.evaluate(() => {
        const d = window.__drive;
        const s = d.scroller();
        const v = s.getBoundingClientRect();
        const y = v.top + v.height / 2;
        const target = d.entries().find(({ el }) => {
          const r = el.getBoundingClientRect();
          return r.top <= y && r.bottom > y;
        });
        const box = target.el.querySelector('input[type="checkbox"]').getBoundingClientRect();
        return { name: target.name, x: box.left + box.width / 2, y: box.top + box.height / 2 };
      });
    }
    const inView = () => page.evaluate(() => window.__drive.inView());
    function moved(before, after) {
      const tops = new Map(after.map((e) => [e.name, e.top]));
      const deltas = before.filter((e) => tops.has(e.name)).map((e) => tops.get(e.name) - e.top);
      return {
        compared: deltas.length,
        maxMove: Math.max(0, ...deltas.map(Math.abs)),
      };
    }
    // Clicks the resting point and returns the entry whose box got checked;
    // clicks it again to clear the selection.
    async function clickAt(point) {
      await page.mouse.move(point.x, point.y);
      await page.mouse.click(point.x, point.y);
      const checked = await page.evaluate(() =>
        window.__drive
          .entries()
          .filter(({ el }) => el.querySelector('input[type="checkbox"]')?.checked)
          .map((e) => e.name),
      );
      await page.mouse.click(point.x, point.y);
      await page
        .waitForFunction(
          () => ![...document.querySelectorAll("span")].some((x) => /^\d+ selected$/.test(x.textContent)),
          undefined,
          { timeout: 10_000 },
        )
        .catch(async (error) => {
          const state = await page.evaluate((point) => {
            const hit = document.elementFromPoint(point.x, point.y);
            return {
              hit: `${hit?.tagName}.${String(hit?.className).slice(0, 60)}`,
              row: window.__drive.entries().find(({ el }) => el.contains(hit))?.name ?? null,
              checked: window.__drive
                .entries()
                .filter(({ el }) => el.querySelector('input[type="checkbox"]')?.checked)
                .map((e) => e.name),
            };
          }, point);
          throw new Error(`${error.message}; first click checked ${JSON.stringify(checked)}; now ${JSON.stringify(state)}`);
        });
      return checked;
    }
    // Entries in view are a run of the listing, in its order, touching each
    // other, with no blank space between the top of the view and the last
    // entry.
    async function structure(label) {
      const expected = (await order()).map((e) => e.name);
      const result = await page.evaluate(() => {
        const d = window.__drive;
        const s = d.scroller();
        const v = s.getBoundingClientRect();
        const rows = d.inView();
        const gaps = rows.slice(1).map((r, i) => r.top - rows[i].bottom);
        const blank = [];
        const last = rows.at(-1).bottom;
        for (let y = Math.max(0, rows[0].top) + 5; y < Math.min(v.height, last) - 2; y += 23) {
          const hit = document.elementFromPoint(v.left + 200, v.top + y);
          if (!hit?.closest("[data-anchor-key], tbody tr, [data-drive-card]")) blank.push(y);
        }
        const table = document.querySelector("table");
        return {
          names: rows.map((r) => r.name),
          maxGap: Math.max(0, ...gaps.map(Math.abs)),
          blank,
          rendered: d.entries().length,
          viewWidth: s.clientWidth,
          contentWidth: s.scrollWidth,
          headerWidths: table ? [...table.tHead.rows[0].cells].map((c) => Math.round(c.getBoundingClientRect().width)) : null,
          bodyWidths: table
            ? [...table.tBodies[0].rows].find((r) => r.dataset.anchorKey)
                ? [...[...table.tBodies[0].rows].find((r) => r.dataset.anchorKey).cells].map((c) => Math.round(c.getBoundingClientRect().width))
                : null
            : null,
        };
      });
      const start = expected.indexOf(result.names[0]);
      assert(start >= 0, `${label}: first entry ${result.names[0]} is listed`);
      assert.deepEqual(result.names, expected.slice(start, start + result.names.length), `${label}: order`);
      assert(result.maxGap <= 1, `${label}: entries touch (${result.maxGap})`);
      assert.deepEqual(result.blank, [], `${label}: no blank space`);
      assert(result.contentWidth <= result.viewWidth, `${label}: no sideways overflow`);
      if (result.headerWidths) assert.deepEqual(result.headerWidths, result.bodyWidths, `${label}: columns`);
      return { firstIndex: start, inView: result.names.length, rendered: result.rendered };
    }

    if (steps.includes("structure")) {
      log("step", "structure");
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        const at = await page.evaluate(async (fraction) => {
          const d = window.__drive;
          const s = d.scroller();
          s.scrollTop = fraction * (s.scrollHeight - s.clientHeight);
          await d.frames(3);
          return s.scrollTop;
        }, fraction);
        pass("structure", `at ${fraction * 100}%`, { scrollTop: at, ...(await structure(`${fraction}`)) });
      }
      const rowHeight = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("tbody tr[data-anchor-key]")];
        return rows.slice(0, 5).map((r) => r.getBoundingClientRect().height);
      });
      pass("structure", "row heights", { rowHeight });
    }

    if (steps.includes("anchor")) {
      log("step", "anchor");
      // A colleague's change above the view, shown by the next refresh: the
      // entries in view stay where they are, and a click where the pointer
      // rests lands on the entry that was there.
      const nested = await prisma.file.findMany({
        where: { parentId: { in: fixture.entries.slice(0, 20).map((e) => e.id) }, isFolder: false },
        orderBy: { name: "asc" },
      });
      let created = 0;
      const changes = {
        create: async () => {
          for (let i = 0; i < 3; i++)
            await colleague("POST", "/files/folder", {
              name: `Folder 0000 new ${++created}`,
              parentId: fixture.root.id,
              teamFolderId: fixture.teamFolder.id,
            });
        },
        delete: async (view) => {
          // Two entries a little above the view.
          const listed = await order();
          const first = listed.findIndex((e) => e.name === view[0].name);
          for (const e of listed.slice(Math.max(0, first - 40), first - 38))
            await colleague("PATCH", `/files/${e.id}`, { trashedAt: new Date().toISOString() });
        },
        "move-out": async (view) => {
          const listed = await order();
          const first = listed.findIndex((e) => e.name === view[0].name);
          const target = await subfolder("Folder 0001");
          await colleague("PATCH", `/files/${listed[first - 60].id}`, { parentId: target.id });
        },
        "move-in": async () => {
          const file = nested.shift();
          await colleague("PATCH", `/files/${file.id}`, {
            parentId: fixture.root.id,
            name: `File 00000 moved in ${file.name}`,
          });
        },
        "move-up": async (view) => {
          // An entry below the view is renamed so that it sorts above it.
          const listed = await order();
          const last = listed.findIndex((e) => e.name === view.at(-1).name);
          const below = listed[last + 30];
          await colleague("PATCH", `/files/${below.id}`, { name: `File 00000 renamed ${below.name}` });
        },
      };
      const plan = [
        ["middle", ["create", "delete", "move-out", "move-in", "move-up"]],
        ["end", ["create", "delete", "move-out", "move-in"]],
        ["near-end", ["delete", "create", "move-out", "move-in"]],
      ];
      for (const [where, kinds] of plan) {
        for (const kind of kinds) {
          // Every page loaded again (a refetch can leave the last entries for
          // the next page), then the position.
          await loadAll(page, pages, "");
          const at = await scrollTo(where);
          await page.waitForTimeout(150);
          const point = await restingPoint();
          await page.mouse.move(point.x, point.y);
          const before = await inView();
          await changes[kind](before);
          await refresh(point.name);
          const after = await inView();
          const result = moved(before, after);
          const checked = await clickAt(point);
          const detail = { at: at.scrollTop, max: at.max, ...result, target: point.name, checked };
          report.anchor ??= [];
          report.anchor.push({ where, kind, ...detail });
          assert(result.compared >= 10, `${where} ${kind}: entries compared`);
          if (COMPARE) {
            // Recording another build's behaviour: report, do not stop.
            log(result.maxMove <= STILL && checked[0] === point.name ? "still" : "MOVED", where, kind, JSON.stringify(detail));
            continue;
          }
          assert(result.maxMove <= STILL, `${where} ${kind}: entries in view moved ${result.maxMove}px`);
          assert.deepEqual(checked, [point.name], `${where} ${kind}: click hit ${checked}`);
          pass("anchor", `${where} ${kind}`, detail);
        }
      }
    }

    // Scrolls so that the entry at this index of the listing is in the
    // middle of the view and returns its name.
    async function reveal(index) {
      const listed = await order();
      return page.evaluate(
        async ({ index, name }) => {
          const d = window.__drive;
          const s = d.scroller();
          const find = () => d.entries().find((e) => e.name === name);
          // Rows are of one height: aim from the first rendered row's, then
          // correct from the entry itself once it is rendered.
          const tops = d.entries().map((e) => e.el.getBoundingClientRect().top).sort((a, b) => a - b);
          const steps = tops.slice(1).map((t, i) => t - tops[i]).filter((x) => x > 1);
          const pitch = Math.min(...steps);
          for (let i = 0; i < 20 && !find(); i++) {
            s.scrollTop = (index * pitch) - s.clientHeight / 2 + 40;
            await d.frames(2);
          }
          const el = find().el;
          const v = s.getBoundingClientRect();
          s.scrollTop += el.getBoundingClientRect().top - (v.top + v.height / 2);
          await d.frames(3);
          return name;
        },
        { index, name: listed[index].name },
      );
    }
    async function checkboxOf(name) {
      return page.evaluate((name) => {
        const e = window.__drive.entries().find((x) => x.name === name);
        const r = e.el.querySelector('input[type="checkbox"]').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, name);
    }
    const isChecked = (name) =>
      page.evaluate(
        (name) => window.__drive.entries().find((x) => x.name === name)?.el.querySelector('input[type="checkbox"]').checked ?? null,
        name,
      );
    const selectedCount = () =>
      page.evaluate(() => {
        const bar = [...document.querySelectorAll("span")].find((x) => /^\d+ selected$/.test(x.textContent));
        return bar ? Number(bar.textContent.split(" ")[0]) : 0;
      });
    const blur = () => page.evaluate(() => document.activeElement?.blur());

    // A colleague renames the top block of entries in view, more than stay
    // (all but the last `stay`), so that they sort after every other entry;
    // the user's next refresh shows it. The view must not follow the block:
    // the entries that stayed keep their places, and a click where the
    // pointer rests (on one of them) hits the entry under it.
    let blocks = 0;
    async function renameTopBlock(view, stay) {
      const listed = await order();
      const ids = new Map(listed.map((e) => [e.name, e.id]));
      const block = view.slice(0, view.length - stay);
      blocks++;
      for (const [i, e] of block.entries())
        await prisma.file.update({
          where: { id: ids.get(e.name) },
          data: { name: `zz block ${blocks} ${String(i).padStart(2, "0")} ${e.name}` },
        });
      return block;
    }

    if (steps.includes("block")) {
      log("step", "block");
      for (const where of [0.25, 0.5]) {
        await loadAll(page, pages, "");
        await page.evaluate(async (where) => {
          const s = window.__drive.scroller();
          s.scrollTop = where * (s.scrollHeight - s.clientHeight);
          await window.__drive.frames(3);
        }, where);
        await page.waitForTimeout(150);
        const before = await inView();
        const stayed = before.slice(before.length - 4);
        const target = stayed[1].name;
        const point = await checkboxOf(target);
        await page.mouse.move(point.x, point.y);
        const top = await page.evaluate(() => window.__drive.scroller().scrollTop);
        const block = await renameTopBlock(before, 4);
        await refresh(target);
        const after = await inView();
        const result = moved(stayed, after);
        const scrolled = (await page.evaluate(() => window.__drive.scroller().scrollTop)) - top;
        const checked = await clickAt({ ...point, name: target });
        const detail = { at: where, block: block.length, stayed: stayed.length, ...result, scrolled, target, checked };
        report.block ??= [];
        report.block.push({ view: "list", ...detail });
        assert.equal(result.compared, stayed.length, `block ${where}: the entries that stayed are in view`);
        assert(result.maxMove <= STILL, `block ${where}: the entries that stayed moved ${result.maxMove}px`);
        assert.deepEqual(checked, [target], `block ${where}: click hit ${checked}`);
        pass("block", `list: top ${block.length} of ${before.length} in view renamed to sort at the end (${where * 100}%)`, detail);
      }
    }

    if (steps.includes("bulk")) {
      log("step", "bulk");
      // The user's own bulk trash of entries above the view.
      await loadAll(page, pages, "");
      const listed = await order();
      const picked = [];
      for (const index of [300, 310, 320]) {
        const name = await reveal(index);
        const box = await checkboxOf(name);
        await page.mouse.click(box.x, box.y);
        picked.push(listed.find((e) => e.name === name));
      }
      assert.equal(await selectedCount(), 3);
      await scrollTo(Math.round((await page.evaluate(() => window.__drive.scroller().scrollHeight)) / 2));
      const point = await restingPoint();
      await page.mouse.move(point.x, point.y);
      const before = await inView();
      await blur();
      await page.keyboard.press("Delete");
      const dialog = page.getByRole("alertdialog", { name: "Move 3 items to trash?" });
      await dialog.waitFor();
      const from = pages.length;
      await dialog.getByRole("button", { name: "Trash" }).click();
      await dialog.waitFor({ state: "detached" });
      await refetched(from);
      const after = await inView();
      const result = moved(before, after);
      const trashed = await prisma.file.findMany({
        where: { parentId: fixture.root.id, trashedAt: { not: null } },
        select: { id: true },
      });
      const trashedIds = new Set(trashed.map((t) => t.id));
      for (const e of picked) assert(trashedIds.has(e.id), `${e.name} trashed`);
      const checked = await clickAt(point);
      assert(result.maxMove <= STILL, `bulk: entries in view moved ${result.maxMove}px`);
      assert.deepEqual(checked, [point.name], `bulk: click hit ${checked}`);
      pass("bulk", "trash 3 selected above the view", { ...result, trashed: picked.map((e) => e.name), checked });
    }

    if (steps.includes("selection")) {
      log("step", "selection");
      await loadAll(page, pages, "");
      const total = (await order()).length;
      const indexes = [3, Math.floor(total / 2), total - 5];
      const names = [];
      for (const index of indexes) {
        const name = await reveal(index);
        const box = await checkboxOf(name);
        await page.mouse.click(box.x, box.y);
        names.push(name);
      }
      assert.equal(await selectedCount(), 3);
      await reveal(indexes[0]);
      assert.equal(await isChecked(names[0]), true, "selection kept while scrolled out of view");
      assert.equal(await isChecked((await order())[indexes[0] + 1].name), false);
      // Shift-click selects the range between the last box clicked and this
      // one, in listing order, across entries never rendered.
      const from = await reveal(10);
      let box = await checkboxOf(from);
      await page.mouse.click(box.x, box.y);
      const to = await reveal(1000);
      box = await checkboxOf(to);
      await page.keyboard.down("Shift");
      await page.mouse.click(box.x, box.y);
      await page.keyboard.up("Shift");
      const inRange = indexes.filter((i) => i >= 10 && i <= 1000).length;
      assert.equal(await selectedCount(), 3 - inRange + 991);
      await blur();
      await page.keyboard.press("Control+a");
      assert.equal(await selectedCount(), total, "Ctrl+A selects every loaded entry");
      await page.keyboard.press("Escape");
      assert.equal(await selectedCount(), 0);
      pass("selection", "boxes across the window, shift range, select all", { total, names });
    }

    if (steps.includes("keyboard")) {
      log("step", "keyboard");
      await loadAll(page, pages, "");
      const listed = (await order()).map((e) => e.name);
      const start = Math.floor(listed.length / 2);
      const name = await reveal(start);
      await page.evaluate((name) => window.__drive.entries().find((e) => e.name === name).el.focus(), name);
      const focused = () =>
        page.evaluate(() => {
          const el = document.activeElement;
          const s = window.__drive.scroller().getBoundingClientRect();
          const r = el.getBoundingClientRect();
          const entry = window.__drive.entries().find((e) => e.el === el);
          return { name: entry?.name ?? el.tagName, inView: r.top >= s.top - 1 && r.bottom <= s.bottom + 1 };
        });
      for (let i = 1; i <= 40; i++) {
        await page.keyboard.press("ArrowDown");
        const f = await focused();
        assert.equal(f.name, listed[start + i], `ArrowDown ${i}`);
        assert(f.inView, `ArrowDown ${i}: focused row in view`);
      }
      for (let i = 39; i >= -20; i--) {
        await page.keyboard.press("ArrowUp");
        const f = await focused();
        assert.equal(f.name, listed[start + i], `ArrowUp to ${i}`);
        assert(f.inView, `ArrowUp ${i}: focused row in view`);
      }
      // Focus kept on a row scrolled far away; the next arrow key moves on
      // from it.
      await scrollTo(0);
      await page.keyboard.press("ArrowDown");
      const f = await focused();
      assert.equal(f.name, listed[start - 19]);
      // Enter on a folder row opens it.
      const folder = await reveal(5);
      await page.evaluate((name) => window.__drive.entries().find((e) => e.name === name).el.focus(), folder);
      await page.keyboard.press("Enter");
      const target = await subfolder(folder);
      await page.waitForURL((url) => url.searchParams.get("folderId") === target.id);
      await page.goBack();
      await page.waitForURL((url) => url.searchParams.get("folderId") === fixture.root.id);
      await page.waitForFunction(() => window.__drive.entries().length > 10);
      pass("keyboard", "arrow keys through 100 rows, focus kept off screen, Enter opens a folder", { start });
    }

    if (steps.includes("menu")) {
      log("step", "menu");
      // Rename from the context menu of a row in the middle: the right file
      // is renamed, and it moves above the view without moving the others.
      await loadAll(page, pages, "");
      const listed = await order();
      const name = await reveal(Math.floor(listed.length / 2));
      const file = listed.find((e) => e.name === name);
      const point = await page.evaluate((name) => {
        const r = window.__drive.entries().find((e) => e.name === name).el.querySelector("td:nth-child(2)").getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, name);
      const before = await inView();
      await page.mouse.click(point.x, point.y, { button: "right" });
      await page.getByRole("menuitem", { name: "Rename" }).click();
      const dialog = page.getByRole("dialog", { name: "Rename" });
      await dialog.waitFor();
      assert.equal(await dialog.getByRole("textbox").inputValue(), name);
      const renamed = `File 00000 0 renamed ${name}`;
      await dialog.getByRole("textbox").fill(renamed);
      const from = pages.length;
      await page.keyboard.press("Enter");
      await dialog.waitFor({ state: "detached" });
      await refetched(from);
      const after = await inView();
      // The renamed entry leaves the view: the entries above it stay, those
      // below it close the gap.
      const at = before.findIndex((e) => e.name === name);
      const above = moved(before.slice(0, at), after);
      const below = moved(before.slice(at + 1), after);
      const stored = await prisma.file.findUniqueOrThrow({ where: { id: file.id } });
      assert.equal(stored.name, renamed);
      assert.equal(await prisma.file.count({ where: { name: renamed } }), 1);
      assert(!after.some((e) => e.name === renamed), "the renamed entry sorts above the view");
      assert(above.maxMove <= STILL, `rename: entries above it moved ${above.maxMove}px`);
      const gap = before[at + 1].top - before[at].top;
      assert(Math.abs(below.maxMove - gap) <= STILL, `rename: entries below it moved ${below.maxMove}px`);
      pass("menu", "context menu rename of a row in the middle", { file: name, above, below });
    }

    if (steps.includes("drag")) {
      log("step", "drag");
      await loadAll(page, pages, "");
      const listed = await order();
      const lastFolder = listed.filter((e) => e.isFolder).length - 1;
      // A file onto a folder, both in view.
      await reveal(lastFolder);
      const center = async (name) =>
        page.evaluate((name) => {
          const e = window.__drive.entries().find((x) => x.name === name);
          if (!e) return null;
          const r = e.el.querySelector("td").getBoundingClientRect();
          return { x: r.left + 120, y: r.top + r.height / 2 };
        }, name);
      const file = listed[lastFolder + 3];
      const folder = listed[lastFolder - 2];
      let from = await center(file.name);
      let to = await center(folder.name);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 15, from.y - 15, { steps: 3 });
      await page.mouse.move(to.x, to.y, { steps: 8 });
      let refetch = pages.length;
      await page.mouse.up();
      await refetched(refetch);
      assert.equal((await prisma.file.findUniqueOrThrow({ where: { id: file.id } })).parentId, folder.id);
      pass("drag", "file dropped on a folder in view", { file: file.name, folder: folder.name });

      // The dragged row scrolled far out of view and back: it stays
      // rendered, and the drop moves that file.
      const listed2 = await order();
      const lastFolder2 = listed2.filter((e) => e.isFolder).length - 1;
      await reveal(lastFolder2);
      const file2 = listed2[lastFolder2 + 4];
      const folder2 = listed2[lastFolder2 - 3];
      from = await center(file2.name);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 15, from.y + 15, { steps: 3 });
      // (The wheel over the drag preview scrolls the page, not the list, as
      // on main; the list scrolls by script here.)
      const startTop = await page.evaluate(async () => {
        const s = window.__drive.scroller();
        const top = s.scrollTop;
        s.scrollTop = top + 6000;
        await window.__drive.frames(3);
        return top;
      });
      await page.waitForTimeout(300);
      const retained = await page.evaluate(
        (name) => {
          const e = window.__drive.entries().find((x) => x.name === name);
          const s = window.__drive.scroller().getBoundingClientRect();
          return e ? { rendered: true, inView: e.el.getBoundingClientRect().bottom > s.top } : { rendered: false };
        },
        file2.name,
      );
      // Back to where the drag started.
      await page.evaluate(async (top) => {
        window.__drive.scroller().scrollTop = top;
        await window.__drive.frames(3);
      }, startTop);
      await page.waitForTimeout(300);
      to = await center(folder2.name);
      assert(to, `${folder2.name} in view again`);
      await page.mouse.move(to.x, to.y, { steps: 8 });
      refetch = pages.length;
      await page.mouse.up();
      await refetched(refetch);
      assert.deepEqual(retained, { rendered: true, inView: false }, "dragged row kept while out of view");
      assert.equal((await prisma.file.findUniqueOrThrow({ where: { id: file2.id } })).parentId, folder2.id);
      pass("drag", "dragged row scrolled away and back, then dropped", { file: file2.name, folder: folder2.name });
    }

    if (steps.includes("upload")) {
      log("step", "upload");
      // Files dropped on the view upload into the folder; the new file sorts
      // above the view, and the entries in view stay where they are.
      await loadAll(page, pages, "");
      await scrollTo("middle");
      const point = await restingPoint();
      await page.mouse.move(point.x, point.y);
      const before = await inView();
      const name = "File 00000 0 dropped.txt";
      const refetch = pages.length;
      await page.evaluate((name) => {
        const target = window.__drive.scroller();
        const data = new DataTransfer();
        data.items.add(new File(["dropped on the view"], name, { type: "text/plain" }));
        for (const type of ["dragenter", "dragover", "drop"])
          target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
      }, name);
      await refetched(refetch);
      const after = await inView();
      const result = moved(before, after);
      const stored = await prisma.file.findFirst({ where: { parentId: fixture.root.id, name } });
      assert(stored, "uploaded into the folder");
      const checked = await clickAt(point);
      assert(result.maxMove <= STILL, `upload: entries in view moved ${result.maxMove}px`);
      assert.deepEqual(checked, [point.name]);
      pass("upload", "file dropped on the view", { ...result, checked });
    }

    if (steps.includes("grid")) {
      log("step", "grid");
      await page.getByRole("button", { name: "Grid view" }).click();
      await page.waitForFunction(() => document.querySelector("[data-drive-card], .grid.gap-3 > div"));
      await loadAll(page, pages, "");
      await loadAll(page, pages, "");
      const columns = await page.evaluate(() => {
        const cards = window.__drive.inView();
        return cards.filter((c) => Math.abs(c.top - cards[0].top) < 1).length;
      });
      // Lines of `columns` cards in listing order, one height apart.
      async function gridStructure(label) {
        const expected = (await order()).map((e) => e.name);
        const r = await page.evaluate(() => {
          const d = window.__drive;
          const s = d.scroller();
          const v = s.getBoundingClientRect();
          const cards = d.inView();
          const blank = [];
          const last = cards.at(-1).bottom;
          for (let y = Math.max(0, cards[0].top) + 5; y < Math.min(v.height, last) - 2; y += 23) {
            // Between two lines is the grid's gap; look just below it too.
            const hits = [0, 12].map((dy) => document.elementFromPoint(v.left + 60, v.top + y + dy));
            if (!hits.some((hit) => hit?.closest("[data-drive-card], .grid.gap-3 > div"))) blank.push(y);
          }
          return { cards: cards.map((c) => ({ name: c.name, top: c.top })), blank, viewWidth: s.clientWidth, contentWidth: s.scrollWidth };
        });
        const names = r.cards.map((c) => c.name);
        const start = expected.indexOf(names[0]);
        assert(start >= 0 && start % columns === 0, `${label}: first card starts a line`);
        assert.deepEqual(names, expected.slice(start, start + names.length), `${label}: order`);
        const lines = [...new Set(r.cards.map((c) => Math.round(c.top)))];
        const pitch = lines.slice(1).map((t, i) => t - lines[i]);
        assert(Math.max(...pitch) - Math.min(...pitch) <= 1, `${label}: lines evenly spaced`);
        assert.deepEqual(r.blank, [], `${label}: no blank space`);
        assert(r.contentWidth <= r.viewWidth, `${label}: no sideways overflow`);
        return { firstIndex: start, cards: names.length, pitch: pitch[0] };
      }
      for (const fraction of [0, 0.5, 1]) {
        await page.evaluate(async (fraction) => {
          const s = window.__drive.scroller();
          s.scrollTop = fraction * (s.scrollHeight - s.clientHeight);
          await window.__drive.frames(3);
        }, fraction);
        pass("grid", `structure at ${fraction * 100}%`, { columns, ...(await gridStructure(`grid ${fraction}`)) });
      }
      let n = 0;
      const gridChanges = {
        create: async () => {
          for (let i = 0; i < columns; i++)
            await colleague("POST", "/files/folder", {
              name: `Folder 0000 grid ${++n}`,
              parentId: fixture.root.id,
              teamFolderId: fixture.teamFolder.id,
            });
        },
        delete: async (view) => {
          const listed = await order();
          const first = listed.findIndex((e) => e.name === view[0].name);
          for (const e of listed.slice(first - 60, first - 60 + columns))
            await colleague("PATCH", `/files/${e.id}`, { trashedAt: new Date().toISOString() });
        },
      };
      for (const where of ["middle", "end"]) {
        for (const kind of ["create", "delete"]) {
          await loadAll(page, pages, "");
          await scrollTo(where);
          await page.waitForTimeout(150);
          const point = await restingPoint();
          await page.mouse.move(point.x, point.y);
          const before = await inView();
          await gridChanges[kind](before);
          await refresh(point.name);
          const after = await inView();
          const result = moved(before, after);
          const checked = await clickAt(point);
          report.anchor ??= [];
          report.anchor.push({ view: "grid", where, kind, ...result, target: point.name, checked });
          assert(result.maxMove <= STILL, `grid ${where} ${kind}: cards in view moved ${result.maxMove}px`);
          assert.deepEqual(checked, [point.name], `grid ${where} ${kind}: click hit ${checked}`);
          pass("grid", `${where} ${kind} (${columns} entries)`, { ...result, checked });
        }
      }
      // Context menu of a card in the middle.
      await scrollTo("middle");
      const card = await restingPoint();
      await page.mouse.click(card.x + 40, card.y + 40, { button: "right" });
      await page.getByRole("menuitem", { name: "Rename" }).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("menuitem", { name: "Rename" }).waitFor({ state: "detached" });
      pass("grid", "context menu on a card");

      if (steps.includes("block")) {
        // The top lines of cards in view (all but the last line) renamed to
        // sort at the end: the view stays; the first card left keeps its
        // place, and the others reflow behind it.
        await loadAll(page, pages, "");
        await scrollTo("middle");
        await page.waitForTimeout(150);
        const before = await inView();
        const block = await renameTopBlock(before, columns);
        const stayed = before.slice(before.length - columns);
        const top = await page.evaluate(() => window.__drive.scroller().scrollTop);
        await refresh(stayed[1].name);
        const after = await inView();
        const first = after.find((e) => e.name === stayed[0].name);
        const scrolled = (await page.evaluate(() => window.__drive.scroller().scrollTop)) - top;
        const detail = {
          block: block.length,
          stayed: stayed.length,
          firstLeftMoved: first ? first.top - stayed[0].top : null,
          scrolled,
        };
        report.block ??= [];
        report.block.push({ view: "grid", ...detail });
        assert(first, "grid block: the first card left is in view");
        assert(Math.abs(first.top - stayed[0].top) <= STILL, `grid block: the first card left moved ${first.top - stayed[0].top}px`);
        assert(Math.abs(scrolled) < VIEWPORT.height, `grid block: the view moved ${scrolled}px`);
        pass("block", `grid: top ${block.length} cards in view renamed to sort at the end`, detail);
      }

      if (steps.includes("resize")) {
        // Window widths across the grid's breakpoints (1024, 768 and 640 px:
        // 5, 4, 3 and 2 columns): the first card fully in view stays within
        // a line of its place.
        await scrollTo("middle");
        await page.waitForTimeout(150);
        report.resize = [];
        for (const width of [900, 700, 560, 1440]) {
          const before = (await inView()).find((e) => e.top >= -1);
          await page.setViewportSize({ width, height: VIEWPORT.height });
          await page.waitForTimeout(400);
          await page.evaluate(() => window.__drive.frames(3));
          const after = await inView();
          const same = after.find((e) => e.name === before.name);
          const detail = {
            width,
            columns: await page.evaluate(() => {
              const cards = window.__drive.inView();
              return cards.filter((c) => Math.abs(c.top - cards[0].top) < 1).length;
            }),
            entry: before.name,
            topBefore: before.top,
            topAfter: same ? same.top : null,
          };
          report.resize.push(detail);
          assert(same, `resize ${width}: ${before.name} still in view`);
          assert(Math.abs(same.top - before.top) <= 140, `resize ${width}: ${before.name} moved ${same.top - before.top}px`);
          pass("resize", `grid at ${width} px`, detail);
        }
        await page.setViewportSize(VIEWPORT);
        await page.waitForTimeout(300);
      }

      await page.getByRole("button", { name: "List view" }).click();
      await page.waitForFunction(() => document.querySelector("table"));
    }

    if (steps.includes("above")) {
      log("step", "above");
      // The owner's own Drive: "My Files" lists below the Starred section.
      // Starring a file in view adds it to that section, above the list; the
      // entries in view stay where they are.
      // No starred files yet: the Starred section is not shown.
      await prisma.starredFile.deleteMany({ where: { userId: fixture.owner.id } });
      await page.goto(`${origin}/${fixture.workspace.slug}/drive?section=home&view=list`);
      await installHelpers(page);
      const own = [];
      page.on("response", async (response) => {
        const url = new URL(response.url());
        if (!/\/api\/workspaces\/[^/]+\/files$/.test(url.pathname) || url.searchParams.has("parentId") || url.searchParams.has("search")) return;
        try {
          const body = await response.json();
          own.push({ nextCursor: body.nextCursor });
        } catch {
          own.push({ failed: true });
        }
      });
      await page.waitForFunction(() => window.__drive.entries().length > 10);
      for (let i = 0; i < 40 && own.at(-1)?.nextCursor !== null; i++) {
        await page.evaluate(async () => {
          const s = window.__drive.scroller();
          s.scrollTop = s.scrollHeight;
          await window.__drive.frames(2);
        });
        await page.waitForTimeout(150);
      }
      const results = [];
      await scrollTo("middle");
      let target;
      for (const action of ["star", "unstar"]) {
        const before = await inView();
        const sectionBefore = await page.evaluate(() => window.__drive.scroller().querySelector("table").getBoundingClientRect().top + window.__drive.scroller().scrollTop);
        // The same entry both times: it stays in view.
        target ??= before[Math.floor(before.length / 2)].name;
        await page.evaluate(
          ({ target, title }) =>
            window.__drive.entries().find((e) => e.name === target).el.querySelector(`button[title="${title}"]`).click(),
          { target, title: action === "star" ? "Star" : "Unstar" },
        );
        await page.waitForFunction(
          ({ before, action }) => {
            const s = window.__drive.scroller();
            const top = s.querySelector("table").getBoundingClientRect().top + s.scrollTop;
            return action === "star" ? top > before + 10 : top < before - 10;
          },
          { before: sectionBefore, action },
          { timeout: 30_000 },
        );
        await page.evaluate(() => window.__drive.frames(3));
        await page.waitForTimeout(300);
        const after = await inView();
        const result = moved(before, after);
        results.push({ action, ...result });
        assert(result.maxMove <= STILL, `above ${action}: entries in view moved ${result.maxMove}px`);
        pass("above", `${action === "star" ? "star adds to" : "unstar removes from"} the Starred section above the list`, result);
      }
      report.above = results;
    }
  } finally {
    await context.close();
  }

  if (steps.includes("rate")) {
    // One client address, as a browser has (the server allows 100 API
    // requests a minute per address): skimming the folder in flicks, and
    // jumping to its end as fast as pages arrive. Neither may end with the
    // folder replaced by "Failed to load files"; a refused page is asked
    // for again after the wait the server gives, and jumping reaches the end.
    log("step", "rate");
    report.rate = [];
    const runs = [
      { name: "flicks of 30 x 100 px, then 0.7 s", kind: "flick" },
      { name: "to the end as fast as pages arrive", kind: "jump" },
    ];
    for (const [n, run] of runs.entries()) {
      proxyAddress = `127.0.3.${10 + n}`;
      const { context, page, pages } = await openContext(browser, origin, fixture);
      const refused = [];
      let shareStatusRequests = 0;
      page.on("response", (response) => {
        if (response.status() === 429) refused.push(new URL(response.url()).pathname);
        if (new URL(response.url()).pathname.endsWith("/files/share-status")) shareStatusRequests++;
      });
      try {
        const t0 = Date.now();
        await page.goto(`${origin}${folderPath(fixture, "list")}`);
        await installHelpers(page);
        await page.waitForFunction(() => window.__drive.entries().length > 10);
        const v = await page.evaluate(() => {
          const r = window.__drive.scroller().getBoundingClientRect();
          return { x: r.left + r.width * 0.75, y: r.top + r.height / 2 };
        });
        await page.mouse.move(v.x, v.y);
        let state = {};
        let notices = 0;
        for (let i = 0; Date.now() - t0 < 180_000; i++) {
          if (run.kind === "flick") {
            for (let k = 0; k < 30; k++) {
              await page.mouse.wheel(0, 100);
              await page.waitForTimeout(10);
            }
            await page.waitForTimeout(700);
          } else {
            await page.evaluate(async (away) => {
              const s = window.__drive.scroller();
              if (away) {
                s.scrollTop = s.scrollHeight - s.clientHeight - 400;
                await window.__drive.frames(2);
              }
              s.scrollTop = s.scrollHeight;
            }, i % 5 === 0);
            await page.waitForTimeout(40);
          }
          state = await page.evaluate(() => {
            const s = window.__drive.scroller();
            return {
              failed: [...document.querySelectorAll("p")].some((p) => p.textContent === "Failed to load files"),
              notice: [...document.querySelectorAll('[role="status"]')].some((e) => /load more files/.test(e.textContent)),
              atEnd: s ? s.scrollHeight - s.clientHeight - s.scrollTop < 2 : false,
            };
          });
          if (state.notice) notices++;
          const last = pages.at(-1);
          if (state.failed || (last?.nextCursor === null && state.atEnd)) break;
        }
        const detail = {
          run: run.name,
          seconds: Math.round((Date.now() - t0) / 1000),
          pagesLoaded: pages.filter((p) => p.status === 200).length,
          refused: refused.length,
          refusedListing: refused.filter((p) => p.endsWith("/files")).length,
          shareStatusRequests,
          noticeSeen: notices > 0,
          failedShown: !!state.failed,
          reachedEnd: pages.at(-1)?.nextCursor === null,
        };
        report.rate.push(detail);
        assert(!state.failed, `${run.name}: "Failed to load files"`);
        if (run.kind === "jump") {
          // 100 pages within a minute from one address exceed the server's
          // limit: the jump must have been refused, waited and gone on.
          assert(detail.refusedListing > 0, `${run.name}: no page was refused, the retry went untested`);
          assert(detail.noticeSeen, `${run.name}: the inline notice was not shown`);
          assert(detail.reachedEnd, `${run.name}: the end of the folder was not reached`);
        }
        pass("rate", run.name, detail);
      } finally {
        await context.close();
        proxyAddress = null;
      }
    }
  }
  return checks;
}

// Each connection from a different loopback address (127.0.1.1-250), or
// from `proxyAddress` when set (the rate step: one client address).
let lastAddress = 0;
let proxyAddress = null;
class SpreadAgent extends http.Agent {
  createConnection(options, callback) {
    lastAddress = (lastAddress % 250) + 1;
    const localAddress = proxyAddress ?? `127.0.1.${lastAddress}`;
    return super.createConnection({ ...options, localAddress }, callback);
  }
}

// ─── Main ───────────────────────────────────────────────────

let app, vite, browser, fixture, distDir;
try {
  app = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const identity = await app.prisma.$queryRaw`SELECT current_database()`;
  assert.equal(identity[0].current_database, database.pathname.slice(1));
  const started = Date.now();
  fixture = await createFixture(app.prisma);
  fixture.apiOrigin = app.listeningOrigin;
  log(`fixture: ${fixture.entries.length} entries in ${Date.now() - started} ms`);

  distDir = process.env.DRIVE_DIST
    ? path.resolve(process.env.DRIVE_DIST)
    : path.join(scratch, "dist");
  if (!process.env.DRIVE_DIST) {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await build({
        root: frontend,
        configFile: path.join(frontend, "vite.config.ts"),
        logLevel: "error",
        build: { outDir: distDir, emptyOutDir: true },
      });
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
  vite = await preview({
    root: frontend,
    configFile: false,
    logLevel: "error",
    build: { outDir: distDir },
    preview: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      proxy: {
        "/api": {
          target: app.listeningOrigin,
          changeOrigin: true,
          ws: true,
          // The server allows 100 API requests a minute per client address.
          // Loading every page of a 5,000-entry folder (and refetching them
          // on a refresh) takes more than that, so the proxy spreads its
          // connections over loopback addresses. That limit is a finding of
          // its own (docs/remediation/p01c.md); this measures rendering.
          agent: new SpreadAgent({ keepAlive: false }),
        },
      },
    },
  });
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ["--no-sandbox", "--enable-precise-memory-info"],
  });
  report.browser = browser.version();
  report.viewport = VIEWPORT;
  report.dist = distDir;

  if (MODE !== "smoke") {
    for (const view of VIEWS) {
      report.runs[view] = [];
      for (let run = 1; run <= RUNS; run++)
        report.runs[view].push(await measureRun(browser, origin, fixture, view, run));
      report.summary[view] = summarize(report.runs[view]);
      log(`summary ${view}`, JSON.stringify(report.summary[view]));
    }
  }
  if (MODE !== "measure") {
    report.smoke = await smoke({ browser, origin, fixture, prisma: app.prisma });
  }
  assert.deepEqual(report.errors, [], "browser errors");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error?.stack ?? error);
  process.exitCode = 1;
  log("FAILED", error);
} finally {
  if (process.env.DRIVE_REPORT)
    await writeFile(process.env.DRIVE_REPORT, JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
  try {
    if (created.workspaceId)
      await app.prisma.workspace.deleteMany({ where: { id: created.workspaceId } });
    if (created.userIds.length)
      await app.prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
  } catch (error) {
    process.exitCode = 1;
    log("fixture cleanup failed", error);
  }
  await app?.close();
  await rm(scratch, { recursive: true, force: true });
}

