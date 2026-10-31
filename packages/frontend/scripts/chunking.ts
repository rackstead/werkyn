// Chunk grouping for the production build.
//
// With route code splitting, Rollup gives every distinct set of importers its
// own shared chunk, so the workspace layout alone arrived as dozens of small
// files (single icons, UI primitives, API hooks). Every workspace page loads
// all of them anyway, so they are grouped: no page downloads more than a few
// kB extra, but far fewer requests are made (which matters on HTTP/1.1 and
// against the server's per-client request limit).
//
// Each module the workspace layout depends on is placed explicitly, by who
// else needs it:
//
// - `icons`: every icon (a few hundred bytes each), wherever it is used;
// - modules the entry needs stay in the entry chunk (not grouped);
// - `common`: also needed by a sign-in page (login, registration, password
//   reset, invitations), so those pages never load the workspace chunk;
// - `share-common`: also needed by a shared-link page;
// - `workspace`: needed only once signed in.
//
// The build sets `onlyExplicitManualChunks`, so Rollup does not pull other
// dependencies into these chunks. Because every dependency of a grouped module
// is itself grouped or part of the entry, none is left for Rollup to place
// inside a lazy chunk (which would make the group import that chunk).
import type { Rollup } from "vite";

type ModuleGraph = Pick<Rollup.ManualChunkMeta, "getModuleIds" | "getModuleInfo">;

// Route files whose components every signed-in workspace page renders.
const WORKSPACE_LAYOUT_ROUTES = ["_authed.tsx", "_authed/$workspaceSlug.tsx"];
// Public pages anyone with a link can open, which load the wiki editor.
const SHARED_LINK_ROUTES = ["share.$token.tsx", "share.files.$token.tsx"];

const ROUTES_DIR = "/src/routes/";
const isSplitRoute = (id: string) => id.includes(ROUTES_DIR) && id.includes("tsr-split");
const routeFile = (id: string) =>
  id.slice(id.indexOf(ROUTES_DIR) + ROUTES_DIR.length).split("?")[0];
const isIcon = (id: string) => id.includes("/node_modules/lucide-react/");

/** Modules statically reachable from `roots`. */
function staticClosure(graph: ModuleGraph, roots: string[]) {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(graph.getModuleInfo(id)?.importedIds ?? []));
  }
  return seen;
}

/** The chunk each grouped module goes to. */
export function chunkGroups(graph: ModuleGraph): Map<string, string> {
  const ids = [...graph.getModuleIds()];
  const groups = new Map<string, string>();
  for (const id of ids) if (isIcon(id)) groups.set(id, "icons");

  const routes = ids.filter(isSplitRoute);
  const layoutRoutes = routes.filter((id) => WORKSPACE_LAYOUT_ROUTES.includes(routeFile(id)));
  if (layoutRoutes.length === 0) return groups; // route code splitting is off
  const publicRoutes = routes.filter((id) => !routeFile(id).startsWith("_authed"));
  const sharedLinkRoutes = publicRoutes.filter((id) => SHARED_LINK_ROUTES.includes(routeFile(id)));
  const signInRoutes = publicRoutes.filter((id) => !SHARED_LINK_ROUTES.includes(routeFile(id)));

  const entry = staticClosure(graph, ids.filter((id) => graph.getModuleInfo(id)?.isEntry));
  const signIn = staticClosure(graph, signInRoutes);
  const sharedLink = staticClosure(graph, sharedLinkRoutes);
  for (const id of staticClosure(graph, layoutRoutes)) {
    if (groups.has(id) || entry.has(id)) continue;
    groups.set(id, signIn.has(id) ? "common" : sharedLink.has(id) ? "share-common" : "workspace");
  }
  return groups;
}

/** `build.rollupOptions.output.manualChunks`, used with `onlyExplicitManualChunks`. */
export function manualChunks(): Rollup.GetManualChunk {
  // Computed once per build (each build has its own module graph).
  let graph: ModuleGraph["getModuleInfo"] | undefined;
  let groups = new Map<string, string>();
  return (id, meta) => {
    if (graph !== meta.getModuleInfo) {
      graph = meta.getModuleInfo;
      groups = chunkGroups(meta);
    }
    return groups.get(id);
  };
}
