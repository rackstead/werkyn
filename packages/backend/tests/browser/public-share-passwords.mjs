// Run with TEST_DATABASE_URL for an isolated migrated audit DB and an installed
// PLAYWRIGHT_MODULE (a package name or absolute path). No external service is used.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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
  JWT_SECRET: "public-browser-fixture-jwt-secret",
  COOKIE_SECRET: "public-browser-fixture-cookie-secret",
  COOKIE_SECURE: "false",
  COOKIE_SAMESITE: "lax",
});
const storage = await mkdtemp(path.join(os.tmpdir(), "werkyn-public-browser-"));
process.env.STORAGE_DIR = storage;
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const frontend = path.resolve(import.meta.dirname, "../../../frontend");
const { build, preview } = await import(
  pathToFileURL(path.join(frontend, "node_modules/vite/dist/node/index.js"))
);
const { buildApp } = await import("../../src/app.ts");
const { env } = await import("../../src/config/env.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { shareGrantCookieName } =
  await import("../../src/utils/share-grants.ts");
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-features=BackForwardCache",
    "--ignore-certificate-errors",
  ],
});
const report = { browser: browser.version(), modes: [] };
try {
  for (const mode of [
    { base: "/api", tls: false },
    { base: "/edge/werkyn/v1", tls: true },
  ]) {
    env.COOKIE_SECURE = mode.tls;
    let app, vite, context, workspace, user, page;
    const summary = { ...mode, checks: [], cookies: [], requestHeaders: [] };
    const check = (label) => {
      summary.checks.push(label);
      console.error(mode.base, label);
    };
    try {
      app = await buildApp();
      const receivedRequests = [];
      app.server.on("request", (request) => {
        const cookie = request.headers.cookie ?? "";
        receivedRequests.push({
          url: request.url,
          names: cookie
            .split(";")
            .map((item) => item.trim().split("=")[0])
            .filter((name) => name.startsWith("share_")),
          bytes: Buffer.byteLength(cookie),
        });
      });
      const identity = await app.prisma
        .$queryRaw`SELECT current_database(),current_user`;
      assert.equal(identity[0].current_database, database.pathname.slice(1));
      assert.equal(identity[0].current_user, "audit");
      const suffix = crypto.randomUUID();
      user = await app.prisma.user.create({
        data: {
          email: `public-browser-${suffix}@example.test`,
          displayName: "Public browser fixture",
          emailVerified: true,
        },
      });
      workspace = await app.prisma.workspace.create({
        data: {
          name: "Public browser fixture",
          slug: `pb-${suffix}`,
          members: { create: { userId: user.id, role: "ADMIN" } },
        },
      });
      const space = await app.prisma.wikiSpace.create({
        data: {
          workspaceId: workspace.id,
          name: "Public browser space",
          slug: `public-${suffix}`,
        },
      });
      const ownerToken = signAccessToken({ sub: user.id, email: user.email });
      const password = "Public-browser-password";
      const passwordHash = await bcrypt.hash(password, 10);
      async function makeShare(kind, protectedShare = true) {
        const token = crypto.randomUUID();
        const marker = `Public fixture ${token}`;
        if (kind === "wiki") {
          const page = await app.prisma.wikiPage.create({
            data: {
              spaceId: space.id,
              title: marker,
              createdById: user.id,
              content: [
                {
                  id: crypto.randomUUID(),
                  type: "paragraph",
                  props: {},
                  content: [
                    { type: "text", text: `Body ${marker}`, styles: {} },
                  ],
                  children: [],
                },
              ],
            },
          });
          const share = await app.prisma.wikiPageShare.create({
            data: {
              pageId: page.id,
              createdById: user.id,
              token,
              passwordHash: protectedShare ? passwordHash : null,
            },
          });
          return { ...share, kind, marker, route: `/share/${token}` };
        }
        const bytes = Buffer.from(`Owned public fixture bytes ${token}`);
        const storagePath = await app.storage.save(
          "files",
          workspace.id,
          crypto.randomUUID(),
          ".txt",
          bytes,
        );
        const file = await app.prisma.file.create({
          data: {
            workspaceId: workspace.id,
            uploadedById: user.id,
            ownerId: user.id,
            name: `${marker}.txt`,
            mimeType: "text/plain",
            size: bytes.length,
            storagePath,
          },
        });
        const share = await app.prisma.fileShareLink.create({
          data: {
            workspaceId: workspace.id,
            createdById: user.id,
            token,
            passwordHash: protectedShare ? passwordHash : null,
            files: { create: { fileId: file.id } },
          },
        });
        return {
          ...share,
          kind,
          file,
          bytes,
          marker: file.name,
          route: `/share/files/${token}`,
        };
      }
      const protectedShares = {
        wiki: await makeShare("wiki"),
        files: await makeShare("files"),
      };
      const siblings = {
        wiki: await makeShare("wiki"),
        files: await makeShare("files"),
      };
      const unprotected = {
        wiki: await makeShare("wiki", false),
        files: await makeShare("files", false),
      };
      await app.listen({ host: "127.0.0.1", port: 0 });
      let https;
      if (mode.tls) {
        const key = path.join(storage, "browser.key"),
          cert = path.join(storage, "browser.crt");
        execFileSync(
          "openssl",
          [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            key,
            "-out",
            cert,
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
          ],
          { stdio: "ignore" },
        );
        https = { key: await readFile(key), cert: await readFile(cert) };
      }
      const repository = path.resolve(frontend, "../..");
      const inputs = execFileSync(
        "git",
        [
          "ls-files",
          "packages/frontend/src",
          "packages/shared/src",
          "packages/frontend/index.html",
          "packages/frontend/vite.config.ts",
          "pnpm-lock.yaml",
        ],
        { cwd: repository },
      )
        .toString()
        .trim()
        .split("\n")
        .filter((name) => !name.includes(".test."));
      const digest = crypto.createHash("sha256").update(mode.base);
      for (const name of inputs)
        digest.update(name).update(await readFile(path.join(repository, name)));
      const outDir =
        !mode.tls && process.env.PUBLIC_SHARE_BROWSER_DEFAULT_DIST
          ? path.resolve(process.env.PUBLIC_SHARE_BROWSER_DEFAULT_DIST)
          : path.join(
              frontend,
              "node_modules/.cache/public-share-browser",
              digest.digest("hex"),
            );
      const cached = await access(path.join(outDir, "index.html")).then(
        () => true,
        () => false,
      );
      if (!cached) {
        const previousNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        try {
          await build({
            root: frontend,
            configFile: path.join(frontend, "vite.config.ts"),
            logLevel: "error",
            define: {
              "import.meta.env.VITE_API_BASE_URL": JSON.stringify(mode.base),
            },
            build: { outDir, emptyOutDir: true },
          });
        } finally {
          process.env.NODE_ENV = previousNodeEnv;
        }
      }
      vite = await preview({
        root: frontend,
        configFile: false,
        logLevel: "error",
        build: { outDir },
        preview: {
          host: "127.0.0.1",
          port: 0,
          strictPort: false,
          https,
          proxy: {
            [mode.base]: {
              target: app.listeningOrigin,
              changeOrigin: true,
              rewrite: (url) => `/api${url.slice(mode.base.length)}`,
            },
          },
        },
      });
      const address = vite.httpServer.address();
      const origin = `${mode.tls ? "https" : "http"}://127.0.0.1:${address.port}`;
      context = await browser.newContext({
        ignoreHTTPSErrors: true,
        acceptDownloads: true,
      });
      page = await context.newPage();
      page.setDefaultTimeout(20_000);
      page.on("pageerror", (error) =>
        console.error("browser page error", error.message),
      );
      page.on("console", (message) => {
        if (message.type() === "error")
          console.error("browser console", message.text());
      });
      async function navigate(route) {
        await page.bringToFront();
        if (page.url() === "about:blank") await page.goto(origin + route);
        else
          await page.evaluate((route) => {
            window.history.pushState({}, "", route);
            window.dispatchEvent(new PopStateEvent("popstate"));
          }, route);
        await page.waitForURL(origin + route);
      }
      const requests = [];
      context.on("request", (request) => requests.push(request));
      const apiPath = (share) =>
        `${mode.base}/public/${share.kind}/${share.token}`;
      const cookieName = (share) =>
        shareGrantCookieName(share.kind, share.token);
      async function latestHeaders(url) {
        const request = requests
          .filter((item) => item.url() === origin + url)
          .at(-1);
        // Chromium can divert a download before Playwright emits its request.
        // Observe the actual forwarded browser header at the backend in that case.
        if (!request) {
          const internal = `/api${url.slice(mode.base.length)}`;
          const received = receivedRequests
            .filter((item) => item.url === internal)
            .at(-1);
          assert(received, `Browser request absent at backend: ${url}`);
          summary.requestHeaders.push({
            path: url,
            shareCookieNames: received.names,
            cookieBytes: received.bytes,
            observer: "backend browser request",
          });
          return received.names;
        }
        const headers = await request.allHeaders();
        const names = (headers.cookie ?? "")
          .split(";")
          .map((item) => item.trim().split("=")[0])
          .filter((name) => name.startsWith("share_"));
        summary.requestHeaders.push({
          path: url,
          shareCookieNames: names,
          cookieBytes: Buffer.byteLength(headers.cookie ?? ""),
        });
        return names;
      }
      async function fetchPublic(url) {
        return page.evaluate(async (url) => {
          const response = await fetch(url, { credentials: "include" });
          return {
            status: response.status,
            body: await response.text(),
            cache: response.headers.get("cache-control"),
          };
        }, url);
      }
      async function verify(share, entered = password) {
        const input = page.getByPlaceholder("Enter password");
        await input.fill(entered);
        assert.equal(await input.inputValue(), entered);
        await input.press("Enter");
      }
      async function mutate(share, data) {
        const url =
          share.kind === "wiki"
            ? `/api/wiki/shares/${share.id}`
            : `/api/workspaces/${workspace.id}/file-share-links/${share.id}`;
        const response = await app.inject({
          method: "PATCH",
          url,
          payload: data,
          headers: { authorization: `Bearer ${ownerToken}` },
          remoteAddress: "10.80.0.1",
        });
        assert.equal(response.statusCode, 200, response.body);
        assert(!response.body.includes("passwordHash"));
      }
      for (const kind of ["wiki", "files"]) {
        const share = protectedShares[kind];
        await navigate(share.route);
        await page.getByText("Password required", { exact: true }).waitFor();
        assert.deepEqual(await latestHeaders(apiPath(share)), []);
        await verify(share, "incorrect");
        await page
          .getByText("Invalid password", { exact: true })
          .first()
          .waitFor();
        assert.equal(
          (await context.cookies()).filter(
            (cookie) => cookie.name === cookieName(share),
          ).length,
          0,
        );
        await verify(share);
        await page.getByText(share.marker, { exact: true }).waitFor();
        const cookie = (await context.cookies()).find(
          (item) => item.name === cookieName(share),
        );
        assert(cookie);
        assert.equal(cookie.path, apiPath(share));
        assert.equal(cookie.httpOnly, true);
        assert.equal(cookie.secure, mode.tls);
        assert.equal(cookie.sameSite, "Lax");
        check(
          `${kind}: wrong/correct password and computed default cookie path/flags`,
        );
        await page.reload();
        await page.getByText(share.marker, { exact: true }).waitFor();
        assert.deepEqual(await latestHeaders(apiPath(share)), [
          cookieName(share),
        ]);
        const reverified = await page.evaluate(
          async ({ url, password }) => {
            const r = await fetch(url, {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ password }),
            });
            return r.status;
          },
          { url: `${apiPath(share)}/validate`, password },
        );
        assert.equal(reverified, 200);
        assert.equal(
          (await context.cookies()).filter(
            (item) => item.name === cookieName(share),
          ).length,
          1,
        );
        check(`${kind}: reload and revalidation replacement`);
        if (kind === "files") {
          const downloading = page.waitForEvent("download");
          await page.getByRole("link", { name: "Download" }).click();
          const download = await downloading;
          assert.deepEqual(await readFile(await download.path()), share.bytes);
          assert.deepEqual(
            await latestHeaders(`${apiPath(share)}/${share.file.id}/download`),
            [cookieName(share)],
          );
          check("files: actual download bytes and matching grant header");
        }
        const independent = await browser.newContext({
          ignoreHTTPSErrors: true,
        });
        try {
          const visitor = await independent.newPage();
          await visitor.goto(origin + share.route);
          await visitor
            .getByText("Password required", { exact: true })
            .waitFor();
          if (kind === "files")
            assert.equal(
              await visitor.evaluate(
                async (url) => (await fetch(url)).status,
                `${apiPath(share)}/${share.file.id}/download`,
              ),
              403,
            );
        } finally {
          await independent.close();
          await page.bringToFront();
        }
        check(`${kind}: independent browser remains locked`);
        const sibling = siblings[kind];
        await navigate(sibling.route);
        await page.getByText("Password required", { exact: true }).waitFor();
        assert.deepEqual(await latestHeaders(apiPath(sibling)), []);
        await verify(sibling);
        await page.getByText(sibling.marker, { exact: true }).waitFor();
        await fetchPublic(apiPath(share));
        assert.deepEqual(await latestHeaders(apiPath(share)), [
          cookieName(share),
        ]);
        await fetchPublic(apiPath(sibling));
        assert.deepEqual(await latestHeaders(apiPath(sibling)), [
          cookieName(sibling),
        ]);
        await fetchPublic(`${apiPath(share)}suffix`);
        assert.deepEqual(await latestHeaders(`${apiPath(share)}suffix`), []);
        check(`${kind}: sibling and token-prefix sibling cookie exclusion`);
        const open = unprotected[kind];
        await navigate(open.route);
        await page.getByText(open.marker, { exact: true }).waitFor();
        assert.deepEqual(await latestHeaders(apiPath(open)), []);
        if (kind === "files") {
          const response = await fetchPublic(
            `${apiPath(open)}/${open.file.id}/download`,
          );
          assert.equal(response.status, 200);
          assert.equal(response.body, open.bytes.toString());
        }
        check(`${kind}: unprotected content works without grants`);
        await mutate(share, { password: "Rotated-browser-password" });
        await navigate(share.route);
        await page.getByText("Password required", { exact: true }).waitFor();
        await verify(share, "Rotated-browser-password");
        await page.getByText(share.marker, { exact: true }).waitFor();
        check(`${kind}: rotation revokes and new password succeeds`);
        if (kind === "files") {
          await mutate(share, {
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          });
          await page.reload();
          await page.getByText("Share not found", { exact: true }).waitFor();
          assert.equal(
            (await fetchPublic(`${apiPath(share)}/${share.file.id}/download`))
              .status,
            404,
          );
          await mutate(share, { expiresAt: null });
          check("files: expiry revokes metadata and download");
        }
        await mutate(share, { enabled: false });
        await page.reload();
        await page
          .getByText(kind === "wiki" ? "Page not found" : "Share not found", {
            exact: true,
          })
          .waitFor();
        await mutate(share, { enabled: true });
        await page.reload();
        await page.getByText("Password required", { exact: true }).waitFor();
        check(`${kind}: disable/re-enable does not revive the old grant`);
      }
      for (let i = 0; i < 3; i++) {
        const extra = await makeShare("files");
        await navigate(extra.route);
        await page.getByText("Password required", { exact: true }).waitFor();
        await verify(extra);
        await page.getByText(extra.marker, { exact: true }).waitFor();
      }
      await fetchPublic(apiPath(siblings.files));
      assert.deepEqual(await latestHeaders(apiPath(siblings.files)), [
        cookieName(siblings.files),
      ]);
      await fetchPublic(apiPath(siblings.wiki));
      assert.deepEqual(await latestHeaders(apiPath(siblings.wiki)), [
        cookieName(siblings.wiki),
      ]);
      await fetchPublic(`${mode.base}/users/me`);
      assert.deepEqual(await latestHeaders(`${mode.base}/users/me`), []);
      summary.cookies = (await context.cookies()).map(
        ({ name, path, httpOnly, secure }) => ({
          name,
          path,
          httpOnly,
          secure,
        }),
      );
      assert.equal(
        summary.cookies.filter((cookie) => cookie.name.startsWith("share_"))
          .length,
        7,
      );
      check(
        "seven share cookies in jar send only matching share cookie; other-kind and unrelated API exclusion",
      );
      report.modes.push(summary);
    } catch (error) {
      console.error(
        JSON.stringify({
          mode,
          checks: summary.checks,
          url: page?.url(),
          body: await page?.locator("body").innerText(),
        }),
      );
      throw error;
    } finally {
      await context?.close();
      if (vite)
        await new Promise((resolve) => {
          vite.httpServer.close(resolve);
          vite.httpServer.closeAllConnections?.();
        });
      if (workspace)
        await app.prisma.workspace.delete({ where: { id: workspace.id } });
      if (user) await app.prisma.user.delete({ where: { id: user.id } });
      await app?.close();
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await rm(storage, { recursive: true, force: true });
}
