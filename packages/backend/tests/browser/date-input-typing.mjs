// Typing a date over a saved one, in real Chromium, with three orders of the
// date parts (month/day/year, day/month/year, year/month/day). While a part is
// half typed the input reports "" (with bad input), and on the way to the new
// date it reports dates mixing typed and old parts. None of that may reach the
// server: the typed date is saved once on Enter or blur, a half-typed edit
// keeps the saved date, and only Clear or an emptied input saves null.
//
// Run from packages/backend after `pnpm build`, with TEST_DATABASE_URL naming a
// migrated disposable loopback database whose name starts with werkyn_audit_,
// and PLAYWRIGHT_MODULE naming the installed package or module path:
//
//   node --import tsx tests/browser/date-input-typing.mjs
//
// DATE_INPUT_DIST may name another frontend build (default: packages/frontend/
// dist); DATE_INPUT_REPORT a JSON file for the results. The List's inline date
// cells are reported, but only their "never null" check can fail: they still
// save the first complete date they see.
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
  JWT_SECRET: "date-input-browser-fixture-jwt-secret",
  COOKIE_SECRET: "date-input-browser-fixture-cookie-secret",
  COOKIE_SECURE: "false",
  COOKIE_SAMESITE: "lax",
});
const storage = await mkdtemp(path.join(os.tmpdir(), "werkyn-date-input-"));
process.env.STORAGE_DIR = storage;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const frontend = path.resolve(import.meta.dirname, "../../../frontend");
const dist = path.resolve(process.env.DATE_INPUT_DIST ?? path.join(frontend, "dist"));
const { preview } = await import(
  pathToFileURL(path.join(frontend, "node_modules/vite/dist/node/index.js"))
);
const { buildApp } = await import("../../src/app.ts");

const OLD_DUE = "2026-11-20";
const OLD_START = "2026-11-02";
const OLD_TARGET = "2026-11-25";
const NEW = "2027-03-15";
const PICKED = "2027-05-06";
const LOCALES = ["en-US", "de-DE", "ja-JP"];
const password = "Date-input-browser-password";
const report = { dist, locales: {}, failures: [] };

const app = await buildApp();
let vite;
let browser;
const created = {};
try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const identity = await app.prisma.$queryRaw`SELECT current_database()`;
  assert.equal(identity[0].current_database, database.pathname.slice(1));
  const prisma = app.prisma;

  // ─── Fixture ──────────────────────────────────────────────
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      email: `date-input-${suffix}@example.test`,
      passwordHash: await bcrypt.hash(password, 10),
      displayName: "Date input fixture",
      emailVerified: true,
    },
  });
  created.userId = user.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: "Date input fixture",
      slug: `di-${suffix}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  created.workspaceId = workspace.id;
  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: "Dates", members: { create: { userId: user.id } } },
  });
  const status = await prisma.statusColumn.create({
    data: { projectId: project.id, name: "To do", color: "#64748b", position: 0 },
  });
  const target = await prisma.customField.create({
    data: { projectId: project.id, name: "Target", type: "DATE", position: 0 },
  });
  const SCENARIOS = [
    "panel-due", "panel-target", "panel-start", "panel-partial", "panel-partial-year", "panel-escape",
    "panel-clear", "panel-clear-click", "panel-clear-tab", "panel-emptied", "panel-picked",
    "list-due", "list-target", "list-picked", "list-backspace", "bulk-1", "bulk-2",
    "bulk-clear-1", "bulk-clear-2",
  ];
  const tasks = {};
  let position = 0;
  for (const locale of LOCALES) {
    tasks[locale] = {};
    for (const name of SCENARIOS) {
      const task = await prisma.task.create({
        data: {
          projectId: project.id,
          statusId: status.id,
          title: `${locale} ${name}`,
          position: position++,
          dueDate: OLD_DUE,
          startDate: OLD_START,
          customFieldValues: { create: { fieldId: target.id, value: OLD_TARGET } },
        },
      });
      tasks[locale][name] = task.id;
    }
  }
  const saved = async (taskId) => {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { dueDate: true, startDate: true, customFieldValues: { select: { value: true } } },
    });
    return { dueDate: task.dueDate, startDate: task.startDate, target: task.customFieldValues[0]?.value ?? null };
  };

  // ─── Servers and browser helpers ──────────────────────────
  // The API allows 100 requests a minute per address, and every request here
  // comes through the preview proxy. Each proxied connection gets its own
  // loopback source address, so the limit does not cut a run short.
  class SpreadAgent extends http.Agent {
    next = 0;
    createConnection(options, callback) {
      const localAddress = `127.0.1.${(this.next++ % 250) + 1}`;
      return super.createConnection({ ...options, localAddress }, callback);
    }
  }
  vite = await preview({
    root: frontend,
    configFile: false,
    logLevel: "error",
    build: { outDir: dist },
    preview: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      proxy: {
        "/api": { target: app.listeningOrigin, changeOrigin: true, ws: true, agent: new SpreadAgent() },
      },
    },
  });
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const listUrl = `${origin}/${workspace.slug}/projects/${project.id}/list`;

  /** The order of the date parts in this browser's date inputs. */
  async function partOrder(context) {
    const page = await context.newPage();
    await page.setContent(`<input type="date" value="${OLD_DUE}">`);
    await page.focus("input");
    const order = [];
    for (let i = 0; i < 3; i++) {
      const before = (await page.inputValue("input")).split("-");
      await page.keyboard.press("ArrowUp");
      const after = (await page.inputValue("input")).split("-");
      order.push(["year", "month", "day"][after.findIndex((part, j) => part !== before[j])]);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowRight");
    }
    await page.close();
    return order;
  }

  for (const locale of LOCALES) {
    // On Linux, Chromium takes the date input's part order from the
    // environment's language; --lang alone is not enough there.
    const posix = `${locale.replace("-", "_")}.UTF-8`;
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", `--lang=${locale}`],
      env: { ...process.env, LANG: posix, LANGUAGE: locale.replace("-", "_"), LC_ALL: posix },
    });
    const context = await browser.newContext({ locale, viewport: { width: 1600, height: 1000 } });
    await context.route((url) => url.origin !== origin, (route) => route.abort());
    const order = await partOrder(context);
    const [year, month, day] = NEW.split("-");
    // A month or day moves on to the next part after two digits; a year takes
    // up to six, so a year that is not last is followed by ArrowRight.
    const digits = { year, month, day };
    const typing = order.flatMap((part, i) => [
      ...digits[part],
      ...(part === "year" && i < 2 ? ["ArrowRight"] : []),
    ]);
    // A partial year: the parts before it, then two digits of the year.
    const partialYear = [...order.slice(0, order.indexOf("year")).flatMap((part) => [...digits[part]]), "2", "0"];
    const result = { browser: browser.version(), order, typing, scenarios: {} };
    report.locales[locale] = result;
    console.error(locale, order.join("/"), typing.join(" "));

    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Every write the page sends, and how many requests are still open.
    const writes = [];
    let open = 0;
    page.on("request", (request) => {
      open++;
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/") || request.method() === "GET") return;
      let body = null;
      try {
        body = request.postDataJSON();
      } catch {
        body = request.postData();
      }
      writes.push({ method: request.method(), path: url.pathname, body });
    });
    const done = () => open--;
    page.on("requestfinished", done);
    page.on("requestfailed", done);
    async function settle() {
      let quiet = 0;
      for (let waited = 0; waited < 15000 && quiet < 6; waited += 100) {
        await page.waitForTimeout(100);
        quiet = open === 0 ? quiet + 1 : 0;
      }
      await page.waitForTimeout(300);
    }

    await page.goto(`${origin}/login`);
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));
    // The app is loaded once; panels and the List are reached by clicking, so
    // no reload interrupts a session refresh.
    await page.goto(listUrl);
    await page.getByRole("button", { name: `${locale} bulk-2`, exact: true }).waitFor();

    const ids = tasks[locale];
    const title = (name) => `${locale} ${name}`;
    const row = (name) => page.locator("tr", { has: page.getByRole("button", { name: title(name), exact: true }) });

    async function scenario(name, run) {
      const from = writes.length;
      const record = { writes: [], checks: {}, notes: {} };
      result.scenarios[name] = record;
      const check = (label, ok, detail) => {
        record.checks[label] = ok ? true : { ok: false, detail };
        if (!ok) report.failures.push(`${locale} ${name}: ${label} ${JSON.stringify(detail)}`);
      };
      try {
        await run({ check, note: (label, value) => (record.notes[label] = value) });
      } catch (error) {
        check("ran", false, String(error?.stack ?? error).slice(0, 800));
        if (process.env.DATE_INPUT_SHOTS) {
          await page
            .screenshot({ path: path.join(process.env.DATE_INPUT_SHOTS, `${locale}-${name}.png`) })
            .catch(() => {});
        }
      }
      // Writes to this locale's tasks (other writes, such as a token refresh,
      // are not about dates).
      record.writes = writes
        .slice(from)
        .filter((w) => w.path.endsWith("/bulk-update") || Object.values(ids).some((id) => w.path.includes(id)));
      const nulls = record.writes.filter((w) => JSON.stringify(w.body).includes("null"));
      if (!/clear|emptied|backspace/.test(name)) {
        check("server never received null", nulls.length === 0, nulls);
      }
      console.error(locale, name, JSON.stringify(record.checks), JSON.stringify(record.notes));
    }
    const writesFor = (from, id) => writes.slice(from).filter((w) => w.path.includes(id));
    async function type(keys) {
      for (const key of keys) await page.keyboard.press(key, { delay: 20 });
    }
    // Tab until focus is past the input and its clear button, so the typed
    // date is saved by that blur. (The first Tab after the last part may stop
    // on the browser's calendar button inside the input; panel-clear-tab
    // checks the stop on the clear button, which keeps the edit pending.)
    async function tabOut(input) {
      const inside = () => input.evaluate((el) => el.parentElement.contains(document.activeElement));
      for (let i = 0; i < 5 && (await inside()); i++) await page.keyboard.press("Tab");
    }

    async function closePanel() {
      const panel = page.getByRole("dialog");
      if (await panel.isVisible()) {
        await panel.getByRole("button", { name: "Close", exact: true }).click();
        await panel.waitFor({ state: "detached" });
      }
    }
    async function openPanel(name) {
      await closePanel();
      await settle();
      await page.getByRole("button", { name: title(name), exact: true }).click();
      const panel = page.getByRole("dialog");
      await panel.getByLabel("Due date", { exact: true }).waitFor();
      await settle();
      return panel;
    }
    async function openList() {
      await closePanel();
      await settle();
      await row("bulk-2").waitFor();
    }

    // Task panel: type a date, then Tab out.
    for (const [name, label, field] of [
      ["panel-due", "Due date", "dueDate"],
      ["panel-target", "Target", "target"],
    ]) {
      await scenario(name, async ({ check }) => {
        const panel = await openPanel(name);
        const from = writes.length;
        const input = panel.getByLabel(label, { exact: true });
        await input.focus();
        await type(typing);
        await settle();
        check("nothing saved while typing", writesFor(from, ids[name]).length === 0, writesFor(from, ids[name]));
        await tabOut(input);
        await settle();
        check("typed date saved", (await saved(ids[name]))[field] === NEW, await saved(ids[name]));
        check("saved once", writesFor(from, ids[name]).length === 1, writesFor(from, ids[name]));
      });
    }

    // Task panel: type a date, then Enter.
    await scenario("panel-start", async ({ check }) => {
      const panel = await openPanel("panel-start");
      const from = writes.length;
      await panel.getByLabel("Start date", { exact: true }).focus();
      await type(typing);
      await page.keyboard.press("Enter");
      await settle();
      check("typed date saved on Enter", (await saved(ids["panel-start"])).startDate === NEW, await saved(ids["panel-start"]));
      check("saved once", writesFor(from, ids["panel-start"]).length === 1, writesFor(from, ids["panel-start"]));
    });

    // Task panel: a half-typed edit, then a click elsewhere: "0" alone (no
    // day or month, and year 0 is not accepted), or the parts before the year
    // and two digits of it, which passes through dates of typed and old parts.
    for (const [name, keys] of [
      ["panel-partial", ["0"]],
      ["panel-partial-year", partialYear],
    ]) {
      await scenario(name, async ({ check }) => {
        const panel = await openPanel(name);
        const from = writes.length;
        const input = panel.getByLabel("Due date", { exact: true });
        await input.focus();
        await type(keys);
        await panel.getByText("Description", { exact: true }).click();
        await settle();
        check("saved date kept", (await saved(ids[name])).dueDate === OLD_DUE, await saved(ids[name]));
        check("nothing sent", writesFor(from, ids[name]).length === 0, writesFor(from, ids[name]));
        check("input shows the saved date", (await input.inputValue()) === OLD_DUE, await input.inputValue());
      });
    }

    // Task panel: a full date, then Escape.
    await scenario("panel-escape", async ({ check }) => {
      const panel = await openPanel("panel-escape");
      const from = writes.length;
      const input = panel.getByLabel("Due date", { exact: true });
      await input.focus();
      await type(typing);
      await page.keyboard.press("Escape");
      await settle();
      check("saved date kept", (await saved(ids["panel-escape"])).dueDate === OLD_DUE, await saved(ids["panel-escape"]));
      check("nothing sent", writesFor(from, ids["panel-escape"]).length === 0, writesFor(from, ids["panel-escape"]));
      check("panel still open", await panel.isVisible(), null);
      check("input shows the saved date", (await input.inputValue()) === OLD_DUE, await input.inputValue());
    });

    // Task panel: the Clear button.
    await scenario("panel-clear", async ({ check }) => {
      const panel = await openPanel("panel-clear");
      const from = writes.length;
      await panel.getByRole("button", { name: "Clear due date" }).click();
      await settle();
      check("cleared", (await saved(ids["panel-clear"])).dueDate === null, await saved(ids["panel-clear"]));
      check("sent once", writesFor(from, ids["panel-clear"]).length === 1, writesFor(from, ids["panel-clear"]));
    });

    // Task panel: a full date typed, then Clear, clicked or reached with Tab
    // and pressed: only null is sent, not the typed date first.
    for (const [name, use] of [
      ["panel-clear-click", async (clear) => clear.click()],
      // The task ID is passed in: the loop's own binding is not yet set
      // while this array is built.
      ["panel-clear-tab", async (clear, check, from, id) => {
        for (let i = 0; i < 3 && !(await clear.evaluate((el) => el === document.activeElement)); i++) {
          await page.keyboard.press("Tab");
        }
        await settle();
        check("focus on Clear", await clear.evaluate((el) => el === document.activeElement), null);
        check("nothing sent on reaching Clear", writesFor(from, id).length === 0, writesFor(from, id));
        await page.keyboard.press("Enter");
      }],
    ]) {
      await scenario(name, async ({ check }) => {
        const panel = await openPanel(name);
        const from = writes.length;
        await panel.getByLabel("Due date", { exact: true }).focus();
        await type(typing);
        await use(panel.getByRole("button", { name: "Clear due date" }), check, from, ids[name]);
        await settle();
        check("cleared", (await saved(ids[name])).dueDate === null, await saved(ids[name]));
        check("only null sent", JSON.stringify(writesFor(from, ids[name]).map((w) => w.body)) === '[{"dueDate":null}]', writesFor(from, ids[name]));
      });
    }

    // Task panel: every part deleted, then Tab out.
    await scenario("panel-emptied", async ({ check }) => {
      const panel = await openPanel("panel-emptied");
      const from = writes.length;
      const input = panel.getByLabel("Due date", { exact: true });
      await input.focus();
      await type(["Backspace", "ArrowRight", "Backspace", "ArrowRight", "Backspace"]);
      await settle();
      check("nothing saved while deleting", writesFor(from, ids["panel-emptied"]).length === 0, writesFor(from, ids["panel-emptied"]));
      await tabOut(input);
      await settle();
      check("cleared", (await saved(ids["panel-emptied"])).dueDate === null, await saved(ids["panel-emptied"]));
      check("sent once", writesFor(from, ids["panel-emptied"]).length === 1, writesFor(from, ids["panel-emptied"]));
    });

    // Task panel: a whole date set at once (as the picker does) saves at once.
    await scenario("panel-picked", async ({ check }) => {
      const panel = await openPanel("panel-picked");
      const input = panel.getByLabel("Due date", { exact: true });
      await input.fill(PICKED);
      await settle();
      check("saved without leaving the input", (await saved(ids["panel-picked"])).dueDate === PICKED, await saved(ids["panel-picked"]));
      check("input still focused", await input.evaluate((el) => el === document.activeElement), null);
    });

    // List inline cells: typed dates. These cells save the first complete
    // date they see; only "never null" is checked.
    for (const [name, old, field] of [
      ["list-due", OLD_DUE, "dueDate"],
      ["list-target", OLD_TARGET, "target"],
    ]) {
      await scenario(name, async ({ note }) => {
        await openList();
        await row(name).getByRole("button", { name: old, exact: true }).click();
        await row(name).locator('input[type="date"]').waitFor();
        await type(typing);
        await settle();
        await page.evaluate(() => document.activeElement?.blur());
        await settle();
        note("saved", (await saved(ids[name]))[field]);
      });
    }

    await scenario("list-picked", async ({ check }) => {
      await openList();
      await row("list-picked").getByRole("button", { name: OLD_DUE, exact: true }).click();
      await row("list-picked").locator('input[type="date"]').fill(PICKED);
      await settle();
      check("picked date saved", (await saved(ids["list-picked"])).dueDate === PICKED, await saved(ids["list-picked"]));
    });

    await scenario("list-backspace", async ({ note }) => {
      await openList();
      await row("list-backspace").getByRole("button", { name: OLD_DUE, exact: true }).click();
      await row("list-backspace").locator('input[type="date"]').waitFor();
      await page.keyboard.press("Backspace");
      await settle();
      await page.evaluate(() => document.activeElement?.blur());
      await settle();
      note("saved", (await saved(ids["list-backspace"])).dueDate);
    });

    // Bulk due date: type a date, then Enter.
    await scenario("bulk", async ({ check }) => {
      await openList();
      for (const name of ["bulk-1", "bulk-2"]) await row(name).locator('input[type="checkbox"]').first().check();
      const from = writes.length;
      // The filter bar's date inputs have titles; the bulk one does not.
      await page.locator('input[type="date"]:not([title])').focus();
      await type(typing);
      await page.keyboard.press("Enter");
      await settle();
      const both = [await saved(ids["bulk-1"]), await saved(ids["bulk-2"])].map((s) => s.dueDate);
      check("typed date applied to both", both.every((d) => d === NEW), both);
      const bulk = writes.slice(from).filter((w) => w.path.endsWith("/bulk-update"));
      check("applied once", bulk.length === 1, bulk);
    });

    // Bulk due date: a full date typed, then Clear: only null is applied.
    await scenario("bulk-clear", async ({ check }) => {
      await openList();
      for (const name of ["bulk-clear-1", "bulk-clear-2"]) await row(name).locator('input[type="checkbox"]').first().check();
      const from = writes.length;
      await page.locator('input[type="date"]:not([title])').focus();
      await type(typing);
      // The Clear button next to the bulk date input.
      await page.locator('input[type="date"]:not([title]) + button').click();
      await settle();
      const both = [await saved(ids["bulk-clear-1"]), await saved(ids["bulk-clear-2"])].map((s) => s.dueDate);
      check("cleared both", both.every((d) => d === null), both);
      const bulk = writes.slice(from).filter((w) => w.path.endsWith("/bulk-update"));
      check("only null applied", bulk.length === 1 && bulk[0].body.dueDate === null, bulk);
    });

    result.pageErrors = errors;
    if (errors.length) report.failures.push(`${locale}: page errors ${JSON.stringify(errors)}`);
    await browser.close();
    browser = undefined;
  }
} finally {
  await browser?.close();
  await vite?.close();
  if (created.workspaceId) await app.prisma.workspace.delete({ where: { id: created.workspaceId } }).catch(() => {});
  if (created.userId) await app.prisma.user.delete({ where: { id: created.userId } }).catch(() => {});
  await app.close();
  await rm(storage, { recursive: true, force: true });
}

if (process.env.DATE_INPUT_REPORT) {
  await writeFile(process.env.DATE_INPUT_REPORT, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ locales: Object.fromEntries(Object.entries(report.locales).map(([l, r]) => [l, r.order.join("/")])), failures: report.failures }, null, 2));
if (report.failures.length) process.exitCode = 1;
