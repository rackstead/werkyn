import { createRouter } from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import { onIdentityChange } from "@/lib/identity";
import { LoadingSpinner } from "@/components/shared/lazy-load";

// Route components are split into their own chunks (autoCodeSplitting in
// vite.config.ts). Hovering or focusing a link fetches the target's chunk, and
// a navigation still waiting for one after a second shows the spinner.
export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPendingComponent: LoadingSpinner,
});

// Route guards and contexts (such as the workspace membership) were computed
// for the previous identity. Drop cached and preloaded matches and run every
// guard again; the routed UI waits for this when an account is left.
onIdentityChange(() => {
  router.clearCache();
  // Before the first load (during hydration) there is nothing to re-run yet.
  if (!router.state.matches.length) return;
  return router.invalidate().catch((error: unknown) => {
    console.error("Route reload after identity change failed", error);
  });
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
