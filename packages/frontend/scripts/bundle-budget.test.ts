import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLE_BUDGET,
  checkBundle,
  type BundleBudget,
  type BundleChunk,
} from "./bundle-budget";

// Random bytes do not compress, so a chunk of n bytes is just over n bytes gzipped.
function chunk(fileName: string, kb: number, extra: Partial<BundleChunk> = {}): BundleChunk {
  return {
    fileName,
    code: randomBytes(kb * 1000),
    isEntry: false,
    imports: [],
    moduleIds: [],
    importedCss: [],
    ...extra,
  };
}

const budget: BundleBudget = {
  entryJsGzipKb: 30,
  entryCssGzipKb: 5,
  pages: [
    {
      name: "dashboard",
      routes: ["src/routes/layout.tsx", "src/routes/layout/index.tsx"],
      jsGzipKb: 60,
    },
  ],
  lazyOnlyPackages: ["@blocknote/", "prosemirror-", "yjs"],
};

const node = (pkg: string) => `/repo/node_modules/.pnpm/x/node_modules/${pkg}/index.js`;

function app(overrides: { entryKb?: number; layoutKb?: number; dashboardImports?: string[] } = {}) {
  return [
    chunk("assets/index.js", overrides.entryKb ?? 20, {
      isEntry: true,
      imports: ["assets/vendor.js"],
      importedCss: ["assets/index.css"],
    }),
    chunk("assets/vendor.js", 5),
    chunk("assets/layout.js", overrides.layoutKb ?? 10, {
      moduleIds: ["/repo/packages/frontend/src/routes/layout.tsx?tsr-split=component"],
      imports: ["assets/index.js", "assets/shared.js"],
    }),
    chunk("assets/dashboard.js", 5, {
      moduleIds: ["/repo/packages/frontend/src/routes/layout/index.tsx?tsr-split=component"],
      imports: ["assets/index.js", "assets/shared.js", ...(overrides.dashboardImports ?? [])],
    }),
    chunk("assets/shared.js", 10),
    // Loaded only by dynamic import: never part of a page's initial JS.
    chunk("assets/editor.js", 500, {
      moduleIds: [node("@blocknote/core"), node("prosemirror-view"), node("yjs")],
    }),
  ];
}
const css = new Map([["assets/index.css", randomBytes(3000)]]);

describe("bundle budget", () => {
  it("passes within budget, counting each shared chunk once and no dynamic imports", () => {
    const result = checkBundle(app(), css, budget);
    expect(result.failures).toEqual([]);
    expect(result.report[0]).toMatch(/^entry JS: 25\.\d kB gzip in 2 JS files \(budget 30 kB\)$/);
    expect(result.report[1]).toMatch(/^entry CSS: 3\.\d kB gzip in 1 files/);
    // entry 20 + vendor 5 + layout 10 + dashboard 5 + shared 10, not the 500 kB editor
    expect(result.report[2]).toMatch(/^dashboard page JS: 50\.\d kB gzip in 5 JS files/);
  });

  it("fails when the entry grows past its budget", () => {
    const result = checkBundle(app({ entryKb: 26 }), css, budget);
    expect(result.failures).toEqual([
      expect.stringMatching(/^entry JS is 31\.\d kB gzip, over its 30 kB budget$/),
    ]);
  });

  it("fails when a page's route chunks grow past its budget", () => {
    const result = checkBundle(app({ layoutKb: 21 }), css, budget);
    expect(result.failures).toEqual([
      expect.stringMatching(/^dashboard page JS is 61\.\d kB gzip, over its 60 kB budget$/),
    ]);
  });

  it("fails when entry CSS grows past its budget", () => {
    const big = new Map([["assets/index.css", randomBytes(6000)]]);
    expect(checkBundle(app(), big, budget).failures).toEqual([
      expect.stringMatching(/^entry CSS is 6\.\d kB gzip, over its 5 kB budget$/),
    ]);
  });

  it("fails when a lazy-only package is imported statically by a page, whatever its size", () => {
    const chunks = app({ dashboardImports: ["assets/editor-glue.js"] });
    chunks.push(
      chunk("assets/editor-glue.js", 1, {
        moduleIds: [node("prosemirror-model"), node("yjs"), node("react")],
      }),
    );
    const result = checkBundle(chunks, css, { ...budget, pages: [{ ...budget.pages[0], jsGzipKb: 10_000 }] });
    expect(result.failures).toEqual([
      "dashboard page JS includes packages that must load lazily: prosemirror-, yjs",
    ]);
  });

  it("counts a route component that Rollup merged into another chunk with that chunk", () => {
    const chunks = app().filter((c) => c.fileName !== "assets/dashboard.js");
    chunks.find((c) => c.fileName === "assets/shared.js")!.moduleIds.push(
      "/repo/packages/frontend/src/routes/layout/index.tsx?tsr-split=component",
    );
    const result = checkBundle(chunks, css, budget);
    expect(result.failures).toEqual([]);
    expect(result.report[2]).toMatch(/^dashboard page JS: 45\.\d kB gzip in 4 JS files/);
  });

  it("fails when a budgeted route's component is no longer split out", () => {
    const chunks = app().filter((c) => c.fileName !== "assets/dashboard.js");
    expect(checkBundle(chunks, css, budget).failures).toEqual([
      "dashboard: no split component module for src/routes/layout/index.tsx (is route code splitting enabled?)",
    ]);
  });

  it("fails when chunks import each other", () => {
    const chunks = app();
    chunks.find((c) => c.fileName === "assets/shared.js")!.imports.push("assets/layout.js");
    expect(checkBundle(chunks, css, budget).failures).toEqual([
      "circular chunk imports: assets/layout.js -> assets/shared.js -> assets/layout.js",
    ]);
  });

  it("budgets routes that exist in the app", () => {
    const root = path.resolve(__dirname, "..");
    for (const page of BUNDLE_BUDGET.pages) {
      for (const route of page.routes) expect(existsSync(path.join(root, route)), route).toBe(true);
    }
  });
});
