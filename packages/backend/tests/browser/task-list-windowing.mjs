// Chromium measurement and smoke test for a long project List
// (docs/remediation/p01b.md). Run from packages/backend with a migrated,
// disposable loopback database whose name starts with werkyn_audit_ and an
// installed PLAYWRIGHT_MODULE (package name or absolute module path):
//
//   TEST_DATABASE_URL=... PLAYWRIGHT_MODULE=... \
//     node --import tsx tests/browser/task-list-windowing.mjs
//
// TASK_LIST_DIST   an already built frontend dist; otherwise one is built into
//                  a temporary directory first
// TASK_LIST_MODE   "measure" (timings only, also usable against builds that
//                  render every row), "smoke" (behaviour checks of the
//                  windowed List) or "all" (default)
// TASK_LIST_TASKS  tasks in the fixture project (default 5000)
// TASK_LIST_RUNS   measured runs, each in a fresh browser context (default 3)
// TASK_LIST_STEPS  smoke steps to run, comma-separated (aria, scroll,
//                  keyboard, selection, edit, realtime, collapse, anchor,
//                  edges, bulk, board);
//                  all by default
// TASK_LIST_REPORT path for the JSON report
// TASK_LIST_SCREENSHOTS directory for screenshots taken during the smoke
// CHROMIUM_EXECUTABLE  a Chromium binary other than Playwright's own
//
// The fixture adds its own users, workspace and project and deletes them at
// the end. Only loopback traffic is allowed; other requests are aborted.
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
  JWT_SECRET: "task-list-browser-fixture-jwt-secret",
  COOKIE_SECRET: "task-list-browser-fixture-cookie-secret",
  COOKIE_SECURE: "false",
  COOKIE_SAMESITE: "lax",
});
const MODE = process.env.TASK_LIST_MODE ?? "all";
assert(["measure", "smoke", "all"].includes(MODE));
const TASKS = Number(process.env.TASK_LIST_TASKS ?? "5000");
const RUNS = Number(process.env.TASK_LIST_RUNS ?? "3");
assert(TASKS >= 200 && TASKS <= 20_000 && RUNS >= 1 && RUNS <= 10);
const VIEWPORT = { width: 1440, height: 900 };

const scratch = await mkdtemp(path.join(os.tmpdir(), "werkyn-task-list-"));
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
  tasks: TASKS,
  runs: [],
  smoke: [],
  errors: [],
};
const log = (...args) => console.error("[task-list]", ...args);

// ─── Fixture ────────────────────────────────────────────────

const WORDS = [
  "invoice", "migration", "onboarding", "billing", "dashboard", "export",
  "login", "search", "report", "sync", "mobile", "upload", "calendar",
  "permissions", "audit", "backup", "release", "pricing", "checkout",
  "analytics", "webhook", "email", "template", "roadmap", "security",
];
let seed = 20261104;
function rand() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (items) => items[Math.floor(rand() * items.length)];
const words = (n) => Array.from({ length: n }, () => pick(WORDS)).join(" ");
const day = (offset) =>
  new Date(Date.UTC(2026, 10, 1) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);
const taskTitle = (i, phrase) =>
  `Task ${String(i).padStart(5, "0")} ${phrase}`;

// Records what the fixture has written so far, so a failure part-way
// through setup is cleaned up too.
const created = { userIds: [], workspaceId: null, projectId: null };

async function createFixture(prisma) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const password = "Task-list-browser-password";
  const passwordHash = await bcrypt.hash(password, 10);
  const owner = await prisma.user.create({
    data: {
      email: `list-owner-${suffix}@fixture.invalid`,
      passwordHash,
      displayName: "List Owner",
      emailVerified: true,
    },
  });
  created.userIds.push(owner.id);
  const other = await prisma.user.create({
    data: {
      email: `list-other-${suffix}@fixture.invalid`,
      passwordHash,
      displayName: "List Colleague",
      emailVerified: true,
    },
  });
  created.userIds.push(other.id);
  const workspace = await prisma.workspace.create({
    data: {
      name: "List window fixture",
      slug: `list-window-${suffix}`,
      members: {
        create: [
          { userId: owner.id, role: "ADMIN" },
          { userId: other.id, role: "ADMIN" },
        ],
      },
    },
  });
  created.workspaceId = workspace.id;
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Long list project",
      members: { create: [{ userId: owner.id }, { userId: other.id }] },
    },
  });
  created.projectId = project.id;
  const statusPlan = [
    { name: "To do", color: "#64748b", share: 0.4 },
    { name: "In progress", color: "#3b82f6", share: 0.25 },
    { name: "Review", color: "#f59e0b", share: 0.15 },
    { name: "Done", color: "#22c55e", share: 0.2, isCompletion: true },
  ];
  const statuses = [];
  for (const [position, plan] of statusPlan.entries()) {
    statuses.push(
      await prisma.statusColumn.create({
        data: {
          projectId: project.id,
          name: plan.name,
          color: plan.color,
          position,
          isCompletion: plan.isCompletion ?? false,
        },
      }),
    );
  }
  const labels = [];
  for (const [i, name] of [
    "frontend", "backend", "customer request", "needs design review",
    "blocked", "quick win", "infrastructure and operations", "docs",
  ].entries()) {
    labels.push(
      await prisma.label.create({
        data: {
          projectId: project.id,
          name,
          color: ["#ef4444", "#3b82f6", "#a855f7", "#14b8a6"][i % 4],
        },
      }),
    );
  }
  const options = ["Discovery", "Build", "Verify", "Launch"].map(
    (value, i) => ({ value, color: ["#6366f1", "#0ea5e9", "#f97316", "#10b981"][i] }),
  );
  const fieldPlan = [
    { name: "Notes", type: "TEXT" },
    { name: "Estimate", type: "NUMBER" },
    { name: "Stage", type: "SELECT", options },
    { name: "Areas", type: "MULTI_SELECT", options },
    { name: "Target", type: "DATE" },
    { name: "Signed off", type: "CHECKBOX" },
  ];
  const fields = {};
  for (const [position, plan] of fieldPlan.entries()) {
    fields[plan.type] = await prisma.customField.create({
      data: { projectId: project.id, position, ...plan },
    });
  }

  const tasks = [];
  const assignees = [];
  const taskLabels = [];
  const values = [];
  let index = 0;
  for (const [s, status] of statuses.entries()) {
    const count =
      s === statuses.length - 1
        ? TASKS - index
        : Math.round(TASKS * statusPlan[s].share);
    for (let position = 0; position < count; position++, index++) {
      const id = `lw${suffix}${String(index).padStart(6, "0")}`;
      tasks.push({
        id,
        projectId: project.id,
        statusId: status.id,
        title: taskTitle(index, words(2 + Math.floor(rand() * 4))),
        priority: pick(["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"]),
        position,
        dueDate: rand() < 0.6 ? day(Math.floor(rand() * 120) - 30) : null,
        createdAt: new Date(Date.UTC(2026, 9, 1) + index * 1000),
      });
      if (rand() < 0.5) assignees.push({ taskId: id, userId: owner.id });
      if (rand() < 0.3) assignees.push({ taskId: id, userId: other.id });
      for (const label of labels) {
        if (rand() < 0.12) taskLabels.push({ taskId: id, labelId: label.id });
      }
      if (rand() < 0.5)
        values.push({ taskId: id, fieldId: fields.TEXT.id, value: words(3 + Math.floor(rand() * 8)) });
      if (rand() < 0.5)
        values.push({ taskId: id, fieldId: fields.NUMBER.id, value: Math.floor(rand() * 40) });
      if (rand() < 0.5)
        values.push({ taskId: id, fieldId: fields.SELECT.id, value: pick(options).value });
      if (rand() < 0.3)
        values.push({ taskId: id, fieldId: fields.MULTI_SELECT.id, value: [pick(options).value] });
      if (rand() < 0.3)
        values.push({ taskId: id, fieldId: fields.DATE.id, value: day(Math.floor(rand() * 90)) });
      if (rand() < 0.4)
        values.push({ taskId: id, fieldId: fields.CHECKBOX.id, value: true });
    }
  }
  const chunks = async (model, rows) => {
    for (let i = 0; i < rows.length; i += 2000)
      await prisma[model].createMany({ data: rows.slice(i, i + 2000) });
  };
  await chunks("task", tasks);
  await chunks("taskAssignee", assignees);
  await chunks("taskLabel", taskLabels);
  await chunks("customFieldValue", values);
  return {
    suffix,
    password,
    owner,
    other,
    workspace,
    project,
    statuses,
    labels,
    fields,
    tasks,
  };
}

// ─── Browser helpers ────────────────────────────────────────

const listPath = (f) => `/${f.workspace.slug}/projects/${f.project.id}/list`;

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
    report.errors.push(`console: ${text}`);
    log("console error", text);
  });
  return { context, page };
}

async function metrics(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// ─── Measurement ────────────────────────────────────────────

async function measureRun(browser, origin, fixture, run) {
  const { context, page } = await openContext(browser, origin, fixture);
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
    // Start on the light project settings page, then switch to the List in
    // the same document, as a user does.
    await page.goto(
      `${origin}/${fixture.workspace.slug}/projects/${fixture.project.id}/settings`,
    );
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => {
      window.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          window.__longTasks.push({
            start: entry.startTime,
            duration: entry.duration,
          });
      }).observe({ type: "longtask" });
    });
    await cdp.send("HeapProfiler.collectGarbage");
    const before = await metrics(cdp);
    const link = page.locator(`a[href$="/projects/${fixture.project.id}/list"]`);
    const start = await page.evaluate(() => performance.now());
    await link.first().click();
    // Same structural check for builds that render every row and for the
    // windowed build: the first group's first task row is in the DOM.
    const rowsAt = await page.waitForFunction(
      () => {
        const cell = document.querySelector(
          "table tbody > tr:nth-child(2) > td:nth-child(2)",
        );
        return cell?.textContent?.startsWith("Task 00000")
          ? performance.now()
          : false;
      },
      undefined,
      { polling: "raf", timeout: 120_000 },
    );
    const rowsVisible = await rowsAt.jsonValue();
    // Let the main thread settle: two quiet seconds without a long task.
    await page.waitForFunction(
      () => {
        const last = window.__longTasks.at(-1);
        const quietSince = last ? last.start + last.duration : 0;
        return performance.now() - quietSince > 2000;
      },
      undefined,
      { polling: 250, timeout: 120_000 },
    );
    const after = await metrics(cdp);
    const load = await page.evaluate(
      ({ start, projectId }) => {
        const tasksEntry = performance
          .getEntriesByType("resource")
          .filter(
            (e) =>
              e.startTime >= start &&
              e.name.includes(`/projects/${projectId}/tasks`),
          )
          .at(-1);
        const longTasks = window.__longTasks.filter((t) => t.start >= start);
        return {
          tasksResponseEnd: tasksEntry ? tasksEntry.responseEnd - start : null,
          longTasks: longTasks.length,
          longTaskMs: longTasks.reduce((n, t) => n + t.duration, 0),
          blockingMs: longTasks.reduce((n, t) => n + Math.max(0, t.duration - 50), 0),
          longestTaskMs: Math.max(0, ...longTasks.map((t) => t.duration)),
          settledAt: Math.max(
            0,
            ...longTasks.map((t) => t.start + t.duration - start),
          ),
          domElements: document.getElementsByTagName("*").length,
          tableRows: document.querySelectorAll("table tbody tr").length,
          controls: document.querySelectorAll("table button, table input, table select").length,
        };
      },
      { start, projectId: fixture.project.id },
    );
    await cdp.send("HeapProfiler.collectGarbage");
    const settledMemory = await metrics(cdp);
    const dom = await cdp.send("Memory.getDOMCounters");

    // Layout facts recorded for both builds: table and view widths, row
    // heights in view, and whether the header row stays at the top of the
    // view once the List is scrolled (it is `sticky` in the markup).
    const layout = await page.evaluate(async () => {
      const main = document.querySelector("main");
      const table = document.querySelector("table");
      const view = main.getBoundingClientRect();
      const rows = [...table.tBodies[0].rows].filter((r) => {
        const b = r.getBoundingClientRect();
        return b.bottom > view.top && b.top < view.bottom && !r.hasAttribute("aria-hidden");
      });
      const heights = rows.map((r) => r.getBoundingClientRect().height).sort((a, b) => a - b);
      const before = main.scrollTop;
      main.scrollTop = before + 3000;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const headerTop = table.tHead.getBoundingClientRect().top - main.getBoundingClientRect().top;
      main.scrollTop = before;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {
        viewWidth: main.clientWidth,
        tableWidth: table.getBoundingClientRect().width,
        columnWidths: [...table.tHead.rows[0].cells].map((c) => Math.round(c.getBoundingClientRect().width)),
        rowHeightsInView: { min: heights[0], median: heights[Math.floor(heights.length / 2)], max: heights.at(-1) },
        headerStaysInViewAfterScroll: Math.abs(headerTop) < 2,
      };
    });

    // Scroll: the workspace <main> scrolls the List. Scroll it 120 px per
    // frame for 240 frames (about 700 rows) and record frame intervals and
    // long tasks, then jump to the middle and the end.
    const scrollBefore = await metrics(cdp);
    const scroll = await page.evaluate(async () => {
      const main = document.querySelector("main");
      const from = performance.now();
      const frames = [];
      let last = from;
      await new Promise((resolve) => {
        let n = 0;
        const step = (now) => {
          frames.push(now - last);
          last = now;
          if (n++ >= 240) return resolve();
          main.scrollBy(0, 120);
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      const jumps = [];
      for (const fraction of [0.5, 1]) {
        const t0 = performance.now();
        main.scrollTop = fraction * (main.scrollHeight - main.clientHeight);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const rect = main.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        jumps.push({
          fraction,
          ms: performance.now() - t0,
          rowAtCenter: !!hit?.closest("tbody tr td"),
        });
      }
      const longTasks = window.__longTasks.filter((t) => t.start >= from);
      const sorted = frames.slice(1).sort((a, b) => a - b);
      return {
        frames: sorted.length,
        meanFrameMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
        p95FrameMs: sorted[Math.floor(sorted.length * 0.95)],
        maxFrameMs: sorted.at(-1),
        framesOver50Ms: sorted.filter((f) => f > 50).length,
        longTasks: longTasks.length,
        longTaskMs: longTasks.reduce((n, t) => n + t.duration, 0),
        jumps,
        scrollHeight: main.scrollHeight,
      };
    });
    const scrollAfter = await metrics(cdp);

    // Realtime: a colleague renames the first task; time until the List
    // shows the new title (the realtime event refetches the task list).
    await page.evaluate(() => {
      document.querySelector("main").scrollTop = 0;
    });
    await page.waitForTimeout(500);
    const first = fixture.tasks[0];
    const renamed = `${first.title} renamed ${run}`;
    const realtimeStart = await page.evaluate(() => performance.now());
    await fixture.asColleague("PATCH", `/tasks/${first.id}`, { title: renamed });
    const realtimeAt = await page.waitForFunction(
      (title) => {
        const cell = document.querySelector(
          "table tbody > tr:nth-child(2) > td:nth-child(2)",
        );
        return cell?.textContent === title ? performance.now() : false;
      },
      renamed,
      { polling: "raf", timeout: 60_000 },
    );
    const realtimeShown = await realtimeAt.jsonValue();
    await page.waitForTimeout(1500);
    const realtime = await page.evaluate((from) => {
      const longTasks = window.__longTasks.filter((t) => t.start >= from);
      return {
        longTasks: longTasks.length,
        longTaskMs: longTasks.reduce((n, t) => n + t.duration, 0),
        longestTaskMs: Math.max(0, ...longTasks.map((t) => t.duration)),
      };
    }, realtimeStart);
    fixture.tasks[0] = { ...first, title: renamed };

    const result = {
      run,
      open: {
        rowsVisibleMs: rowsVisible - start,
        tasksResponseEndMs: load.tasksResponseEnd,
        renderAfterResponseMs:
          load.tasksResponseEnd === null ? null : rowsVisible - start - load.tasksResponseEnd,
        settledMs: Math.max(rowsVisible - start, load.settledAt),
        longTasks: load.longTasks,
        longTaskMs: load.longTaskMs,
        blockingMs: load.blockingMs,
        longestTaskMs: load.longestTaskMs,
        scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
        layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
        styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
        taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
      },
      dom: {
        elements: load.domElements,
        tableRows: load.tableRows,
        tableControls: load.controls,
        nodes: dom.nodes,
        jsEventListeners: dom.jsEventListeners,
      },
      memory: {
        jsHeapUsedMB: settledMemory.JSHeapUsedSize / 1048576,
        jsHeapTotalMB: settledMemory.JSHeapTotalSize / 1048576,
      },
      scroll: {
        ...scroll,
        scriptMs: (scrollAfter.ScriptDuration - scrollBefore.ScriptDuration) * 1000,
        layoutMs: (scrollAfter.LayoutDuration - scrollBefore.LayoutDuration) * 1000,
        styleMs:
          (scrollAfter.RecalcStyleDuration - scrollBefore.RecalcStyleDuration) * 1000,
      },
      realtime: { shownMs: realtimeShown - realtimeStart, ...realtime },
      layout,
    };
    log(`run ${run}`, JSON.stringify(result));
    return result;
  } finally {
    await context.close();
  }
}

function summarize(runs) {
  const pickPath = (p) => runs.map((r) => p.split(".").reduce((o, k) => o[k], r));
  const keys = [
    "open.rowsVisibleMs", "open.tasksResponseEndMs", "open.renderAfterResponseMs",
    "open.settledMs", "open.blockingMs", "open.longestTaskMs", "open.scriptMs",
    "open.layoutMs", "open.styleMs", "open.taskMs", "dom.elements", "dom.tableRows",
    "dom.tableControls", "dom.nodes", "dom.jsEventListeners", "memory.jsHeapUsedMB",
    "scroll.meanFrameMs", "scroll.p95FrameMs", "scroll.maxFrameMs",
    "scroll.framesOver50Ms", "scroll.longTasks", "scroll.longTaskMs",
    "scroll.scriptMs", "scroll.layoutMs", "scroll.styleMs", "realtime.shownMs",
    "realtime.longTaskMs", "realtime.longestTaskMs",
  ];
  return Object.fromEntries(
    keys.map((k) => {
      const values = pickPath(k);
      return [k, { median: median(values), min: Math.min(...values), max: Math.max(...values) }];
    }),
  );
}

// ─── Smoke ──────────────────────────────────────────────────

const frames = (page, n = 2) =>
  page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const step = (left) =>
          left ? requestAnimationFrame(() => step(left - 1)) : resolve();
        step(n);
      }),
    n,
  );

async function waitFor(check, label, timeout = 20_000) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// What the List shows: mounted rows, ARIA indexes and the rows in view.
const listState = (page) =>
  page.evaluate(() => {
    const main = document.querySelector("main");
    const table = document.querySelector("table");
    const view = main.getBoundingClientRect();
    const rows = [...table.tBodies[0].rows].filter(
      (r) => !r.hasAttribute("aria-hidden"),
    );
    const inView = rows.filter((r) => {
      const b = r.getBoundingClientRect();
      return b.bottom > view.top && b.top < view.bottom;
    });
    return {
      rowCount: Number(table.getAttribute("aria-rowcount")),
      mounted: rows.length,
      mountedTasks: rows.filter((r) => r.dataset.taskId).length,
      indexes: rows.map((r) => Number(r.getAttribute("aria-rowindex"))),
      inView: inView.map((r) => ({
        index: Number(r.getAttribute("aria-rowindex")),
        id: r.dataset.taskId ?? null,
        text: r.cells[r.dataset.taskId ? 1 : 0]?.textContent ?? "",
      })),
      scrollTop: main.scrollTop,
      scrollHeight: main.scrollHeight,
      headerWidths: [...table.tHead.rows[0].cells].map(
        (c) => c.getBoundingClientRect().width,
      ),
      taskRowHeights: rows
        .filter((r) => r.dataset.taskId)
        .map((r) => r.getBoundingClientRect().height),
    };
  });

// Scrolls <main> until the row with this aria-rowindex is in the middle of
// the view, steering by the rows that are rendered.
async function scrollToRow(page, target) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const done = await page.evaluate((target) => {
      const main = document.querySelector("main");
      const view = main.getBoundingClientRect();
      const row = document.querySelector(`tbody tr[aria-rowindex="${target}"]`);
      if (row) {
        const b = row.getBoundingClientRect();
        if (b.top >= view.top + 120 && b.bottom <= view.bottom - 120) return true;
        // Near either end of the list the row cannot reach the middle.
        const atEdge =
          main.scrollTop === 0 ||
          main.scrollTop >= main.scrollHeight - main.clientHeight - 1;
        if (atEdge && b.top >= view.top && b.bottom <= view.bottom) return true;
        main.scrollTop += b.top - (view.top + view.height / 2);
        return false;
      }
      const rows = [...document.querySelectorAll("tbody tr[aria-rowindex]")];
      const near =
        rows.find((r) => r.getBoundingClientRect().bottom > view.top + 40) ??
        rows[0];
      main.scrollTop +=
        (target - Number(near.getAttribute("aria-rowindex"))) * 41;
      return false;
    }, target);
    if (done) return;
    await frames(page);
  }
  throw new Error(`row ${target} was not reached`);
}

const activeInfo = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    const row = el?.closest("tr");
    return {
      tag: el?.tagName ?? null,
      label: el?.getAttribute("aria-label") ?? null,
      text: el?.textContent?.trim() ?? "",
      rowId: row?.dataset.taskId ?? null,
      rowIndex: row ? Number(row.getAttribute("aria-rowindex")) : null,
      cell: el?.closest("td")?.cellIndex ?? null,
      inView: (() => {
        if (!el) return false;
        const v = document.querySelector("main").getBoundingClientRect();
        const b = el.getBoundingClientRect();
        return b.bottom > v.top && b.top < v.bottom;
      })(),
    };
  });

// Clicks with a record of the List at each step of the click, printed when
// the click does not have its effect.
async function clickChecked(page, locator, effect, label) {
  await page.evaluate(() => {
    window.__clickTrace = [];
    if (window.__clickTraceInstalled) return;
    window.__clickTraceInstalled = true;
    const snap = (type, event) => {
      const main = document.querySelector("main");
      const table = document.querySelector("table");
      if (!main || !table) return;
      const rows = [...table.tBodies[0].rows];
      window.__clickTrace.push({
        type,
        target: event?.target?.tagName,
        x: event?.clientX, y: event?.clientY,
        at: performance.now(),
        scrollTop: main.scrollTop, scrollHeight: main.scrollHeight,
        rows: rows.map((r) => r.hasAttribute("aria-hidden")
          ? `gap:${r.getBoundingClientRect().height.toFixed(1)}`
          : `${r.getAttribute("aria-rowindex")}@${r.getBoundingClientRect().top.toFixed(1)}`).join(" "),
      });
    };
    for (const type of ["pointerdown", "mousedown", "focusin", "mouseup", "click"])
      document.addEventListener(type, (e) => snap(type, e), { capture: true });
    document.addEventListener("focusin", () => setTimeout(() => snap("focusin+task"), 0), { capture: true });
  });
  await locator.click();
  await frames(page, 2);
  if (await effect()) return;
  for (const entry of await page.evaluate(() => window.__clickTrace))
    log("click trace", label, JSON.stringify(entry));
  throw new Error(`click had no effect: ${label}`);
}

async function smoke({ browser, origin, fixture, prisma }) {
  const checks = [];
  const steps = process.env.TASK_LIST_STEPS?.split(",");
  const want = (step) => !steps || steps.includes(step);
  const pass = (name, details = {}) => {
    checks.push({ name, ...details });
    log("ok", name, JSON.stringify(details));
  };
  // aria-rowindex of the i-th fixture task: one header row, then each
  // status group's header row before its tasks.
  const bounds = [];
  {
    let start = 0;
    for (const status of fixture.statuses) {
      const count = fixture.tasks.filter((t) => t.statusId === status.id).length;
      bounds.push({ status, start, count });
      start += count;
    }
  }
  const ariaIndexOf = (i) => {
    const group = bounds.findIndex((b) => i >= b.start && i < b.start + b.count);
    return 1 + group + 1 + i + 1;
  };
  const total = 1 + fixture.statuses.length + fixture.tasks.length;
  const cellButton = (taskId, column) =>
    page.locator(`tbody tr[data-task-id="${taskId}"] > td:nth-child(${column}) button`).first();
  const { context, page } = await openContext(browser, origin, fixture);
  try {
    await page.goto(origin + listPath(fixture));
    await page.waitForFunction(
      (title) =>
        document.querySelector("table tbody > tr:nth-child(2) > td:nth-child(2)")
          ?.textContent === title,
      fixture.tasks[0].title,
      { polling: 250, timeout: 120_000 },
    );
    await frames(page, 4);

    const shot = async (name) => {
      if (process.env.TASK_LIST_SCREENSHOTS)
        await page.screenshot({ path: path.join(process.env.TASK_LIST_SCREENSHOTS, `${name}.png`) });
    };
    await shot("01-top");
    let state = await listState(page);
    let active;

    if (want("aria")) {
      // 1. Only the rows in view plus overscan are rendered; ARIA describes
      // the whole list.
      assert.equal(state.rowCount, total);
      assert(state.mountedTasks > 5 && state.mountedTasks < 80, `${state.mountedTasks} task rows mounted`);
      // The rows near the view, then the last row (always rendered, so
      // Shift+Tab from below the table reaches it).
      const near = state.indexes.slice(0, -1);
      assert.deepEqual(near, near.map((_, i) => 2 + i), "contiguous aria-rowindex at the top");
      assert.equal(state.indexes.at(-1), total, "last row rendered");
      assert.equal(state.inView[0].text.startsWith(bounds[0].status.name), true);
      const heights = [...new Set(state.taskRowHeights.map((h) => h.toFixed(2)))];
      pass("windowed rows and aria", {
        rowCount: state.rowCount,
        mounted: state.mounted,
        taskRowHeights: heights,
      });

    }
    if (want("scroll")) {
      // 2. Scroll to the end, then up through rows never measured: rows in
      // view must not jump, and the column widths must not change.
      const widths = [state.headerWidths];
      for (const fraction of [0.25, 0.5, 0.75]) {
        await page.evaluate((f) => {
          const main = document.querySelector("main");
          main.scrollTop = f * (main.scrollHeight - main.clientHeight);
        }, fraction);
        await frames(page, 3);
        widths.push((await listState(page)).headerWidths);
      }
      // End of the list, like pressing End: rows not measured before have
      // estimated heights, so the first press can land a few rows short;
      // count the presses (at most three) to reach the last row.
      let endPresses = 0;
      do {
        endPresses++;
        await page.evaluate(() => {
          const main = document.querySelector("main");
          main.scrollTop = main.scrollHeight;
        });
        await frames(page, 6);
        state = await listState(page);
      } while (state.inView.at(-1).index !== total && endPresses < 3);
      widths.push(state.headerWidths);
      const last = state.inView.at(-1);
      assert.equal(last.index, total, "last row in view at the end");
      assert.equal(last.id, fixture.tasks.at(-1).id);
      assert(state.mountedTasks < 80);
      const widthDelta = Math.max(
        ...widths[0].map((_, c) => Math.max(...widths.map((w) => w[c])) - Math.min(...widths.map((w) => w[c]))),
      );
      const upward = await page.evaluate(async () => {
        const main = document.querySelector("main");
        const deviations = [];
        for (let i = 0; i < 150; i++) {
          const view = main.getBoundingClientRect();
          const anchor = [...document.querySelectorAll("tbody tr[data-task-id]")].find(
            (r) => r.getBoundingClientRect().top >= view.top,
          );
          const id = anchor.dataset.taskId;
          const before = anchor.getBoundingClientRect().top;
          // A row in view must move down on screen by exactly the distance
          // scrolled, however scroll anchoring adjusts scrollTop meanwhile.
          const requested = Math.min(90, main.scrollTop);
          main.scrollBy(0, -90);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const now = document.querySelector(`tbody tr[data-task-id="${id}"]`);
          if (!now) continue;
          deviations.push(now.getBoundingClientRect().top - before - requested);
        }
        return {
          samples: deviations.length,
          maxDeviation: Math.max(...deviations.map(Math.abs)),
          jumps: deviations.filter((d) => Math.abs(d) > 1.5).length,
        };
      });
      assert(upward.samples > 100, "upward samples");
      assert.equal(upward.jumps, 0, `visible rows jumped while scrolling up: ${JSON.stringify(upward)}`);
      await shot("02-end");
      pass("scroll to end and back up without jumps", {
        lastRowIndex: last.index,
        endPresses,
        mountedTasks: state.mountedTasks,
        upward,
        maxColumnWidthChangePx: widthDelta,
      });

    }
    if (want("keyboard")) {
      // 3. Keyboard: Tab through rows past the first rendered window; each
      // row's controls come in order and focus stays in view.
      await page.evaluate(() => (document.querySelector("main").scrollTop = 0));
      await frames(page, 3);
      await page.locator(`tbody tr[data-task-id="${fixture.tasks[0].id}"] input[type=checkbox]`).first().focus();
      active = await activeInfo(page);
      assert.equal(active.rowId, fixture.tasks[0].id);
      const stopsPerRow = 13;
      for (let row = 1; row <= 45; row++) {
        for (let i = 0; i < stopsPerRow; i++) await page.keyboard.press("Tab");
        active = await activeInfo(page);
        assert.equal(active.rowId, fixture.tasks[row].id, `Tab reached row ${row}`);
        assert.equal(active.cell, 0, "row starts at its checkbox");
        assert(active.inView, "focused control scrolled into view");
      }
      for (let i = 0; i < stopsPerRow; i++) await page.keyboard.press("Shift+Tab");
      active = await activeInfo(page);
      assert.equal(active.rowId, fixture.tasks[44].id, "Shift+Tab back one row");
      assert.equal(active.cell, 0);
      const mountedAfterTab = (await listState(page)).mountedTasks;
      assert(mountedAfterTab < 80);
      pass("Tab and Shift+Tab across the window", {
        rowsTraversed: 45,
        tabStopsPerRow: stopsPerRow,
        mountedTasks: mountedAfterTab,
      });

      // Keyboard open: Enter on the task title opens it; Escape returns focus
      // to the same title at the same scroll position.
      await page.keyboard.press("Tab");
      active = await activeInfo(page);
      assert.equal(active.cell, 1);
      const opened = fixture.tasks[44];
      const scrollBeforeOpen = (await listState(page)).scrollTop;
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => url.searchParams.get("task") === opened.id);
      await waitFor(
        async () => (await page.getByLabel("Task title").inputValue().catch(() => "")) === opened.title,
        "task panel title",
      );
      // Scroll the List behind the panel far away, as a long panel visit might.
      await page.keyboard.press("Escape");
      await page.waitForURL((url) => !url.searchParams.has("task"));
      await waitFor(async () => (await activeInfo(page)).rowId === opened.id, "focus back on the title");
      active = await activeInfo(page);
      const scrollAfterClose = (await listState(page)).scrollTop;
      assert.equal(active.cell, 1);
      assert(Math.abs(scrollAfterClose - scrollBeforeOpen) <= 2, `scroll ${scrollBeforeOpen} -> ${scrollAfterClose}`);
      pass("keyboard open and close keep focus and scroll", {
        task: opened.title,
        scrollBeforeOpen,
        scrollAfterClose,
      });

      // Group boundary: Tab from the last task of the first group reaches the
      // next group's header, then that group's first task.
      const lastOfFirst = bounds[0].start + bounds[0].count - 1;
      await scrollToRow(page, ariaIndexOf(lastOfFirst));
      await page
        .locator(`tbody tr[data-task-id="${fixture.tasks[lastOfFirst].id}"] > td:last-child input[type=checkbox]`)
        .focus();
      await page.keyboard.press("Tab");
      active = await activeInfo(page);
      assert(active.text.startsWith(bounds[1].status.name), `group header focused: ${active.text}`);
      await page.keyboard.press("Tab");
      active = await activeInfo(page);
      assert.equal(active.rowId, fixture.tasks[bounds[1].start].id);
      // Tab from the header checkbox reaches the first row of the List (as
      // with every row rendered), not the row that last had focus.
      await page.getByRole("checkbox", { name: "Select all tasks" }).focus();
      await page.keyboard.press("Tab");
      active = await activeInfo(page);
      assert(active.text.startsWith(bounds[0].status.name), `Tab from the header reached: ${active.text}`);
      assert.equal(active.rowIndex, 2);
      pass("Tab across a status group header and from the header row", {
        header: bounds[1].status.name,
        fromHeaderRow: active.rowIndex,
      });

    }
    if (want("selection")) {
      // 4. Selection kept across distant rows; bulk priority change.
      const picks = [1, Math.floor(fixture.tasks.length / 2), fixture.tasks.length - 2];
      for (const i of picks) {
        await scrollToRow(page, ariaIndexOf(i));
        const box = page.locator(`tbody tr[data-task-id="${fixture.tasks[i].id}"] > td:first-child input`);
        await clickChecked(page, box, () => box.isChecked(), `select task ${i}`);
      }
      await page.getByText("3 tasks selected").waitFor();
      await page.evaluate(() => (document.querySelector("main").scrollTop = 0));
      await frames(page, 3);
      assert.equal(
        await page.locator(`tbody tr[data-task-id="${fixture.tasks[1].id}"] > td:first-child input`).isChecked(),
        true,
      );
      const bulk = page.waitForResponse((r) => r.url().includes("/tasks/bulk-update"));
      await page.locator("select").filter({ hasText: "Change priority" }).selectOption("URGENT");
      assert.equal((await bulk).status(), 200);
      await page.getByText("3 tasks selected").waitFor({ state: "detached" });
      const urgent = await prisma.task.findMany({
        where: { id: { in: picks.map((i) => fixture.tasks[i].id) } },
        select: { priority: true },
      });
      assert.deepEqual(urgent.map((t) => t.priority), ["URGENT", "URGENT", "URGENT"]);
      await page.getByRole("checkbox", { name: "Select all tasks" }).check();
      await page.getByText(`${fixture.tasks.length} tasks selected`).waitFor();
      await page.getByText("(max 50)").waitFor();
      await page.getByTitle("Clear selection").click();
      await page.getByText(`${fixture.tasks.length} tasks selected`).waitFor({ state: "detached" });
      pass("selection across the window and bulk update", {
        selected: picks,
        selectAll: fixture.tasks.length,
      });

    }
    if (want("edit")) {
      // 5. Inline edits. A custom-field draft survives scrolling far away and
      // is saved for its own task; a draft left by clicking another row is
      // saved on blur; a due date edit far down the list is saved.
      const notesColumn = 8;
      const edited = fixture.tasks[Math.floor(fixture.tasks.length * 0.52)];
      await scrollToRow(page, ariaIndexOf(fixture.tasks.indexOf(edited)));
      const input = page.locator(`tbody tr[data-task-id="${edited.id}"] input[type=text]`);
      await clickChecked(page, cellButton(edited.id, notesColumn), async () => (await input.count()) === 1, "open notes editor");
      await input.fill("Draft kept while scrolled away");
      await shot("05-notes-editor");
      await page.evaluate(() => (document.querySelector("main").scrollTop = 0));
      await frames(page, 4);
      assert.equal(await input.evaluate((el) => el.isConnected && document.activeElement === el), true);
      assert.equal(await input.inputValue(), "Draft kept while scrolled away");
      await page.keyboard.press("Enter");
      await waitFor(
        async () =>
          (await prisma.customFieldValue.findUnique({
            where: { taskId_fieldId: { taskId: edited.id, fieldId: fixture.fields.TEXT.id } },
          }))?.value === "Draft kept while scrolled away",
        "custom field saved",
      );
      const blurred = fixture.tasks[Math.floor(fixture.tasks.length * 0.53)];
      await scrollToRow(page, ariaIndexOf(fixture.tasks.indexOf(blurred)));
      await clickChecked(
        page,
        cellButton(blurred.id, notesColumn),
        async () => (await page.locator(`tbody tr[data-task-id="${blurred.id}"] input[type=text]`).count()) === 1,
        "open second notes editor",
      );
      await page.locator(`tbody tr[data-task-id="${blurred.id}"] input[type=text]`).fill("Saved when another row was clicked");
      await page.evaluate(() => (document.querySelector("main").scrollTop = 0));
      await frames(page, 4);
      await cellButton(fixture.tasks[2].id, notesColumn + 1).click();
      await waitFor(
        async () =>
          (await prisma.customFieldValue.findUnique({
            where: { taskId_fieldId: { taskId: blurred.id, fieldId: fixture.fields.TEXT.id } },
          }))?.value === "Saved when another row was clicked",
        "blur save",
      );
      await page.keyboard.press("Escape");
      const dated = fixture.tasks[Math.floor(fixture.tasks.length * 0.74)];
      await scrollToRow(page, ariaIndexOf(fixture.tasks.indexOf(dated)));
      const dateInput = page.locator(`tbody tr[data-task-id="${dated.id}"] input[type=date]`);
      await clickChecked(page, cellButton(dated.id, 7), async () => (await dateInput.count()) === 1, "open due date editor");
      await shot("05-date-editor");
      // The native date editor can be wider than its column (it is drawn
      // above the next cell); recorded for the report.
      const dateEditor = await dateInput.evaluate((el) => ({
        editorWidth: el.getBoundingClientRect().width,
        columnWidth: el.closest("td").getBoundingClientRect().width,
      }));
      await dateInput.fill("2027-03-15");
      await waitFor(
        async () =>
          (await prisma.task.findUnique({ where: { id: dated.id } })).dueDate === "2027-03-15",
        "due date saved",
      );
      pass("inline edits survive windowing", {
        customField: edited.title,
        blurSave: blurred.title,
        dueDate: dated.title,
        dateEditor,
      });

    }
    if (want("realtime")) {
      // 6. Realtime: a colleague adds a task and deletes one in view.
      const before = (await listState(page)).rowCount;
      const created = await fixture.asColleague("POST", `/projects/${fixture.project.id}/tasks`, {
        title: "Task created by a colleague",
        statusId: fixture.statuses[0].id,
      });
      assert.equal(created.status, 201);
      const createdTask = created.body.data;
      await waitFor(async () => (await listState(page)).rowCount === before + 1, "realtime insert");
      const firstGroup = await prisma.task.findMany({
        where: { projectId: fixture.project.id, statusId: fixture.statuses[0].id, archived: false },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      const createdAt = 2 + firstGroup.findIndex((t) => t.id === createdTask.id) + 1;
      await scrollToRow(page, createdAt);
      assert.equal(
        await page.locator(`tbody tr[aria-rowindex="${createdAt}"]`).getAttribute("data-task-id"),
        createdTask.id,
      );
      state = await listState(page);
      const victim = state.inView.find((r) => r.id && r.index > createdAt - 5 && r.id !== createdTask.id);
      const next = state.inView.find((r) => r.index === victim.index + 1);
      await fixture.asColleague("DELETE", `/tasks/${victim.id}`);
      await waitFor(async () => (await listState(page)).rowCount === before, "realtime delete");
      await frames(page, 3);
      assert.equal(await page.locator(`tbody tr[data-task-id="${victim.id}"]`).count(), 0);
      assert.equal(
        await page.locator(`tbody tr[aria-rowindex="${victim.index}"]`).getAttribute("data-task-id"),
        next.id,
      );
      pass("realtime insert and delete", { created: createdTask.id, deleted: victim.id });

    }
    if (want("collapse")) {
      // 7. Collapsing a group removes its rows from the count; expanding
      // brings them back.
      await page.evaluate(() => (document.querySelector("main").scrollTop = 0));
      await frames(page, 3);
      const before = (await listState(page)).rowCount;
      const groupSize = await prisma.task.count({
        where: { projectId: fixture.project.id, statusId: fixture.statuses[0].id, archived: false },
      });
      await page.getByRole("button", { name: new RegExp(`^${fixture.statuses[0].name} ${groupSize} tasks$`) }).click();
      await waitFor(async () => (await listState(page)).rowCount === before - groupSize, "collapse");
      state = await listState(page);
      assert.equal(state.inView[1].text.startsWith(fixture.statuses[1].name), true);
      await page.getByRole("button", { name: new RegExp(`^${fixture.statuses[0].name} ${groupSize} tasks$`) }).click();
      await waitFor(async () => (await listState(page)).rowCount === before, "expand");
      pass("collapse and expand a group", { groupSize });
    }
    // Helpers for the steps below that change tasks as a second user. Rows
    // are found by title and positions come from the database, so these
    // steps also run on builds that render every row.
    const statusOrder = fixture.statuses.map((s) => s.id);
    const expectedIndex = async (taskId) => {
      const tasks = await prisma.task.findMany({
        where: { projectId: fixture.project.id, archived: false },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true, statusId: true },
      });
      let index = 0;
      for (const statusId of statusOrder) {
        index++; // group header row
        for (const task of tasks.filter((t) => t.statusId === statusId)) {
          if (task.id === taskId) return index;
          index++;
        }
      }
      throw new Error(`task ${taskId} not in the List`);
    };
    // Index in the List of the rendered row with this title, and its top
    // relative to <main>'s view.
    const rowAt = (title) =>
      page.evaluate((title) => {
        const main = document.querySelector("main");
        const rows = [...document.querySelector("table").tBodies[0].rows];
        let domIndex = -1;
        const row = rows.find((r) => {
          if (!r.hasAttribute("aria-hidden")) domIndex++;
          return r.cells[1]?.textContent === title;
        });
        if (!row) return null;
        const aria = row.getAttribute("aria-rowindex");
        return {
          index: aria ? Number(aria) - 2 : domIndex,
          top: row.getBoundingClientRect().top - main.getBoundingClientRect().top,
        };
      }, title);
    const api = async (method, url, body) => (await fixture.asColleague(method, url, body)).body;
    // Task rows in view, top to bottom, relative to <main>'s view.
    const rowsInView = () =>
      page.evaluate(() => {
        const view = document.querySelector("main").getBoundingClientRect();
        return [...document.querySelector("table").tBodies[0].rows]
          .filter((r) => {
            const b = r.getBoundingClientRect();
            return r.cells.length > 1 && b.bottom > view.top + 1 && b.top < view.bottom;
          })
          .map((r) => ({ title: r.cells[1].textContent, top: r.getBoundingClientRect().top - view.top }));
      });
    const taskByTitle = (title) =>
      prisma.task.findFirst({ where: { projectId: fixture.project.id, title }, select: { id: true, statusId: true } });

    if (want("anchor")) {
      // 8. A colleague's changes above the view (created, deleted, moved
      // in) must not move the rows in view, and a click where the pointer
      // rests must still hit the same task.
      const [, inProgress, review, done] = fixture.statuses;
      const doneTasks = fixture.tasks.filter((t) => t.statusId === done.id);
      const reference = doneTasks[Math.floor(doneTasks.length * 0.6)];
      // Earlier edits may have scrolled the table sideways; the checkbox
      // column must be in view for the click below.
      await page.evaluate(() => {
        document.querySelector("main").scrollTop = 0;
        document.querySelector("table").parentElement.scrollLeft = 0;
      });
      await frames(page, 3);
      // Builds that render every row have no aria-rowindex to steer by.
      const centred = await page.evaluate((title) => {
        const row = [...document.querySelector("table").tBodies[0].rows].find(
          (r) => r.cells[1]?.textContent === title,
        );
        row?.scrollIntoView({ block: "center" });
        return !!row;
      }, reference.title);
      if (!centred) await scrollToRow(page, (await expectedIndex(reference.id)) + 2);
      await frames(page, 6);
      const start = await rowAt(reference.title);
      assert(start, "reference row in view");
      // Each change: wait until the List shows it (the reference row's index
      // moved as the database says), then compare the reference row's place.
      const shifts = {};
      const settle = async (label) => {
        const index = await expectedIndex(reference.id);
        await waitFor(async () => (await rowAt(reference.title))?.index === index, label);
        await frames(page, 6);
        const now = await rowAt(reference.title);
        shifts[label] = Math.round((now.top - start.top) * 100) / 100;
      };
      for (let i = 0; i < 3; i++)
        await api("POST", `/projects/${fixture.project.id}/tasks`, {
          title: `Colleague task above ${i}`,
          statusId: review.id,
        });
      await settle("3 created above");
      const progressTasks = await prisma.task.findMany({
        where: { projectId: fixture.project.id, statusId: inProgress.id },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
        take: 40,
      });
      await api("DELETE", `/tasks/${progressTasks[10].id}`);
      await api("DELETE", `/tasks/${progressTasks[30].id}`);
      await settle("2 deleted above");
      await api("PATCH", `/tasks/${doneTasks.at(-1).id}/move`, { statusId: review.id, position: 0 });
      await settle("1 moved in from below");
      // A bulk change moves more rows above the view than the rendered range
      // holds, so none of the rows that were in view is rendered afterwards.
      const below = await prisma.task.findMany({
        where: { projectId: fixture.project.id, statusId: done.id },
        orderBy: [{ position: "desc" }],
        select: { id: true },
        take: 50,
      });
      await api("POST", `/projects/${fixture.project.id}/tasks/bulk-update`, {
        taskIds: below.map((t) => t.id),
        statusId: review.id,
      });
      await settle("50 moved in from below (bulk)");
      // The first three rows in view are deleted; the reference row below
      // them stays.
      const topTitles = await page.evaluate(() => {
        const main = document.querySelector("main").getBoundingClientRect();
        return [...document.querySelector("table").tBodies[0].rows]
          .filter((r) => r.cells.length > 1 && r.getBoundingClientRect().bottom > main.top + 1)
          .slice(0, 3)
          .map((r) => r.cells[1].textContent);
      });
      assert(!topTitles.includes(reference.title));
      const topIds = await prisma.task.findMany({
        where: { projectId: fixture.project.id, title: { in: topTitles } },
        select: { id: true },
      });
      for (const { id } of topIds) await api("DELETE", `/tasks/${id}`);
      await settle("first 3 rows in view deleted");
      log("anchor shifts (from the starting place)", JSON.stringify(shifts));

      // The pointer rests on the reference row's checkbox while a colleague
      // adds tasks above; the click then lands on the same task.
      const box = await page.evaluate((title) => {
        const row = [...document.querySelector("table").tBodies[0].rows].find(
          (r) => r.cells[1]?.textContent === title,
        );
        const b = row.cells[0].querySelector("input").getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }, reference.title);
      await page.mouse.move(box.x, box.y);
      for (let i = 0; i < 3; i++)
        await api("POST", `/projects/${fixture.project.id}/tasks`, {
          title: `Colleague task before the click ${i}`,
          statusId: inProgress.id,
        });
      await settle("3 created before the click");
      const underPointer = () =>
        page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          const row = el?.closest("tr");
          return `${el?.tagName}:${el?.getAttribute("aria-label") ?? ""}|${row?.cells[1]?.textContent ?? ""}`;
        }, box);
      const pointerTarget = await underPointer();
      await page.mouse.down();
      await page.mouse.up();
      await frames(page, 3);
      const checked = await page.evaluate(() =>
        [...document.querySelector("table").tBodies[0].rows]
          .filter((r) => r.cells[0]?.querySelector("input")?.checked)
          .map((r) => r.cells[1].textContent),
      );
      log("anchor click", JSON.stringify({ checked, pointerTarget, after: await underPointer() }));
      await page.getByTitle("Clear selection").click().catch(() => {});
      for (const [label, shift] of Object.entries(shifts))
        assert(Math.abs(shift) <= 1, `rows in view moved ${shift}px after: ${label}`);
      assert.deepEqual(checked, [reference.title], "click at the resting pointer hit the same task");
      pass("changes above the view keep rows in view still", { shifts, clickedTask: checked });
    }
    if (want("edges")) {
      // 9. The same at the edges: a colleague moving the row at the top of
      // the view a few places down keeps the rows after it, as does a swap
      // of the two top rows; content above
      // the table changing height keeps the rows; and at (or just before)
      // the end of the List, deletions above keep the rows and a click
      // where the pointer rests still hits its task.
      const [, inProgress, , done] = fixture.statuses;
      const shift = async (title, from) => {
        const now = await rowAt(title);
        return now ? Math.round((now.top - from) * 100) / 100 : null;
      };
      const settleOn = async (title, taskId, label) => {
        const index = await expectedIndex(taskId);
        await waitFor(async () => (await rowAt(title))?.index === index, label);
        await frames(page, 6);
      };
      const deleteAbove = async (count) => {
        const above = await prisma.task.findMany({
          where: { projectId: fixture.project.id, statusId: inProgress.id },
          orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          select: { id: true },
          skip: 50,
          take: count,
        });
        for (const { id } of above) await api("DELETE", `/tasks/${id}`);
      };
      const result = {};
      await page.evaluate(() => (document.querySelector("table").parentElement.scrollLeft = 0));

      // The topmost row, partly in view, moved three places down in its group.
      const doneTasks = await prisma.task.findMany({
        where: { projectId: fixture.project.id, statusId: done.id },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true, title: true },
      });
      const middle = doneTasks[Math.floor(doneTasks.length / 2)];
      const centred = await page.evaluate((title) => {
        const row = [...document.querySelector("table").tBodies[0].rows].find((r) => r.cells[1]?.textContent === title);
        row?.scrollIntoView({ block: "start" });
        return !!row;
      }, middle.title);
      if (!centred) await scrollToRow(page, (await expectedIndex(middle.id)) + 2);
      await frames(page, 4);
      await page.evaluate(() => {
        // Leave the first row in view partly scrolled out.
        const main = document.querySelector("main");
        const view = main.getBoundingClientRect();
        const first = [...document.querySelector("table").tBodies[0].rows].find(
          (r) => r.cells.length > 1 && r.getBoundingClientRect().bottom > view.top + 1,
        );
        main.scrollTop += first.getBoundingClientRect().top - view.top + 15;
      });
      await frames(page, 6);
      let view = await rowsInView();
      assert(view[0].top < 0, "first row partly in view");
      const moving = view[0], second = view[1], sixth = view[5];
      const movingTask = await taskByTitle(moving.title);
      const secondTask = await taskByTitle(second.title);
      const group = doneTasks.map((t) => t.id);
      assert.equal(movingTask.statusId, done.id);
      await api("PATCH", `/tasks/${movingTask.id}/move`, {
        statusId: done.id,
        position: group.indexOf(movingTask.id) + 3,
      });
      await settleOn(second.title, secondTask.id, "top row moved down");
      result.topRowMovedDown = {
        movedRow: await shift(moving.title, moving.top),
        secondRow: await shift(second.title, second.top),
        sixthRow: await shift(sixth.title, sixth.top),
      };

      // The two top rows in view swap places (the first moved one place
      // down): the rows after them stay. (With every row rendered, the
      // browser's anchoring keeps the second row instead and moves the rows
      // after the pair by one row; recorded, not asserted, there.)
      const windowed = await page.evaluate(() => document.querySelector("table").hasAttribute("aria-rowcount"));
      view = await rowsInView();
      const [upper, lower, third] = view;
      const upperTask = await taskByTitle(upper.title);
      const thirdTask = await taskByTitle(third.title);
      const order = (await prisma.task.findMany({
        where: { projectId: fixture.project.id, statusId: upperTask.statusId },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      })).map((t) => t.id);
      await api("PATCH", `/tasks/${upperTask.id}/move`, {
        statusId: upperTask.statusId,
        position: order.indexOf(upperTask.id) + 1,
      });
      await settleOn(upper.title, upperTask.id, "top two rows swapped");
      result.topRowsSwapped = {
        thirdRow: await shift(third.title, third.top),
        swapped: [await shift(upper.title, upper.top), await shift(lower.title, lower.top)],
      };
      assert.equal(thirdTask.statusId, upperTask.statusId);

      // Content above the table grows by 200 px and shrinks back.
      view = await rowsInView();
      const steady = view[4];
      await page.evaluate(() => {
        const block = document.createElement("div");
        block.id = "task-list-smoke-above";
        block.style.height = "200px";
        document.querySelector("table").parentElement.before(block);
      });
      await frames(page, 6);
      const grown = await shift(steady.title, steady.top);
      await page.evaluate(() => document.getElementById("task-list-smoke-above").remove());
      await frames(page, 6);
      result.contentAboveTable = { grown200: grown, shrunkBack: await shift(steady.title, steady.top) };

      // At the end of the List, and 20 px before it, a colleague deletes
      // tasks above the view.
      const toEnd = async (offset = 0) => {
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => {
            const main = document.querySelector("main");
            main.scrollTop = main.scrollHeight;
          });
          await frames(page, 6);
        }
        await page.evaluate((offset) => (document.querySelector("main").scrollTop -= offset), offset);
        await frames(page, 6);
      };
      const spaceBelow = () =>
        page.evaluate(() => {
          const main = document.querySelector("main");
          return Math.round(main.scrollHeight - main.scrollTop - main.clientHeight);
        });
      for (const [label, offset, count] of [["at the end", 0, 1], ["20 px before the end", 20, 1]]) {
        await toEnd(offset);
        view = await rowsInView();
        const reference = view.at(-5);
        const referenceTask = await taskByTitle(reference.title);
        const below = await spaceBelow();
        await deleteAbove(count);
        await settleOn(reference.title, referenceTask.id, label);
        result[label] = {
          deletedAbove: count,
          shift: await shift(reference.title, reference.top),
          spaceBelowBefore: below,
          spaceBelowAfter: await spaceBelow(),
        };
      }

      // At the end, the pointer rests on a checkbox while two tasks above
      // the view are deleted, then clicks.
      await toEnd();
      view = await rowsInView();
      const target = view.at(-3);
      const targetTask = await taskByTitle(target.title);
      const box = await page.evaluate((title) => {
        const row = [...document.querySelector("table").tBodies[0].rows].find((r) => r.cells[1]?.textContent === title);
        const b = row.cells[0].querySelector("input").getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }, target.title);
      await page.mouse.move(box.x, box.y);
      await deleteAbove(2);
      await settleOn(target.title, targetTask.id, "deletes before the click at the end");
      await page.mouse.down();
      await page.mouse.up();
      await frames(page, 3);
      result.clickAtEnd = {
        target: target.title,
        checked: await page.evaluate(() =>
          [...document.querySelector("table").tBodies[0].rows]
            .filter((r) => r.cells[0]?.querySelector("input")?.checked)
            .map((r) => r.cells[1].textContent),
        ),
      };
      await page.getByTitle("Clear selection").click().catch(() => {});
      log("edges", JSON.stringify(result));
      assert(Math.abs(result.topRowMovedDown.secondRow) <= 1, "second row stays when the top row moves down");
      if (windowed)
        assert(Math.abs(result.topRowsSwapped.thirdRow) <= 1, "third row stays when the top two rows swap");
      assert(Math.abs(result.contentAboveTable.grown200) <= 1, "rows stay when content above the table grows");
      assert(Math.abs(result.contentAboveTable.shrunkBack) <= 1, "rows stay when content above the table shrinks");
      for (const label of ["at the end", "20 px before the end"]) {
        assert(Math.abs(result[label].shift) <= 1, `rows stay after deletes above ${label}`);
        assert(Math.abs(result[label].spaceBelowAfter - result[label].spaceBelowBefore) <= 1, `no gap below ${label}`);
      }
      assert.deepEqual(result.clickAtEnd.checked, [target.title], "click at the end hit its task");
      pass("edges: a moved top row, content above the table, the end of the List", result);
    }
    if (want("bulk")) {
      // 10. A bulk move of the top block of rows in view (more than half of
      // them, the partly visible top row included) to the last group: the
      // rows that stayed keep their place and a click where the pointer
      // rests hits its task. By a colleague, by a colleague right after a
      // short scroll (less than half the view, enough to take the rows seen
      // before it out of the rendered range), and by the user's own bulk
      // status change with a sliver of the row above the block in view.
      // (With every row rendered, the user's own bulk change lets the rows
      // that stayed slide up into the space instead; recorded, not asserted,
      // there.)
      const [, , review, done] = fixture.statuses;
      const windowed = await page.evaluate(() => document.querySelector("table").hasAttribute("aria-rowcount"));
      const result = {};
      const reviewTasks = async () =>
        prisma.task.findMany({
          where: { projectId: fixture.project.id, statusId: review.id },
          orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          select: { id: true, title: true },
        });
      const into = async (task, below) => {
        await page.evaluate(() => {
          document.querySelector("main").scrollTop = 0;
          document.querySelector("table").parentElement.scrollLeft = 0;
        });
        await frames(page, 3);
        const found = await page.evaluate((title) => {
          const row = [...document.querySelector("table").tBodies[0].rows].find((r) => r.cells[1]?.textContent === title);
          row?.scrollIntoView({ block: "start" });
          return !!row;
        }, task.title);
        if (!found) await scrollToRow(page, (await expectedIndex(task.id)) + 2);
        await frames(page, 4);
        // Put the first row in view `below` px into the view (negative: partly
        // scrolled out).
        await page.evaluate((below) => {
          const main = document.querySelector("main");
          const view = main.getBoundingClientRect();
          const first = [...document.querySelector("table").tBodies[0].rows].find(
            (r) => r.cells.length > 1 && r.getBoundingClientRect().bottom > view.top + 1,
          );
          main.scrollTop += first.getBoundingClientRect().top - view.top - below;
        }, below);
        await frames(page, 6);
      };
      const checkedTitles = () =>
        page.evaluate(() =>
          [...document.querySelector("table").tBodies[0].rows]
            .filter((r) => r.cells[0]?.querySelector("input")?.checked)
            .map((r) => r.cells[1].textContent),
        );
      const settleOn = async (title, label) => {
        const task = await taskByTitle(title);
        const index = await expectedIndex(task.id);
        await waitFor(async () => (await rowAt(title))?.index === index, label);
        await frames(page, 6);
      };
      const pointAt = async (title) => {
        const box = await page.evaluate((title) => {
          const row = [...document.querySelector("table").tBodies[0].rows].find((r) => r.cells[1]?.textContent === title);
          const b = row.cells[0].querySelector("input").getBoundingClientRect();
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        }, title);
        await page.mouse.move(box.x, box.y);
      };
      const clickAtPointer = async () => {
        await page.mouse.down();
        await page.mouse.up();
        await frames(page, 3);
        const checked = await checkedTitles();
        await page.getByTitle("Clear selection").click().catch(() => {});
        await frames(page, 3);
        return checked;
      };
      const shiftOf = async (row) => {
        const now = await rowAt(row.title);
        return now ? Math.round((now.top - row.top) * 100) / 100 : null;
      };

      const movedToDone = async (taskIds) =>
        prisma.task.count({ where: { id: { in: taskIds }, statusId: done.id } });
      // A colleague's bulk change.
      const colleagueBulk = async (label) => {
        const view = await rowsInView();
        const count = Math.min(14, view.length - 4);
        const stay = view[count + 2];
        const firstStaying = view[count];
        await pointAt(stay.title);
        const ids = [];
        for (const row of view.slice(0, count)) ids.push((await taskByTitle(row.title)).id);
        await api("POST", `/projects/${fixture.project.id}/tasks/bulk-update`, { taskIds: ids, statusId: done.id });
        assert.equal(await movedToDone(ids), ids.length, `the bulk change moved every selected task (${label})`);
        await settleOn(stay.title, `bulk change (${label})`);
        return {
          moved: count,
          rowsInView: view.length,
          firstStaying: await shiftOf(firstStaying),
          stay: await shiftOf(stay),
          clickTarget: stay.title,
          checked: await clickAtPointer(),
        };
      };
      let tasks = await reviewTasks();
      await into(tasks[Math.floor(tasks.length / 3)], -17);
      result.colleague = await colleagueBulk("colleague");

      // The same right after a short scroll down, in one step.
      tasks = await reviewTasks();
      await into(tasks[Math.floor((tasks.length * 3) / 5)], -17);
      const scrolledBy = await page.evaluate(() => {
        const main = document.querySelector("main");
        const by = Math.floor(main.clientHeight * 0.47);
        main.scrollTop += by;
        return by;
      });
      await frames(page, 6);
      result.afterShortScroll = { scrolledBy, ...(await colleagueBulk("colleague after a short scroll")) };

      // The user's own bulk change, the first row moved 1 px below the top
      // of the view: a sliver of the row above it, which stays, is in view.
      tasks = await reviewTasks();
      await into(tasks[Math.floor(tasks.length / 2)], 1);
      const view = (await rowsInView()).filter((row) => row.top >= 0);
      const sliver = await page.evaluate((title) => {
        const rows = [...document.querySelector("table").tBodies[0].rows];
        const above = rows[rows.findIndex((r) => r.cells[1]?.textContent === title) - 1];
        return above.getBoundingClientRect().bottom - document.querySelector("main").getBoundingClientRect().top;
      }, view[0].title);
      const count = Math.min(14, view.length - 4);
      const moving = view.slice(0, count);
      let stay = view[count + 2];
      let firstStaying = view[count];
      const ownIds = [];
      for (const row of moving) ownIds.push((await taskByTitle(row.title)).id);
      for (const row of moving) {
        await pointAt(row.title);
        await page.mouse.down();
        await page.mouse.up();
        await frames(page, 2);
      }
      assert(sliver > 0 && sliver < 20, `a sliver of the row above the block is in view (${sliver} px)`);
      assert.equal((await checkedTitles()).length, count, "rows selected for the bulk change");
      // Positions right before the change (selecting the rows re-renders them).
      const before = new Map((await rowsInView()).map((row) => [row.title, row.top]));
      stay = { title: stay.title, top: before.get(stay.title) };
      firstStaying = { title: firstStaying.title, top: before.get(firstStaying.title) };
      const bulk = page.waitForResponse((r) => r.url().includes("/tasks/bulk-update"));
      await page.locator("select").filter({ hasText: "Change status" }).selectOption(done.id);
      assert.equal((await bulk).status(), 200);
      assert.equal(await movedToDone(ownIds), ownIds.length, "the own bulk change moved every selected task");
      await settleOn(stay.title, "own bulk change");
      result.own = {
        moved: count,
        rowsInView: view.length,
        sliverAbove: Math.round(sliver * 100) / 100,
        firstStaying: await shiftOf(firstStaying),
        stay: await shiftOf(stay),
      };
      await pointAt(stay.title);
      result.own.clickTarget = stay.title;
      result.own.checked = await clickAtPointer();

      log("bulk", JSON.stringify(result));
      assert(Math.abs(result.colleague.stay) <= 1, "rows that stayed keep their place (colleague)");
      assert(Math.abs(result.colleague.firstStaying) <= 1, "first row that stayed keeps its place (colleague)");
      assert.deepEqual(result.colleague.checked, [result.colleague.clickTarget], "click after a colleague's bulk change");
      assert(Math.abs(result.afterShortScroll.stay) <= 1, "rows that stayed keep their place (after a short scroll)");
      assert(Math.abs(result.afterShortScroll.firstStaying) <= 1, "first row that stayed keeps its place (after a short scroll)");
      assert.deepEqual(
        result.afterShortScroll.checked,
        [result.afterShortScroll.clickTarget],
        "click after a colleague's bulk change after a short scroll",
      );
      if (windowed) {
        assert(Math.abs(result.own.stay) <= 1, "rows that stayed keep their place (own bulk change)");
        assert(Math.abs(result.own.firstStaying) <= 1, "first row that stayed keeps its place (own bulk change)");
      }
      assert.deepEqual(result.own.checked, [result.own.clickTarget], "click after the user's own bulk change");
      pass("bulk move of the top block of rows in view", result);
    }
    if (want("board")) {
      // 11. The List has no drag-and-drop; the Board of the same project (not
      // windowed, unchanged here) still reorders by drag at this size.
      const opened = Date.now();
      await page.locator(`a[href$="/projects/${fixture.project.id}/board"]`).first().click();
      const cardOf = (title) =>
        page.locator('[aria-roledescription="sortable"]').filter({ hasText: title }).first();
      const [first, second, third] = fixture.tasks.slice(0, 3);
      await cardOf(first.title).waitFor({ timeout: 120_000 });
      const boardMs = Date.now() - opened;
      // <main> keeps the List's scroll position; bring the cards into view.
      await cardOf(first.title).scrollIntoViewIfNeeded();
      await frames(page, 3);
      const from = await cardOf(first.title).boundingBox();
      const to = await cardOf(third.title).boundingBox();
      const move = page.waitForResponse(
        (r) => r.url().endsWith(`/tasks/${first.id}/move`) && r.request().method() === "PATCH",
        { timeout: 120_000 },
      );
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 12, { steps: 3 });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 + 4, { steps: 12 });
      await page.waitForTimeout(500);
      await page.mouse.up();
      assert.equal((await move).status(), 200);
      const column = await prisma.task.findMany({
        where: { projectId: fixture.project.id, statusId: fixture.statuses[0].id, archived: false },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true, position: true },
      });
      assert.deepEqual(column.slice(0, 3).map((t) => t.id), [second.id, third.id, first.id]);
      assert.deepEqual(column.map((t) => t.position), column.map((_, i) => i), "positions renumbered 0..n-1");
      pass("board drag reorder on the same project", { boardRenderMs: boardMs, column: column.length });
    }
  } finally {
    await context.close();
  }
  return checks;
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
  fixture.otherToken = signAccessToken({
    sub: fixture.other.id,
    email: fixture.other.email,
  });
  // The second user's requests go to the app directly, from another client
  // address, so they do not use up the browser's API rate limit (100 a
  // minute per address) while the List refetches after each of them.
  fixture.asColleague = async (method, url, body) => {
    const response = await app.inject({
      method,
      url: `/api${url}`,
      remoteAddress: "127.0.0.2",
      headers: {
        authorization: `Bearer ${fixture.otherToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      payload: body ? JSON.stringify(body) : undefined,
    });
    assert(
      response.statusCode >= 200 && response.statusCode < 300,
      `${method} ${url}: ${response.statusCode} ${response.body}`,
    );
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
  };
  log(`fixture: ${fixture.tasks.length} tasks in ${Date.now() - started} ms`);

  distDir = process.env.TASK_LIST_DIST
    ? path.resolve(process.env.TASK_LIST_DIST)
    : path.join(scratch, "dist");
  if (!process.env.TASK_LIST_DIST) {
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
        "/api": { target: app.listeningOrigin, changeOrigin: true, ws: true },
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
    for (let run = 1; run <= RUNS; run++)
      report.runs.push(await measureRun(browser, origin, fixture, run));
    report.summary = summarize(report.runs);
    log("summary", JSON.stringify(report.summary));
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
  if (process.env.TASK_LIST_REPORT)
    await writeFile(process.env.TASK_LIST_REPORT, JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
  try {
    // Task status references are RESTRICT, so tasks go before the workspace.
    if (created.projectId)
      await app.prisma.task.deleteMany({ where: { projectId: created.projectId } });
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
