// Production bundle size budget, checked by `vite build` (and so by CI's
// `pnpm build`). It reads Rollup's chunk graph rather than file names, so it
// knows exactly which chunks a page loads before it can render:
//
// - the entry chunk and everything it imports statically (index.html loads
//   these up front, for every page);
// - for each budgeted page, also its route component chunks and their static
//   imports. Dynamic imports (editors, panels, other routes) are not counted.
//
// Sizes are gzip (zlib default level, as the Vite build report shows). The
// budgets are the sizes measured in docs/remediation/p01.md plus a small
// margin. Raise one only together with a measurement showing why.
import { gzipSync } from "node:zlib";
import type { Plugin, Rollup } from "vite";

export interface PageBudget {
  name: string;
  /** Route files (relative to the frontend package) whose split components the page renders. */
  routes: string[];
  jsGzipKb: number;
}

export interface BundleBudget {
  entryJsGzipKb: number;
  entryCssGzipKb: number;
  pages: PageBudget[];
  /**
   * Packages that must never be part of the entry or of a budgeted page. A
   * name ending in "/" or "-" is a prefix (a scope or a package family).
   */
  lazyOnlyPackages: string[];
}

export const BUNDLE_BUDGET: BundleBudget = {
  entryJsGzipKb: 150,
  entryCssGzipKb: 15,
  pages: [
    { name: "login", routes: ["src/routes/login.tsx"], jsGzipKb: 195 },
    {
      name: "workspace dashboard",
      routes: [
        "src/routes/_authed.tsx",
        "src/routes/_authed/$workspaceSlug.tsx",
        "src/routes/_authed/$workspaceSlug/index.tsx",
      ],
      jsGzipKb: 275,
    },
  ],
  lazyOnlyPackages: [
    // Wiki editor (BlockNote) and the task description editor (TipTap)
    "@blocknote/",
    "@mantine/",
    "@tiptap/",
    "prosemirror-",
    "yjs",
    "y-prosemirror",
    // Project calendar
    "@fullcalendar/",
    // Chat message rendering
    "react-markdown",
    "micromark",
    // Emoji data
    "unicode-emoji-json",
    "emoji-mart",
    "@emoji-mart/",
    // Panel animations
    "framer-motion",
    "motion-dom",
  ],
};

export interface BundleChunk {
  fileName: string;
  code: string | Uint8Array;
  isEntry: boolean;
  imports: string[];
  moduleIds: string[];
  importedCss: string[];
}

export interface BudgetResult {
  report: string[];
  failures: string[];
}

const kb = (bytes: number) => (bytes / 1000).toFixed(1);
const gzipSize = (code: string | Uint8Array) => gzipSync(code).length;

function packageOf(pattern: string) {
  return pattern.endsWith("/") || pattern.endsWith("-") ? pattern : `${pattern}/`;
}

/** Checks a production bundle against the budget. `css` maps CSS file names to their content. */
export function checkBundle(
  chunks: BundleChunk[],
  css: Map<string, string | Uint8Array>,
  budget: BundleBudget = BUNDLE_BUDGET,
): BudgetResult {
  const report: string[] = [];
  const failures: string[] = [];
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));

  function closure(roots: string[]) {
    const seen = new Set<string>();
    const visit = (fileName: string) => {
      if (seen.has(fileName)) return;
      const chunk = byName.get(fileName);
      if (!chunk) return;
      seen.add(fileName);
      chunk.imports.forEach(visit);
    };
    roots.forEach(visit);
    return [...seen].map((fileName) => byName.get(fileName)!);
  }

  function lazyOnlyViolations(set: BundleChunk[]) {
    const found = new Set<string>();
    for (const chunk of set) {
      for (const id of chunk.moduleIds) {
        for (const pattern of budget.lazyOnlyPackages) {
          if (id.includes(`/node_modules/${packageOf(pattern)}`)) found.add(pattern);
        }
      }
    }
    return [...found];
  }

  function checkSet(label: string, set: BundleChunk[], limitKb: number) {
    const size = set.reduce((sum, chunk) => sum + gzipSize(chunk.code), 0);
    report.push(
      `${label}: ${kb(size)} kB gzip in ${set.length} JS files (budget ${limitKb} kB)`,
    );
    if (size > limitKb * 1000) {
      failures.push(`${label} is ${kb(size)} kB gzip, over its ${limitKb} kB budget`);
    }
    const lazyOnly = lazyOnlyViolations(set);
    if (lazyOnly.length > 0) {
      failures.push(`${label} includes packages that must load lazily: ${lazyOnly.join(", ")}`);
    }
  }

  // Chunks importing each other can run a module before its dependencies
  // (manual chunk grouping can cause this; see scripts/chunking.ts).
  const state = new Map<string, "visiting" | "done">();
  const findCycle = (fileName: string, path: string[]): string[] | undefined => {
    if (state.get(fileName) === "done") return undefined;
    if (state.get(fileName) === "visiting") return [...path.slice(path.indexOf(fileName)), fileName];
    state.set(fileName, "visiting");
    for (const next of byName.get(fileName)?.imports ?? []) {
      const cycle = findCycle(next, [...path, fileName]);
      if (cycle) return cycle;
    }
    state.set(fileName, "done");
    return undefined;
  };
  for (const chunk of chunks) {
    const cycle = findCycle(chunk.fileName, []);
    if (cycle) {
      failures.push(`circular chunk imports: ${cycle.join(" -> ")}`);
      break;
    }
  }

  const entries = chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName);
  if (entries.length === 0) failures.push("no entry chunk found");
  const initial = closure(entries);
  checkSet("entry JS", initial, budget.entryJsGzipKb);

  const initialCss = [...new Set(initial.flatMap((chunk) => chunk.importedCss))];
  const cssSize = initialCss.reduce(
    (sum, fileName) => sum + gzipSize(css.get(fileName) ?? ""),
    0,
  );
  report.push(
    `entry CSS: ${kb(cssSize)} kB gzip in ${initialCss.length} files (budget ${budget.entryCssGzipKb} kB)`,
  );
  if (cssSize > budget.entryCssGzipKb * 1000) {
    failures.push(
      `entry CSS is ${kb(cssSize)} kB gzip, over its ${budget.entryCssGzipKb} kB budget`,
    );
  }

  for (const page of budget.pages) {
    const roots = [...entries];
    for (const route of page.routes) {
      // TanStack Router's code splitter moves each route component into a
      // module named after the route file with a `tsr-split` query. Rollup may
      // merge a small one into another chunk; the page loads that chunk.
      const chunk = chunks.find((candidate) =>
        candidate.moduleIds.some(
          (id) => id.includes(`/${route}?`) && id.includes("tsr-split"),
        ),
      );
      if (chunk) roots.push(chunk.fileName);
      else failures.push(`${page.name}: no split component module for ${route} (is route code splitting enabled?)`);
    }
    checkSet(`${page.name} page JS`, closure(roots), page.jsGzipKb);
  }

  return { report, failures };
}

/** Vite plugin that fails the production build when the bundle exceeds the budget. */
export function bundleBudget(budget: BundleBudget = BUNDLE_BUDGET): Plugin {
  let log: (message: string) => void = console.log;
  return {
    name: "werkyn:bundle-budget",
    apply: "build",
    configResolved(config) {
      log = (message) => config.logger.info(message);
    },
    writeBundle(_options, bundle: Rollup.OutputBundle) {
      const chunks: BundleChunk[] = [];
      const css = new Map<string, string | Uint8Array>();
      for (const output of Object.values(bundle)) {
        if (output.type === "asset") {
          if (output.fileName.endsWith(".css")) css.set(output.fileName, output.source);
          continue;
        }
        chunks.push({
          fileName: output.fileName,
          code: output.code,
          isEntry: output.isEntry,
          imports: output.imports,
          moduleIds: output.moduleIds,
          importedCss: [...(output.viteMetadata?.importedCss ?? [])],
        });
      }
      const { report, failures } = checkBundle(chunks, css, budget);
      for (const line of report) log(`bundle budget: ${line}`);
      if (failures.length > 0) {
        this.error(
          `Bundle budget exceeded (see packages/frontend/scripts/bundle-budget.ts and docs/remediation/p01.md):\n- ${failures.join("\n- ")}`,
        );
      }
    },
  };
}
