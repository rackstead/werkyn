// Typing a Drive share link's expiry date in real Chromium, with three orders
// of the date parts (month/day/year, day/month/year, year/month/day), each in
// a different time zone. A half-typed date input reports "" (or a partial year
// such as 0020-03-14), so a form that reads only `value` treated it as "no
// expiry": Create made a link that never expires and Save removed the expiry.
// This records every create and update request the server receives and the
// stored expiry, and fails when typing (rather than an explicit choice) leads
// to a link without an expiry or with an expiry other than the typed date.
//
// Run from packages/backend after `pnpm build`, with TEST_DATABASE_URL naming a
// migrated disposable loopback database whose name starts with werkyn_audit_,
// and PLAYWRIGHT_MODULE naming the installed package or module path:
//
//   node --import tsx tests/browser/share-expiry-typing.mjs
//
// SHARE_EXPIRY_DIST may name another frontend build (default: packages/
// frontend/dist), SHARE_EXPIRY_REPORT a JSON file for the results,
// SHARE_EXPIRY_SHOTS a directory for screenshots of failed scenarios,
// SHARE_EXPIRY_LOCALES a comma-separated subset of en-US, de-DE and ja-JP, and
// SHARE_EXPIRY_SCENARIOS a comma-separated subset of the scenarios.
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
  JWT_SECRET: "share-expiry-browser-fixture-jwt-secret",
  COOKIE_SECRET: "share-expiry-browser-fixture-cookie-secret",
  COOKIE_SECURE: "false",
  COOKIE_SAMESITE: "lax",
});
const storage = await mkdtemp(path.join(os.tmpdir(), "werkyn-share-expiry-"));
process.env.STORAGE_DIR = storage;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const frontend = path.resolve(import.meta.dirname, "../../../frontend");
const dist = path.resolve(process.env.SHARE_EXPIRY_DIST ?? path.join(frontend, "dist"));
const { preview } = await import(
  pathToFileURL(path.join(frontend, "node_modules/vite/dist/node/index.js"))
);
const { buildApp } = await import("../../src/app.ts");

// The typed date is the 2027 New York daylight saving day. Its end, the
// instant a link set to it stops working, was worked out by hand per zone and
// is checked against endOfDay() below.
const NEW = "2027-03-14";
const PAST = "2025-12-31";
// An existing link's expiry, set as the end of this day in the zone. It is a
// year ahead, so a half-typed part that the browser completes as focus leaves
// (a month "0" becomes 01) still gives a future date.
const OLD = "2027-12-24";
const RUNS = [
  {
    locale: "en-US",
    zone: "America/New_York",
    end: { [NEW]: "2027-03-15T03:59:59.000Z", [OLD]: "2027-12-25T04:59:59.000Z" },
  },
  {
    locale: "de-DE",
    zone: "Pacific/Kiritimati",
    end: { [NEW]: "2027-03-14T09:59:59.000Z", [OLD]: "2027-12-24T09:59:59.000Z" },
  },
  {
    locale: "ja-JP",
    zone: "Pacific/Pago_Pago",
    end: { [NEW]: "2027-03-15T10:59:59.000Z", [OLD]: "2027-12-25T10:59:59.000Z" },
  },
];
const password = "Share-expiry-browser-password";
const report = { dist, runs: {}, failures: [] };

/** The wall clock of `instant` in `zone`, as a UTC timestamp. */
function wallClock(instant, zone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
}
/** The instant `date` (YYYY-MM-DD) ends in `zone`: its 23:59:59 there. */
function endOfDay(date, zone) {
  const [y, m, d] = date.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d, 23, 59, 59);
  let instant = target;
  for (let i = 0; i < 3; i++) instant += target - wallClock(instant, zone);
  return new Date(instant).toISOString();
}
/** Today in `zone`, YYYY-MM-DD. */
const todayIn = (zone) => new Date(wallClock(Date.now(), zone)).toISOString().slice(0, 10);
for (const run of RUNS) {
  for (const [date, end] of Object.entries(run.end)) assert.equal(endOfDay(date, run.zone), end);
}

// Scenarios that deliberately leave a link without an expiry; every other
// one must never send a missing or null expiry.
const DELIBERATE = new Set(["create-none", "create-cleared", "save-remove"]);
const CREATE = [
  "create-half", "create-two-parts", "create-partial-year", "create-half-enter",
  "create-past", "create-full-click", "create-full-keyboard", "create-none", "create-cleared",
  "create-focus-click-zero", "create-focus-click-full",
];
const SAVE = [
  "save-half", "save-partial-year", "save-backspace", "save-untouched",
  "save-past", "save-full-click", "save-full-keyboard", "save-remove",
  "save-focus-click-half", "save-double-click-full",
];
// SHARE_EXPIRY_SCENARIOS (comma-separated) runs only those scenarios.
const ONLY_SCENARIOS = process.env.SHARE_EXPIRY_SCENARIOS?.split(",");

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
      email: `share-expiry-${suffix}@example.test`,
      passwordHash: await bcrypt.hash(password, 10),
      displayName: "Share expiry fixture",
      emailVerified: true,
    },
  });
  created.userId = user.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: "Share expiry fixture",
      slug: `se-${suffix}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  created.workspaceId = workspace.id;
  // One file per scenario; a Save scenario's file has a link expiring at the
  // end of OLD in that run's zone.
  const files = {};
  const folders = {};
  for (const run of RUNS) {
    files[run.locale] = {};
    // A folder per run, so its files fit on one screen.
    folders[run.locale] = await prisma.file.create({
      data: {
        workspaceId: workspace.id,
        uploadedById: user.id,
        ownerId: user.id,
        name: `${run.locale} expiry`,
        isFolder: true,
      },
    });
    for (const name of [...CREATE, ...SAVE]) {
      const file = await prisma.file.create({
        data: {
          workspaceId: workspace.id,
          parentId: folders[run.locale].id,
          uploadedById: user.id,
          ownerId: user.id,
          name: `${run.locale} ${name}.txt`,
          mimeType: "text/plain",
          size: 1,
          storagePath: `fixture/${suffix}/${run.locale}-${name}.txt`,
        },
      });
      files[run.locale][name] = file.id;
      if (name.startsWith("save-")) {
        await prisma.fileShareLink.create({
          data: {
            workspaceId: workspace.id,
            token: crypto.randomBytes(32).toString("base64url"),
            expiresAt: new Date(run.end[OLD]),
            createdById: user.id,
            files: { create: { fileId: file.id } },
          },
        });
      }
    }
  }
  const stored = async (fileId) =>
    (
      await prisma.fileShareLink.findMany({
        where: { files: { some: { fileId } } },
        select: { expiresAt: true },
        orderBy: { createdAt: "asc" },
      })
    ).map((link) => link.expiresAt?.toISOString() ?? null);

  // ─── Servers ──────────────────────────────────────────────
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

  /** The order of the date parts in this browser's date inputs. */
  async function partOrder(context) {
    const page = await context.newPage();
    await page.setContent(`<input type="date" value="${OLD}">`);
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

  // SHARE_EXPIRY_LOCALES (comma-separated) runs only those languages.
  const only = process.env.SHARE_EXPIRY_LOCALES?.split(",");
  for (const run of RUNS.filter((r) => !only || only.includes(r.locale))) {
    const { locale, zone } = run;
    // On Linux, Chromium takes the date input's part order from the
    // environment's language; --lang alone is not enough there.
    const posix = `${locale.replace("-", "_")}.UTF-8`;
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", `--lang=${locale}`],
      env: { ...process.env, LANG: posix, LANGUAGE: locale.replace("-", "_"), LC_ALL: posix },
    });
    const context = await browser.newContext({ locale, timezoneId: zone, viewport: { width: 1400, height: 1000 } });
    await context.route((url) => url.origin !== origin, (route) => route.abort());
    const order = await partOrder(context);
    // A month or day moves on to the next part after two digits; a year takes
    // up to six, so a year that is not last is followed by ArrowRight.
    const keysFor = (date, parts = order) => {
      const [year, month, day] = date.split("-");
      const digits = { year, month, day };
      return parts.flatMap((part) => [
        ...digits[part],
        ...(part === "year" && order.indexOf(part) < 2 ? ["ArrowRight"] : []),
      ]);
    };
    const keys = {
      full: keysFor(NEW),
      past: keysFor(PAST),
      half: [keysFor(NEW, order.slice(0, 1))[0]],
      twoParts: keysFor(NEW, order.slice(0, 2)),
      partialYear: [...keysFor(NEW, order.slice(0, order.indexOf("year"))), "2", "0"],
    };
    const result = { browser: browser.version(), zone, order, keys, scenarios: {} };
    report.runs[locale] = result;
    console.error(locale, zone, order.join("/"), keys.full.join(" "));

    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Every share-link write the page sends, and how many requests are open.
    const writes = [];
    let open = 0;
    page.on("request", (request) => {
      open++;
      const url = new URL(request.url());
      if (!/\/(files\/share-links|file-share-links\/)/.test(url.pathname) || request.method() === "GET") return;
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
    await page.goto(`${origin}/${workspace.slug}/drive?section=drive&folderId=${folders[locale].id}`);
    await page.getByText(`${locale} ${SAVE.at(-1)}.txt`, { exact: true }).waitFor();

    // An input with a 4-digit `max` year moves on after four year digits by
    // itself, so the ArrowRight after a year that is not last is left out.
    async function type(list) {
      const moves = await page.evaluate(() => /^\d{4}-/.test(document.activeElement?.max ?? ""));
      for (const key of list) {
        if (key === "ArrowRight" && moves) continue;
        await page.keyboard.press(key, { delay: 20 });
      }
    }
    /** A real mouse click at the button's centre, enabled or not. */
    async function press(button) {
      const box = await button.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    /** Tab until `button` has focus (a disabled button never gets it). */
    async function tabTo(button) {
      for (let i = 0; i < 8; i++) {
        if (await button.evaluate((el) => el === document.activeElement)) return true;
        await page.keyboard.press("Tab");
      }
      return button.evaluate((el) => el === document.activeElement);
    }
    const shareDialog = () => page.getByRole("dialog", { name: /^Share / });
    async function closeDialog() {
      const dialog = shareDialog();
      for (let i = 0; i < 3 && (await dialog.count()); i++) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(150);
      }
      await dialog.waitFor({ state: "detached" });
    }
    async function openLinkTab(name) {
      await settle();
      const fileName = `${locale} ${name}.txt`;
      // The row's context menu: a click on the row would open the preview.
      await page.getByText(fileName, { exact: true }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Share" }).click();
      const dialog = shareDialog();
      await dialog.getByRole("button", { name: "Link", exact: true }).click();
      await settle();
      return dialog;
    }
    /** The existing link's expiry editor, opened. */
    async function openExpiryEditor(dialog) {
      // The second Change button: the first one is the password's.
      await dialog.getByRole("button", { name: "Change", exact: true }).nth(1).click();
      return dialog.locator('input[type="date"]');
    }
    const toasts = () => page.locator("[data-sonner-toast]").allTextContents();
    const today = todayIn(zone);
    /** Whether the dialog may send `shown`, a value read from the input. */
    const sendable = (shown) =>
      /^(19|2\d)\d{2}-\d{2}-\d{2}$/.test(shown) && shown >= today;
    /** What a submit button looks like to the user. */
    const looks = async (button) =>
      (await button.count())
        ? (await button.isDisabled()) || (await button.getAttribute("aria-disabled")) === "true"
          ? "disabled"
          : "enabled"
        : "absent";

    /**
     * Runs one scenario on its own file. The body returns what the date input
     * showed just before the button was pressed (`shown`), or nothing when no
     * date was involved. Checked for every scenario but the deliberate ones:
     * no request creates a link without an expiry or sets it to null; and
     * every expiry sent is the end of the date the input showed, in the
     * future. `expect` adds the scenario's own result: "kept" (the link keeps
     * OLD, or no link is made), or a date the link must end up with.
     */
    async function scenario(name, body, expect) {
      if (ONLY_SCENARIOS && !ONLY_SCENARIOS.includes(name)) return;
      const from = writes.length;
      const id = files[locale][name];
      const record = { writes: [], stored: null, toasts: [], checks: {}, notes: {} };
      result.scenarios[name] = record;
      const check = (label, ok, detail) => {
        record.checks[label] = ok ? true : { ok: false, detail };
        if (!ok) report.failures.push(`${locale} ${name}: ${label} ${JSON.stringify(detail)}`);
      };
      const note = (label, value) => (record.notes[label] = value);
      const toastsBefore = new Set(await toasts());
      let shown;
      try {
        shown = await body({ check, note });
        await settle();
      } catch (error) {
        check("ran", false, String(error?.stack ?? error).slice(0, 800));
        if (process.env.SHARE_EXPIRY_SHOTS) {
          await page
            .screenshot({ path: path.join(process.env.SHARE_EXPIRY_SHOTS, `${locale}-${name}.png`) })
            .catch(() => {});
        }
      }
      record.toasts = (await toasts()).filter((t) => !toastsBefore.has(t));
      record.writes = writes.slice(from).map(({ method, body: sent }) => ({ method, body: sent }));
      record.stored = await stored(id);
      if (shown !== undefined) note("shown before the press", shown);
      if (!DELIBERATE.has(name)) {
        const lost = record.writes.filter((w) =>
          w.method === "POST" ? w.body?.expiresAt === undefined : w.body?.expiresAt === null,
        );
        check("no request removes or omits the expiry", lost.length === 0, lost);
        const sent = record.writes.filter((w) => typeof w.body?.expiresAt === "string");
        const unseen = sent.filter(
          (w) => !sendable(shown ?? "") || w.body.expiresAt !== endOfDay(shown, zone),
        );
        check("every expiry sent is the end of a future date the input showed", unseen.length === 0, unseen);
        if (shown && shown !== NEW && sent.length) note("sent a date other than the typed one", shown);
      }
      if (expect === "kept") {
        const kept = name.startsWith("save-") ? [run.end[OLD]] : [];
        // A whole future date shown on the way to the typed one may be sent.
        const shownEnd = sendable(shown ?? "") ? [endOfDay(shown, zone)] : null;
        const ok =
          JSON.stringify(record.stored) === JSON.stringify(kept) ||
          (shownEnd && JSON.stringify(record.stored) === JSON.stringify(shownEnd));
        check("expiry kept (or the shown date)", ok, record.stored);
      } else if (expect !== undefined) {
        check("stored", JSON.stringify(record.stored) === JSON.stringify([expect]), record.stored);
        check("sent once", record.writes.length === 1, record.writes);
      }
      await closeDialog().catch(() => {});
      console.error(locale, name, JSON.stringify(record.checks), JSON.stringify(record.notes), JSON.stringify(record.writes), JSON.stringify(record.stored));
    }

    const typedEnd = run.end[NEW];
    const input = (dialog) => dialog.locator('input[type="date"]');

    // ─── Create ─────────────────────────────────────────────
    // Incomplete or past dates, then a click on Create (or Enter).
    for (const [name, list, submit] of [
      ["create-half", keys.half, "click"],
      ["create-two-parts", keys.twoParts, "click"],
      ["create-partial-year", keys.partialYear, "click"],
      ["create-half-enter", keys.half, "enter"],
      ["create-past", keys.past, "click"],
    ]) {
      await scenario(name, async ({ note }) => {
        const dialog = await openLinkTab(name);
        await input(dialog).focus();
        await type(list);
        const shown = await input(dialog).inputValue();
        const button = dialog.getByRole("button", { name: "Create link", exact: true });
        note("Create before the press", await looks(button));
        if (submit === "click") await press(button);
        else await page.keyboard.press("Enter");
        await settle();
        note("Create after the press", await looks(button));
        note("input after the press", await input(dialog).inputValue().catch(() => "gone"));
        return shown;
      }, "kept");
    }

    // A complete date, then a click on Create, or Tab to it and Enter.
    for (const [name, submit] of [
      ["create-full-click", "click"],
      ["create-full-keyboard", "keyboard"],
    ]) {
      await scenario(name, async ({ check }) => {
        const dialog = await openLinkTab(name);
        await input(dialog).focus();
        await type(keys.full);
        const shown = await input(dialog).inputValue();
        const button = dialog.getByRole("button", { name: "Create link", exact: true });
        if (submit === "click") await press(button);
        else {
          check("Create reachable by Tab", await tabTo(button), null);
          await page.keyboard.press("Enter");
        }
        return shown;
      }, typedEnd);
    }

    // Deliberately no expiry: Create without a date.
    await scenario("create-none", async () => {
      const dialog = await openLinkTab("create-none");
      await press(dialog.getByRole("button", { name: "Create link", exact: true }));
    }, null);

    // Deliberately no expiry: a half-typed date removed with Clear date.
    await scenario("create-cleared", async ({ note, check }) => {
      const dialog = await openLinkTab("create-cleared");
      await input(dialog).focus();
      await type(keys.twoParts);
      const clear = dialog.getByRole("button", { name: "Clear date", exact: true });
      if (!(await clear.count())) {
        note("Clear date", "absent");
        return;
      }
      await press(clear);
      check("input emptied", (await input(dialog).inputValue()) === "", await input(dialog).inputValue());
      await press(dialog.getByRole("button", { name: "Create link", exact: true }));
    }, null);

    // A click that leaves focus in the date input (element.click(), as some
    // assistive technology and automation send it): no press, and no blur
    // for Chromium to settle a half-typed part. A lone "0" in the first part
    // of an empty input still reads as empty then.
    for (const [name, list, expect] of [
      ["create-focus-click-zero", ["0"], "kept"],
      ["create-focus-click-full", keys.full, typedEnd],
    ]) {
      await scenario(name, async ({ note }) => {
        const dialog = await openLinkTab(name);
        await input(dialog).focus();
        await type(list);
        const shown = await input(dialog).inputValue();
        note("bad input before the click", await input(dialog).evaluate((el) => el.validity.badInput));
        const button = dialog.getByRole("button", { name: "Create link", exact: true });
        note("Create before the click", await looks(button));
        await button.evaluate((el) => el.click());
        return shown;
      }, expect);
    }

    // ─── Change an existing link's expiry ───────────────────
    for (const [name, list] of [
      ["save-half", keys.half],
      ["save-partial-year", keys.partialYear],
      ["save-backspace", ["Backspace"]],
      ["save-untouched", []],
      ["save-past", keys.past],
    ]) {
      await scenario(name, async ({ note }) => {
        const dialog = await openLinkTab(name);
        await openExpiryEditor(dialog);
        note("editor starts with", await input(dialog).inputValue());
        await input(dialog).focus();
        await type(list);
        const shown = await input(dialog).inputValue();
        const save = dialog.getByRole("button", { name: "Save", exact: true });
        note("Save before the press", await looks(save));
        await press(save);
        await settle();
        note("Save after the press", await looks(save));
        note("input after the press", await input(dialog).inputValue().catch(() => "gone"));
        return shown;
      }, "kept");
    }

    for (const [name, submit] of [
      ["save-full-click", "click"],
      ["save-full-keyboard", "keyboard"],
    ]) {
      await scenario(name, async ({ check }) => {
        const dialog = await openLinkTab(name);
        await openExpiryEditor(dialog);
        await input(dialog).focus();
        await type(keys.full);
        const shown = await input(dialog).inputValue();
        const save = dialog.getByRole("button", { name: "Save", exact: true });
        if (submit === "click") await press(save);
        else {
          check("Save reachable by Tab", await tabTo(save), null);
          await page.keyboard.press("Enter");
        }
        return shown;
      }, typedEnd);
    }

    // Half a part, then a click that leaves focus in the input.
    await scenario("save-focus-click-half", async ({ note }) => {
      const dialog = await openLinkTab("save-focus-click-half");
      await openExpiryEditor(dialog);
      await input(dialog).focus();
      await type(keys.half);
      const shown = await input(dialog).inputValue();
      const save = dialog.getByRole("button", { name: "Save", exact: true });
      note("Save before the click", await looks(save));
      await save.evaluate((el) => el.click());
      return shown;
    }, "kept");

    // A double-click on Save with the full date: one request.
    await scenario("save-double-click-full", async () => {
      const dialog = await openLinkTab("save-double-click-full");
      await openExpiryEditor(dialog);
      await input(dialog).focus();
      await type(keys.full);
      const shown = await input(dialog).inputValue();
      const box = await dialog.getByRole("button", { name: "Save", exact: true }).boundingBox();
      await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
      return shown;
    }, typedEnd);

    // Deliberately removing the expiry, with the explicit button.
    await scenario("save-remove", async ({ check, note }) => {
      const dialog = await openLinkTab("save-remove");
      await openExpiryEditor(dialog);
      const remove = dialog.getByRole("button", { name: "Remove expiration", exact: true });
      if (!(await remove.count())) {
        note("Remove expiration", "absent");
        return;
      }
      await press(remove);
      await settle();
      check("the link shows it never expires", await dialog.getByText("Expires (never)").isVisible(), null);
    }, null);

    result.pageErrors = errors;
    if (errors.length) report.failures.push(`${locale}: page errors ${JSON.stringify(errors)}`);
    await browser.close();
    browser = undefined;
  }
} catch (error) {
  report.failures.push(`stopped: ${String(error?.stack ?? error).slice(0, 800)}`);
} finally {
  await browser?.close();
  await vite?.close();
  if (created.workspaceId) await app.prisma.workspace.delete({ where: { id: created.workspaceId } }).catch(() => {});
  if (created.userId) await app.prisma.user.delete({ where: { id: created.userId } }).catch(() => {});
  await app.close();
  await rm(storage, { recursive: true, force: true });
}

if (process.env.SHARE_EXPIRY_REPORT) {
  await writeFile(process.env.SHARE_EXPIRY_REPORT, JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify(
    {
      runs: Object.fromEntries(Object.entries(report.runs).map(([l, r]) => [l, `${r.order.join("/")} ${r.zone}`])),
      failures: report.failures,
    },
    null,
    2,
  ),
);
if (report.failures.length) process.exitCode = 1;
