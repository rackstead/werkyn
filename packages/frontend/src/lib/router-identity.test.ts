import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { WorkspaceMembership } from "@/stores/auth-store";

// The application's router and route guards. Route contexts (such as the
// workspace membership) are computed by the guards for the identity signed in
// when they ran; an identity change must run them again.

vi.hoisted(() => {
  // jsdom has no matchMedia; the theme store reads it at import.
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
});
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
  Toaster: () => null,
}));

const { router } = await import("./router");
const { useAuthStore } = await import("@/stores/auth-store");

function membership(role: WorkspaceMembership["role"]): WorkspaceMembership {
  return {
    id: `m-${role}`,
    workspaceId: "ws-acme",
    role,
    workspace: { id: "ws-acme", name: "Acme", slug: "acme", logoUrl: null },
  };
}

function account(id: string) {
  return {
    id,
    email: `${id}@example.test`,
    displayName: id,
    avatarUrl: null,
    jobTitle: null,
    phone: null,
    timezone: null,
    emailVerified: true,
  };
}

function signIn(id: string, role: WorkspaceMembership["role"]) {
  useAuthStore.setState({
    user: account(id),
    accessToken: `${id}-token`,
    workspaces: [membership(role)],
  });
}

/** Waits for every load, including redirects, to finish. */
async function settled() {
  for (let round = 0; round < 10; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    while (router.latestLoadPromise) await router.latestLoadPromise;
  }
}

function workspaceContext() {
  const match = router.state.matches.find(
    (m) => m.routeId === "/_authed/$workspaceSlug",
  );
  return match?.context as { membership?: WorkspaceMembership } | undefined;
}

beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
});

afterEach(() => {
  useAuthStore.setState({ user: null, accessToken: null, workspaces: [] });
});

it("re-runs route guards when the account changes", async () => {
  signIn("alice", "ADMIN");
  await router.navigate({ to: "/$workspaceSlug/admin", params: { workspaceSlug: "acme" } });
  await settled();
  expect(router.state.location.pathname).toBe("/acme/admin");
  expect(workspaceContext()?.membership?.role).toBe("ADMIN");

  // Bob, a member of the same workspace but not an administrator, signs in
  // through another tab: Alice's admin page and context must not remain.
  signIn("bob", "MEMBER");
  await settled();
  expect(router.state.location.pathname).toBe("/acme");
  expect(workspaceContext()?.membership?.role).toBe("MEMBER");

  // Signing out leaves the authenticated routes.
  useAuthStore.setState({ user: null, accessToken: null, workspaces: [] });
  await settled();
  expect(router.state.location.pathname).toBe("/login");
});
