// Chromium regression for the board column scrollport
// (docs/remediation/board-windowing.md). A stubbed offsetHeight does not
// count: this opens the production build. Run from packages/backend against
// a migrated loopback database whose name is werkyn_audit_boardfix2_r15:
//
//   TEST_DATABASE_URL=... PLAYWRIGHT_MODULE=... CHROMIUM_EXECUTABLE=... \
//     node --import tsx tests/browser/board-column-scroll.mjs
//
// BOARD_SCROLL_DIST  an already built frontend dist. Otherwise one is built.
// The fixture removes its own user and workspace. Only loopback is allowed.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OPEN_N = 2000;
const database = new URL(process.env.TEST_DATABASE_URL ?? "invalid:");
assert.equal(database.hostname, "127.0.0.1");
assert.equal(database.pathname, "/werkyn_audit_boardfix2_r15");
Object.assign(process.env, {
  DATABASE_URL: database.toString(),
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "board-column-scroll-fixture-jwt-secret",
  COOKIE_SECRET: "board-column-scroll-fixture-cookie-secret",
  COOKIE_SECURE: "false",
  COOKIE_SAMESITE: "lax",
});

const backend = path.resolve(import.meta.dirname, "../..");
const frontend = path.resolve(backend, "../frontend");
const root = path.resolve(backend, "../..");
const scratchRoot = path.join(root, ".tmp");
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(path.join(scratchRoot, "board-scroll-"));
process.env.STORAGE_DIR = path.join(scratch, "storage");

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const { build, preview } = await import(
  pathToFileURL(path.join(frontend, "node_modules/vite/dist/node/index.js")).href
);
const { buildApp } = await import(pathToFileURL(path.join(backend, "src/app.ts")).href);
const { hashPassword } = await import(pathToFileURL(path.join(backend, "src/utils/passwords.ts")).href);

const report = { mounted: null, bodyRequests: null, drop: null, anchor: null, errors: [] };
const log = (...parts) => console.error("[board-scroll]", ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function titleOf(index) {
  return `Card ${String(index).padStart(4, "0")}`;
}

let app;
let vite;
let browser;
const created = { userIds: [], workspaceId: null };

async function createFixture(prisma) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const password = "Board-scroll-fixture-password";
  const passwordHash = await hashPassword(password);
  const owner = await prisma.user.create({
    data: {
      email: `board-scroll-${suffix}@fixture.invalid`,
      passwordHash,
      displayName: "Board Scroll",
      emailVerified: false,
    },
  });
  created.userIds.push(owner.id);
  const workspace = await prisma.workspace.create({
    data: {
      name: "Board scroll",
      slug: `board-scroll-${suffix}`,
      members: { create: [{ userId: owner.id, role: "ADMIN" }] },
    },
  });
  created.workspaceId = workspace.id;
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Scroll column",
      members: { create: [{ userId: owner.id }] },
    },
  });
  const open = await prisma.statusColumn.create({
    data: { projectId: project.id, name: "Open", position: 0 },
  });
  const done = await prisma.statusColumn.create({
    data: { projectId: project.id, name: "Done", position: 1, isCompletion: true },
  });
  const originMs = Date.UTC(2026, 0, 1);
  const rows = [];
  for (let index = 0; index < OPEN_N; index++) {
    rows.push({
      projectId: project.id,
      statusId: open.id,
      title: titleOf(index),
      position: index,
      createdAt: new Date(originMs + index * 1000),
    });
  }
  for (let index = 0; index < 3; index++) {
    rows.push({
      projectId: project.id,
      statusId: done.id,
      title: `Done ${index}`,
      position: index,
      createdAt: new Date(originMs + index * 1000),
    });
  }
  rows.push({
    projectId: project.id,
    statusId: open.id,
    title: "archived task",
    position: 0,
    archived: true,
    createdAt: new Date(originMs - 1000),
  });
  for (let offset = 0; offset < rows.length; offset += 500) {
    await prisma.task.createMany({ data: rows.slice(offset, offset + 500) });
  }
  return { owner, password, workspace, project, open, done };
}

async function columnOrder(statusId) {
  return app.prisma.task.findMany({
    where: { statusId, archived: false },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, title: true },
  });
}

function frames(page, count = 3) {
  return page.evaluate((n) => new Promise((resolve) => {
    const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
    step(n);
  }), count);
}

async function waitFor(check, label, timeout = 20000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      const value = await check();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error?.message ?? String(error);
    }
    await sleep(100);
  }
  throw new Error(`timed out: ${label} (${JSON.stringify(last)?.slice(0, 500)})`);
}

async function columnState(page, statusId) {
  return page.evaluate((statusId) => {
    const scroller = document.querySelector(`[data-scroller="${statusId}"]`);
    const countEl = document.querySelector(`[data-column-count="${statusId}"]`);
    const main = document.querySelector("main");
    if (!scroller || !main) return null;
    const view = scroller.getBoundingClientRect();
    const cards = [...scroller.querySelectorAll("[data-column-index]")].map((wrap) => {
      const rect = wrap.getBoundingClientRect();
      return {
        id: wrap.querySelector("[data-task-id]")?.dataset.taskId ?? null,
        title: wrap.querySelector("p")?.textContent ?? "",
        index: Number(wrap.dataset.index),
        columnIndex: Number(wrap.dataset.columnIndex),
        top: Math.round((rect.top - view.top) * 10) / 10,
      };
    });
    return {
      countText: countEl?.textContent?.trim() ?? null,
      mounted: scroller.querySelectorAll("[data-task-id]").length,
      cards,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      mainScrollTop: main.scrollTop,
      mainScrollHeight: main.scrollHeight,
      mainClientHeight: main.clientHeight,
    };
  }, statusId);
}

function bodyPages(reads) {
  return reads.filter((read) => read.columnIds !== "true" && read.perColumn != null);
}

async function setScrollTop(page, statusId, top) {
  await page.evaluate(({ statusId, top }) => {
    const scroller = document.querySelector(`[data-scroller="${statusId}"]`);
    scroller.scrollTop = top;
  }, { statusId, top });
  await frames(page, 3);
}

async function main() {
  const dist = process.env.BOARD_SCROLL_DIST;
  if (!dist) {
    log("building frontend");
    await build({ root: frontend, logLevel: "error" });
  }
  app = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const identity = await app.prisma.$queryRaw`SELECT current_database() AS name`;
  assert.equal(identity[0].name, "werkyn_audit_boardfix2_r15");
  const fixture = await createFixture(app.prisma);
  vite = await preview({
    root: frontend,
    configFile: false,
    logLevel: "error",
    build: { outDir: dist ?? path.join(frontend, "dist") },
    preview: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      proxy: {
        "/api": {
          target: app.listeningOrigin,
          changeOrigin: true,
          ws: true,
          timeout: 0,
          proxyTimeout: 0,
        },
      },
    },
  });
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const taskReads = [];
  const moveBodies = [];
  let authorization = "";
  const sockets = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  page.on("pageerror", (error) => report.errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") report.errors.push(`console: ${message.text().slice(0, 300)}`);
  });
  page.on("request", (request) => {
    const header = request.headers().authorization;
    if (header) authorization = header;
    if (request.method() === "PATCH" && request.url().includes("/move")) {
      moveBodies.push(request.postData());
    }
  });
  page.on("response", async (response) => {
    const url = response.url();
    if (!url.includes("/tasks") || response.request().method() !== "GET") return;
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.get("view") !== "board") return;
      taskReads.push({
        status: response.status(),
        perColumn: parsed.searchParams.get("perColumn"),
        columnOffset: parsed.searchParams.get("columnOffset"),
        columnIds: parsed.searchParams.get("columnIds"),
        statusId: parsed.searchParams.get("status"),
      });
    } catch {
      // A body that is not the board list is not a page of cards.
    }
  });

  await page.goto(`${origin}/login`);
  await page.getByLabel("Email").fill(fixture.owner.email);
  await page.getByLabel("Password").fill(fixture.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto(`${origin}/${fixture.workspace.slug}/projects/${fixture.project.id}/board`);

  const openId = fixture.open.id;
  const painted = await waitFor(async () => {
    const state = await columnState(page, openId);
    return state && state.countText === String(OPEN_N) && state.mounted > 0 ? state : null;
  }, "board paint");
  // The broken scroller asks for every later page within a couple of seconds.
  await sleep(3000);
  const settled = await columnState(page, openId);
  const firstBodies = bodyPages(taskReads);
  const laterBodies = firstBodies.filter((read) => Number(read.columnOffset ?? "0") > 0);
  report.mounted = settled.mounted;
  report.bodyRequests = firstBodies.length;
  report.first = {
    clientHeight: settled.clientHeight,
    scrollHeight: settled.scrollHeight,
    scrollTop: settled.scrollTop,
    mainClientHeight: settled.mainClientHeight,
    mainScrollHeight: settled.mainScrollHeight,
    mainScrollTop: settled.mainScrollTop,
    mounted: settled.mounted,
    bodyRequests: firstBodies.length,
    laterBodyRequests: laterBodies.length,
    statuses: firstBodies.map((read) => read.status),
  };
  log("first", JSON.stringify(report.first));
  assert.ok(settled.clientHeight > 200, `column viewport collapsed (${settled.clientHeight})`);
  assert.ok(
    settled.clientHeight < settled.scrollHeight,
    `column scroller is as tall as its cards (${settled.clientHeight} / ${settled.scrollHeight})`,
  );
  assert.ok(settled.mounted < 80, `mounted ${settled.mounted} cards in a 2,000-card column`);
  assert.equal(laterBodies.length, 0, `first paint requested ${laterBodies.length} later body pages`);
  assert.ok(firstBodies.length <= 2, `first paint made ${firstBodies.length} body requests`);
  assert.ok(
    settled.mainScrollHeight - settled.mainClientHeight < 80,
    `page scroller grew (${settled.mainScrollHeight} / ${settled.mainClientHeight})`,
  );
  const fit = await page.evaluate((statusId) => {
    const viewH = window.innerHeight;
    const box = (el) => (el ? el.getBoundingClientRect() : null);
    const banner = [...document.querySelectorAll("span")].find((el) =>
      (el.textContent ?? "").includes("Please verify your email address"),
    );
    const button = [...document.querySelectorAll("button")].find((el) => el.textContent?.includes("New Task"));
    const scroller = document.querySelector(`[data-scroller="${statusId}"]`);
    return {
      viewH,
      bannerTop: box(banner)?.top ?? null,
      bannerBottom: box(banner)?.bottom ?? null,
      buttonTop: box(button)?.top ?? null,
      buttonBottom: box(button)?.bottom ?? null,
      scrollerTop: box(scroller)?.top ?? null,
      scrollerBottom: box(scroller)?.bottom ?? null,
    };
  }, openId);
  report.fit = fit;
  log("fit", JSON.stringify(fit));
  assert.ok(fit.bannerBottom > 0, "email banner is not on screen");
  assert.ok(fit.buttonTop >= 0 && fit.buttonBottom <= fit.viewH + 1, `New Task is off screen (${fit.buttonTop}..${fit.buttonBottom})`);
  assert.ok(
    fit.scrollerTop >= 0 && fit.scrollerBottom <= fit.viewH + 1,
    `column extends past the page (${fit.scrollerTop}..${fit.scrollerBottom} of ${fit.viewH})`,
  );
  const firstIds = new Set(painted.cards.map((card) => card.id));
  const firstMax = Math.max(...painted.cards.map((card) => card.columnIndex));

  await setScrollTop(page, openId, 320);
  const nudged = await columnState(page, openId);
  assert.ok(nudged.scrollTop >= 200, `column scrollTop stayed ${nudged.scrollTop}`);
  assert.ok(Math.abs(nudged.mainScrollTop) < 5, `page scrolled instead (${nudged.mainScrollTop})`);

  const farTop = await page.evaluate((statusId) => {
    const scroller = document.querySelector(`[data-scroller="${statusId}"]`);
    return Math.floor((scroller.scrollHeight - scroller.clientHeight) * 0.7);
  }, openId);
  await setScrollTop(page, openId, farTop);
  const far = await waitFor(async () => {
    const state = await columnState(page, openId);
    const visible = state?.cards.filter((card) => card.id && card.top >= 0 && card.top < state.clientHeight - 24) ?? [];
    const high = visible.filter((card) => card.columnIndex > firstMax);
    return high.length >= 4 ? { state, visible } : null;
  }, "scrolled column mounts a later index");
  assert.ok(far.state.mounted < 80, `scrolling mounted ${far.state.mounted} cards`);
  assert.ok(!far.visible.some((card) => card.columnIndex === 0), "index 0 stayed mounted after the column scrolled");
  const farBodies = bodyPages(taskReads).filter((read) => Number(read.columnOffset ?? "0") > 0);
  assert.ok(farBodies.length > 0 && farBodies.length <= 6, `body pages after one scroll: ${farBodies.length}`);
  const source = far.visible[1];
  const target = far.visible[4];
  assert.ok(source.columnIndex > firstMax && !firstIds.has(source.id), "drag started inside the first window");

  const from = await page.locator(`[data-task-id="${source.id}"]`).boundingBox();
  const to = await page.locator(`[data-task-id="${target.id}"]`).boundingBox();
  assert.ok(from && to, "drag cards have no box");
  await page.route(/\/tasks\/[^/]+\/move$/, async (route) => {
    moveBodies.push(route.request().postData());
    await route.continue();
  });
  const moveResponse = page.waitForResponse(
    (response) => response.url().includes(`/tasks/${source.id}/move`) && response.request().method() === "PATCH",
  );
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 16, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 + 6, { steps: 12 });
  await page.waitForTimeout(400);
  await page.mouse.up();
  const moved = await moveResponse;
  const movedText = await moved.text();
  assert.equal(moved.status(), 200, movedText);
  const raw = moveBodies.find((body) => body) ?? null;
  const sent = raw
    ? JSON.parse(raw)
    : { statusId: openId, position: JSON.parse(movedText).data.position };
  const order = await columnOrder(openId);
  const landed = order.findIndex((task) => task.id === source.id);
  report.drop = {
    from: source.columnIndex,
    over: target.columnIndex,
    position: sent.position,
    body: raw,
    landed,
    firstWindowMax: firstMax,
  };
  log("drop", JSON.stringify(report.drop));
  assert.equal(sent.statusId, openId);
  assert.ok(sent.position > firstMax, `move position ${sent.position} is inside the first window`);
  assert.equal(landed, sent.position, "server stored a different index from the one the drop sent");

  await sleep(600);
  const sample = await page.evaluate((statusId) => {
    const card = document.querySelector(`[data-scroller="${statusId}"] [data-index]`);
    return card ? card.getBoundingClientRect().height : 92;
  }, openId);
  await setScrollTop(page, openId, Math.ceil(sample * 2));
  const before = await waitFor(async () => {
    const state = await columnState(page, openId);
    if (!state || state.scrollTop < 40) return null;
    const card = state.cards.find((item) => item.id && item.top >= 30 && item.top < state.clientHeight - 80);
    return card ? { state, card } : null;
  }, "anchor card");
  const anchorId = before.card.id;
  const anchorTop = before.card.top;
  const anchorScroll = before.state.scrollTop;
  const anchorMain = before.state.mainScrollTop;

  const originMs = Date.UTC(2026, 0, 1);
  await app.prisma.task.createMany({
    data: [1, 2, 3].map((index) => ({
      projectId: fixture.project.id,
      statusId: openId,
      title: `Above ${index}`,
      position: 0,
      createdAt: new Date(originMs - index * 1000),
    })),
  });
  assert.ok(authorization.startsWith("Bearer "), "board session did not send a token");
  const bumped = await app.inject({
    method: "PATCH",
    url: `/api/tasks/${(await columnOrder(fixture.done.id))[0].id}`,
    remoteAddress: "127.0.0.51",
    headers: { authorization, "content-type": "application/json" },
    payload: JSON.stringify({ title: "Done 0." }),
  });
  assert.equal(bumped.statusCode, 200, bumped.body.slice(0, 300));
  let anchorSeen = null;
  const after = await waitFor(async () => {
    const state = await columnState(page, openId);
    const card = state?.cards.find((item) => item.id === anchorId) ?? null;
    anchorSeen = {
      count: state?.countText ?? null,
      scroll: state?.scrollTop ?? null,
      main: state?.mainScrollTop ?? null,
      mounted: state?.mounted ?? null,
      top: card?.top ?? null,
      present: Boolean(card),
    };
    if (!state || state.countText !== String(OPEN_N + 3) || !card) return null;
    if (Math.abs(card.top - anchorTop) > 8) return null;
    return { state, card };
  }, "same card stays on screen", 25000).catch((error) => {
    throw new Error(`${error.message} seen=${JSON.stringify(anchorSeen)} before=${JSON.stringify({ anchorTop, anchorScroll, anchorMain })} sockets=${sockets.join(",")}`);
  });
  report.anchor = {
    id: anchorId,
    topBefore: anchorTop,
    topAfter: after.card.top,
    scrollBefore: anchorScroll,
    scrollAfter: after.state.scrollTop,
    mainBefore: anchorMain,
    mainAfter: after.state.mainScrollTop,
  };
  log("anchor", JSON.stringify(report.anchor));
  assert.ok(after.state.scrollTop > anchorScroll + 40, "column did not scroll to keep the card");
  assert.ok(Math.abs(after.state.mainScrollTop - anchorMain) < 5, "page scroller anchored the card");
  assert.ok(after.state.mounted < 80, `insert mounted ${after.state.mounted} cards`);
  const finalBodies = bodyPages(taskReads);
  assert.ok(finalBodies.length < 20, `body requests grew to ${finalBodies.length}`);
  assert.ok(!finalBodies.some((read) => read.status === 429), "a board read returned 429");
  log("ok", JSON.stringify({
    mounted: report.mounted,
    bodyRequests: report.bodyRequests,
    drop: report.drop,
    anchor: report.anchor,
  }));
}

try {
  await main();
} finally {
  let cleanupError;
  try {
    if (app && created.workspaceId) {
      await app.prisma.workspace.delete({ where: { id: created.workspaceId } });
    }
    if (app) {
      for (const userId of created.userIds) {
        await app.prisma.user.delete({ where: { id: userId } });
      }
    }
  } catch (error) {
    cleanupError = error;
  }
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
  if (app) await app.close();
  await rm(scratch, { recursive: true, force: true });
  if (cleanupError) throw cleanupError;
}
