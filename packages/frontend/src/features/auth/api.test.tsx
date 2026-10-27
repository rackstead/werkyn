import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAuthStore, type WorkspaceMembership } from "@/stores/auth-store";
import { useVerifyEmail } from "./api";

const { broadcast } = vi.hoisted(() => {
  vi.stubEnv("VITE_API_BASE_URL", "http://localhost/api");
  const broadcast = vi.fn();
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      addEventListener() {}
      postMessage = broadcast;
    },
  );
  return { broadcast };
});

// Keep the real hook, QueryClient, ky transport and Zustand store. Importing the
// application router would load every route; verification does not use it.
vi.mock("@/lib/router", () => ({ router: { invalidate: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

type User = NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>;

function user(id: string): User {
  return {
    id,
    email: `${id}@example.test`,
    displayName: `${id} current profile`,
    avatarUrl: null,
    jobTitle: null,
    phone: null,
    timezone: null,
    emailVerified: false,
  };
}

function workspaces(id: string): WorkspaceMembership[] {
  return [
    {
      id: `${id}-membership`,
      workspaceId: `${id}-workspace`,
      role: "MEMBER",
      workspace: {
        id: `${id}-workspace`,
        name: `${id} workspace`,
        slug: id,
        logoUrl: null,
      },
    },
  ];
}

let client: QueryClient;
let respond: (value: Response) => void;
let fetchRequest: ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  broadcast.mockClear();
  client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  fetchRequest = vi.fn((request: Request | string) => {
    if (request === "/api/auth/logout") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    expect(request).toBeInstanceOf(Request);
    expect((request as Request).url).toBe(
      "http://localhost/api/auth/verify-email/verification-token",
    );
    expect((request as Request).method).toBe("POST");
    return new Promise<Response>((resolve) => {
      respond = resolve;
    });
  });
  vi.stubGlobal("fetch", fetchRequest);
});

afterEach(() => {
  cleanup();
  client.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function beginVerification() {
  const { result } = renderHook(() => useVerifyEmail(), { wrapper });
  let completion!: ReturnType<typeof result.current.mutateAsync>;
  act(() => {
    completion = result.current.mutateAsync({ token: "verification-token" });
  });
  await waitFor(() => expect(fetchRequest).toHaveBeenCalledTimes(1));
  return async (verifiedUser: User) => {
    await act(async () => {
      respond(
        new Response(JSON.stringify({ data: { user: verifiedUser } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await completion;
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  };
}

it("does not verify another account already signed in when a token is redeemed", async () => {
  useAuthStore
    .getState()
    .setAuth(user("account-b"), "token-b", workspaces("b"));
  const finish = await beginVerification();
  const before = useAuthStore.getState();
  broadcast.mockClear();

  await finish({ ...user("account-a"), emailVerified: true });

  expect(useAuthStore.getState()).toBe(before);
  expect(broadcast).not.toHaveBeenCalled();
});

it("does not verify the replacement account after a genuine deferred account switch", async () => {
  useAuthStore
    .getState()
    .setAuth(user("account-a"), "token-a", workspaces("a"));
  const finish = await beginVerification();
  expect(
    (fetchRequest.mock.calls[0][0] as Request).headers.get("Authorization"),
  ).toBe("Bearer token-a");
  act(() => {
    useAuthStore
      .getState()
      .setAuth(user("account-b"), "token-b", workspaces("b"));
  });
  const replacement = useAuthStore.getState();
  broadcast.mockClear();

  await finish({ ...user("account-a"), emailVerified: true });

  expect(useAuthStore.getState()).toBe(replacement);
  expect(broadcast).not.toHaveBeenCalled();
});

it("does not resurrect a session when logout completes before verification", async () => {
  useAuthStore
    .getState()
    .setAuth(user("account-a"), "token-a", workspaces("a"));
  const finish = await beginVerification();
  await act(async () => {
    await useAuthStore.getState().logout();
  });
  const signedOut = useAuthStore.getState();
  expect(signedOut.user).toBeNull();
  expect(signedOut.accessToken).toBeNull();
  broadcast.mockClear();

  await finish({ ...user("account-a"), emailVerified: true });

  expect(useAuthStore.getState()).toBe(signedOut);
  expect(broadcast).not.toHaveBeenCalled();
});

it("allows signed-out token redemption without creating authentication state", async () => {
  const finish = await beginVerification();
  const signedOut = useAuthStore.getState();

  await finish({ ...user("account-a"), emailVerified: true });

  expect(useAuthStore.getState()).toBe(signedOut);
  expect(broadcast).not.toHaveBeenCalled();
});

it("updates only the matching subject's flag and preserves newer profile and session data", async () => {
  useAuthStore
    .getState()
    .setAuth(user("account-a"), "old-token", workspaces("old"));
  const finish = await beginVerification();
  const currentUser = {
    ...user("account-a"),
    displayName: "Profile edited while verification was pending",
    avatarUrl: "/current-avatar.png",
    jobTitle: "Current title",
    timezone: "America/Los_Angeles",
  };
  act(() => {
    useAuthStore.setState({
      user: currentUser,
      accessToken: "new-token",
      workspaces: workspaces("current"),
      isHydrated: true,
      _refreshPromise: Promise.resolve(true),
    });
  });
  const before = useAuthStore.getState();
  broadcast.mockClear();

  await finish({
    ...user("account-a"),
    displayName: "Older server profile",
    emailVerified: true,
  });

  const after = useAuthStore.getState();
  expect(after.user).toEqual({ ...currentUser, emailVerified: true });
  expect({ ...after, user: before.user }).toEqual(before);
  expect(after.workspaces).toBe(before.workspaces);
  expect(after._refreshPromise).toBe(before._refreshPromise);
  expect(broadcast).not.toHaveBeenCalled();
});

it("does not reauthenticate or broadcast a matching user-only state without a token", async () => {
  useAuthStore.setState({ user: user("account-a"), isHydrated: false });
  const finish = await beginVerification();
  const before = useAuthStore.getState();

  await finish({ ...user("account-a"), emailVerified: true });

  const after = useAuthStore.getState();
  expect(after.user).toEqual({ ...before.user, emailVerified: true });
  expect({ ...after, user: before.user }).toEqual(before);
  expect(after.accessToken).toBeNull();
  expect(broadcast).not.toHaveBeenCalled();
});

it("uses the matching response's verification flag instead of assuming success means true", async () => {
  useAuthStore
    .getState()
    .setAuth(user("account-a"), "token-a", workspaces("a"));
  const finish = await beginVerification();
  broadcast.mockClear();

  await finish(user("account-a"));

  expect(useAuthStore.getState().user?.emailVerified).toBe(false);
  expect(broadcast).not.toHaveBeenCalled();
});
