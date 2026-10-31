import { describe, expect, it } from "vitest";
import { chunkGroups } from "./chunking";

const src = (path: string) => `/app/packages/frontend/src/${path}`;
const route = (file: string) => src(`routes/${file}?tsr-split=component`);
const nm = (path: string) => `/app/node_modules/.pnpm/x/node_modules/${path}`;

// A module graph: id -> statically imported ids. `entry` is the html entry.
function graph(edges: Record<string, string[]>, entry = "/app/packages/frontend/index.html") {
  const ids = new Set([entry, ...Object.keys(edges), ...Object.values(edges).flat()]);
  return {
    getModuleIds: () => ids.values(),
    getModuleInfo: (id: string) =>
      ids.has(id) ? ({ id, isEntry: id === entry, importedIds: edges[id] ?? [] } as never) : null,
  };
}

const app: Record<string, string[]> = {
  "/app/packages/frontend/index.html": [src("main.tsx")],
  [src("main.tsx")]: [nm("react/index.js"), src("routeTree.gen.ts")],
  [src("routeTree.gen.ts")]: [nm("lucide-react/dist/esm/lucide-react.js")],
  [nm("lucide-react/dist/esm/lucide-react.js")]: [nm("lucide-react/dist/esm/icons/x.js")],
  [nm("lucide-react/dist/esm/icons/x.js")]: [nm("react/index.js")],
  [route("login.tsx")]: [src("components/ui/button.tsx"), src("features/auth/login-form.tsx")],
  [route("share.$token.tsx")]: [src("features/wiki/wiki-editor.tsx"), nm("@floating-ui/dom/index.js")],
  [route("_authed.tsx")]: [nm("react/index.js")],
  [route("_authed/$workspaceSlug.tsx")]: [
    src("components/layout/sidebar.tsx"),
    src("components/ui/button.tsx"),
    nm("@floating-ui/dom/index.js"),
    nm("lucide-react/dist/esm/lucide-react.js"),
  ],
  [src("components/layout/sidebar.tsx")]: [src("components/ui/button.tsx"), nm("react/index.js")],
  [src("components/ui/button.tsx")]: [nm("tailwind-merge/index.js")],
  [route("_authed/$workspaceSlug/chat.tsx")]: [src("features/chat/chat.tsx")],
};

describe("chunk groups", () => {
  const groups = chunkGroups(graph(app));

  it("groups layout-only modules into workspace, leaving the entry's modules alone", () => {
    expect(groups.get(route("_authed/$workspaceSlug.tsx"))).toBe("workspace");
    expect(groups.get(src("components/layout/sidebar.tsx"))).toBe("workspace");
    expect(groups.has(nm("react/index.js"))).toBe(false);
    expect(groups.has(src("main.tsx"))).toBe(false);
  });

  it("keeps what sign-in and shared-link pages need out of the workspace chunk", () => {
    expect(groups.get(src("components/ui/button.tsx"))).toBe("common");
    expect(groups.get(nm("tailwind-merge/index.js"))).toBe("common");
    expect(groups.get(nm("@floating-ui/dom/index.js"))).toBe("share-common");
  });

  it("puts every icon in one chunk and leaves other pages to Rollup", () => {
    expect(groups.get(nm("lucide-react/dist/esm/icons/x.js"))).toBe("icons");
    expect(groups.get(nm("lucide-react/dist/esm/lucide-react.js"))).toBe("icons");
    for (const id of [route("login.tsx"), route("share.$token.tsx"), src("features/chat/chat.tsx")])
      expect(groups.has(id), id).toBe(false);
  });

  it("leaves no dependency of a grouped module for Rollup to place elsewhere", () => {
    const entry = new Set<string>();
    const stack = ["/app/packages/frontend/index.html"];
    while (stack.length) {
      const id = stack.pop()!;
      if (entry.has(id)) continue;
      entry.add(id);
      stack.push(...(app[id] ?? []));
    }
    for (const id of groups.keys()) {
      for (const dep of app[id] ?? []) {
        expect(groups.has(dep) || entry.has(dep), `${id} -> ${dep}`).toBe(true);
      }
    }
  });

  it("groups only icons when route code splitting is off", () => {
    const unsplit = Object.fromEntries(
      Object.entries(app).filter(([id]) => !id.includes("tsr-split")),
    );
    expect(new Set(chunkGroups(graph(unsplit)).values())).toEqual(new Set(["icons"]));
  });
});
