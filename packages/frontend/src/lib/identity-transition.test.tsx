import { useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "@/test/fake-websocket";

// Real auth store, identity boundary, ky client, React Query client, feature
// hooks, realtime provider and per-user storage. Only the network (fetch and
// WebSocket) is replaced: the test plays the server, holding back the
// previous account's responses so they arrive after the account changed.

const { toast } = vi.hoisted(() => {
  vi.stubEnv("VITE_API_BASE_URL", "http://localhost/api");
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  });
  return { toast };
});
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

import { useAuthStore, whenLoggedOut, type WorkspaceMembership } from "@/stores/auth-store";
import { queryClient } from "@/lib/query-client";
import { IdentityChangedError } from "@/lib/api-error";
import { identityGeneration } from "@/lib/identity";
import { IdentityBoundary } from "@/components/providers/identity-boundary";
import { RealtimeProvider } from "@/components/providers/realtime-provider";
import { useProfile } from "@/features/settings/api";
import { useNotifications } from "@/features/notifications/api";
import { useFiles } from "@/features/drive/api";
import { useSubtasks, useToggleSubtask } from "@/features/subtasks/api";
import { useRecentFiles } from "@/features/drive/hooks/use-recent-files";
import { useFileUpload } from "@/features/drive/hooks/use-file-upload";
import { useBulkTrashFiles } from "@/features/drive/api";
import { api } from "@/lib/api-client";

// ─── Accounts ───────────────────────────────────────────

const acme: WorkspaceMembership = {
  id: "m-acme",
  workspaceId: "ws-acme",
  role: "MEMBER",
  workspace: { id: "ws-acme", name: "Acme", slug: "acme", logoUrl: null },
};

function account(name: "Alice" | "Bob") {
  const id = name.toLowerCase();
  return {
    id,
    email: `${id}@example.test`,
    displayName: name,
    avatarUrl: null,
    jobTitle: null,
    phone: null,
    timezone: null,
    emailVerified: true,
  };
}
const alice = account("Alice");
const bob = account("Bob");
const TOKENS: Record<string, typeof alice> = {
  "alice-token": alice,
  "alice-token-2": alice,
  "bob-token": bob,
};

// ─── Server ─────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  token: string | null;
}
type Handler = (call: Call) => Response | Promise<Response>;

const handlers = new Map<string, Handler>();
const calls: Call[] = [];
const signals: (AbortSignal | null)[] = [];
const inits: (RequestInit | undefined)[] = [];

function json(status: number, body: unknown) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function on(method: string, path: string, handler: Handler) {
  handlers.set(`${method} ${path}`, handler);
}

/** Answers by signed-in account; 401 without a known token. */
function perAccount(reply: (user: typeof alice) => Response | Promise<Response>): Handler {
  return ({ token }) => {
    const user = token ? TOKENS[token] : undefined;
    return user ? reply(user) : json(401, { statusCode: 401, message: "Expired" });
  };
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(request.url);
  const call = {
    method: request.method,
    path: url.pathname.replace(/^\/api\//, ""),
    token: request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? null,
  };
  calls.push(call);
  signals.push(init?.signal ?? request.signal);
  inits.push(init);
  const handler =
    handlers.get(`${call.method} ${call.path}`) ?? handlers.get(`${call.method} *`);
  if (!handler) return json(404, { statusCode: 404, message: "Not found" });
  return handler(call);
});

function serveDefaults() {
  on("GET", "users/me", perAccount((user) => json(200, { data: user })));
  on(
    "GET",
    "notifications",
    perAccount((user) =>
      json(200, {
        data: [{ id: `n-${user.id}`, title: `${user.displayName}: performance review`, read: false }],
      }),
    ),
  );
  on(
    "GET",
    "workspaces/ws-acme/files",
    perAccount((user) =>
      json(200, {
        // Private files in the shared workspace are visible to their owner only.
        data: [{ id: `f-${user.id}`, name: `${user.displayName} salary.pdf` }],
      }),
    ),
  );
  on(
    "GET",
    "tasks/task-1/subtasks",
    perAccount((user) =>
      json(200, {
        data: [{ id: "sub-1", title: `${user.displayName}'s checklist`, completed: false }],
      }),
    ),
  );
  on("POST", "auth/logout", () => json(204, null));
}

// ─── Screen ─────────────────────────────────────────────

function Workspace() {
  const profile = useProfile();
  const notifications = useNotifications();
  const files = useFiles("ws-acme");
  const subtasks = useSubtasks("task-1");
  const toggle = useToggleSubtask("task-1", "project-1");
  const { recents, addRecent } = useRecentFiles("ws-acme");
  const [draft, setDraft] = useState("");
  const fileList = files.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <main>
      <p>Signed in as {profile.data?.displayName}</p>
      <ul aria-label="Notifications">
        {notifications.data?.pages
          .flatMap((page) => page.data)
          .map((n) => <li key={n.id}>{n.title}</li>)}
      </ul>
      <ul aria-label="Files">
        {fileList.map((file) => (
          <li key={file.id}>
            <button
              onClick={() =>
                addRecent({
                  ...file,
                  mimeType: null,
                  isFolder: false,
                  size: null,
                  uploadedById: "x",
                  uploadedBy: { id: "x", displayName: file.name, avatarUrl: null },
                  updatedAt: "2026-10-29T00:00:00Z",
                })
              }
            >
              open {file.name}
            </button>
          </li>
        ))}
      </ul>
      <ul aria-label="Recent">
        {recents.map((recent) => <li key={recent.id}>recent {recent.name}</li>)}
      </ul>
      <ul aria-label="Subtasks">
        {subtasks.data?.data.map((s) => (
          <li key={s.id}>
            {s.title} {s.completed ? "(done)" : "(open)"}
          </li>
        ))}
      </ul>
      <button onClick={() => toggle.mutate("sub-1")}>Toggle</button>
      <input aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
    </main>
  );
}

function App() {
  const signedIn = useAuthStore((s) => !!s.user);
  return (
    <QueryClientProvider client={queryClient}>
      <IdentityBoundary>
        {signedIn ? (
          <RealtimeProvider>
            <Workspace />
          </RealtimeProvider>
        ) : (
          <p>Sign in</p>
        )}
      </IdentityBoundary>
    </QueryClientProvider>
  );
}

/** Lets React Query, React and pending responses settle under fake timers. */
async function settle() {
  for (let round = 0; round < 5; round++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

/** Delivers BroadcastChannel messages, which use real (not faked) tasks. */
async function deliverMessages() {
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
}

function visibleText() {
  return document.body.textContent ?? "";
}

/** Every value cached by React Query, serialized. */
function cachedText() {
  return JSON.stringify(
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
  );
}

function signIn(user: typeof alice, token: string) {
  act(() => useAuthStore.getState().setAuth(user, token, [acme]));
}

let otherTab: BroadcastChannel;
const announced: { type: string; data?: { user?: { id: string } } }[] = [];
let clock = Date.now();

beforeEach(() => {
  // Each case starts well after any refresh a previous case recorded.
  clock += 10 * 60 * 1000;
  vi.useFakeTimers({
    now: clock,
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.reset();
  handlers.clear();
  calls.length = 0;
  signals.length = 0;
  inits.length = 0;
  announced.length = 0;
  serveDefaults();
  localStorage.clear();
  toast.error.mockClear();
  otherTab = new BroadcastChannel("pm-auth");
  otherTab.onmessage = (event) => announced.push(event.data);
});

afterEach(async () => {
  cleanup();
  act(() => {
    useAuthStore.setState({ user: null, accessToken: null, workspaces: [] });
  });
  otherTab.close();
  queryClient.clear();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Alice signs out and Bob signs in, in the same workspace", () => {
  it("shows Bob none of Alice's data, even when her slow requests finish late", async () => {
    signIn(alice, "alice-token");
    // Alice's notifications are slow to load.
    const aliceNotifications = deferred<Response>();
    on("GET", "notifications", ({ token }) =>
      token === "alice-token"
        ? aliceNotifications.promise
        : json(200, { data: [{ id: "n-bob", title: "Bob: welcome", read: false }] }),
    );
    render(<App />);
    await settle();
    expect(screen.getByText("Signed in as Alice")).toBeTruthy();
    expect(screen.getByText("Alice's checklist (open)")).toBeTruthy();
    act(() => FakeWebSocket.latest().accept());
    const aliceSocket = FakeWebSocket.latest();
    expect(aliceSocket.sent[0]).toEqual({ type: "auth", token: "alice-token" });

    // Alice opens her private file (remembered as recent), starts typing,
    // and ticks a subtask; the server is slow to answer the toggle.
    fireEvent.click(screen.getByText("open Alice salary.pdf"));
    fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "Alice's private note" } });
    const aliceToggle = deferred<Response>();
    on("PATCH", "subtasks/sub-1/toggle", () => aliceToggle.promise);
    fireEvent.click(screen.getByText("Toggle"));
    await settle();
    expect(screen.getByText("Alice's checklist (done)")).toBeTruthy();
    expect(screen.getByText("recent Alice salary.pdf")).toBeTruthy();

    // Sign-out; the server never answers it.
    await deliverMessages();
    announced.length = 0;
    const logoutRequest = deferred<Response>();
    on("POST", "auth/logout", () => logoutRequest.promise);
    let loggedOut!: Promise<void>;
    act(() => {
      loggedOut = useAuthStore.getState().logout();
    });

    // Everything held for Alice is gone at once, before the network answers.
    expect(useAuthStore.getState()).toMatchObject({ user: null, accessToken: null, workspaces: [] });
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(aliceSocket.closed).toBe(true);
    expect(announced).toEqual([]); // delivered asynchronously
    await settle();
    expect(visibleText()).not.toContain("Alice");
    expect(announced.map((m) => m.type)).toEqual(["logout"]);

    // Bob signs in in the same workspace.
    signIn(bob, "bob-token");
    await settle();
    act(() => FakeWebSocket.latest().accept());
    const bobSocket = FakeWebSocket.latest();
    expect(bobSocket).not.toBe(aliceSocket);
    expect(bobSocket.sent[0]).toEqual({ type: "auth", token: "bob-token" });
    expect(screen.getByText("Signed in as Bob")).toBeTruthy();
    expect(screen.getByText("Bob: welcome")).toBeTruthy();
    expect(screen.getByText("Bob's checklist (open)")).toBeTruthy();
    expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("");

    // Alice's late answers arrive: her notifications, a failed toggle (whose
    // rollback would restore her list), and the sign-out request failing.
    aliceNotifications.resolve(
      json(200, { data: [{ id: "n-alice", title: "Alice: salary review", read: false }] }),
    );
    aliceToggle.resolve(json(500, { statusCode: 500, message: "Toggle failed" }));
    logoutRequest.reject(new TypeError("Network error"));
    await settle();
    await expect(loggedOut).resolves.toBeUndefined();

    expect(useAuthStore.getState().user?.id).toBe("bob");
    expect(visibleText()).not.toContain("Alice");
    expect(cachedText()).not.toContain("Alice");
    expect(screen.getByText("Bob's checklist (open)")).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
    // Alice's requests after sign-out were never retried with Bob's token.
    expect(calls.filter((c) => c.token === "bob-token").map((c) => c.path)).not.toContain(
      "subtasks/sub-1/toggle",
    );
    // Recents are kept per account: Bob sees none, Alice's are still hers.
    expect(screen.queryByText(/^recent /)).toBeNull();
    expect(localStorage.getItem("drive-recent:alice:ws-acme")).toContain("Alice salary.pdf");
    expect(localStorage.getItem("drive-recent:bob:ws-acme")).toBeNull();
  });

  it("empties queries shown outside the identity boundary", async () => {
    signIn(alice, "alice-token");
    function Profile() {
      return <p>Profile of {useProfile().data?.displayName ?? "nobody"}</p>;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <Profile />
      </QueryClientProvider>,
    );
    await settle();
    expect(screen.getByText("Profile of Alice")).toBeTruthy();
    act(() => void useAuthStore.getState().logout());
    await settle();
    expect(visibleText()).not.toContain("Alice");
  });

  it("drops a mutation's callbacks even when it re-renders after the account changed", async () => {
    signIn(alice, "alice-token");
    const onSuccess = vi.fn();
    const response = deferred<Response>();
    on("POST", "probe", () => response.promise);
    const { useMutation } = await import("@tanstack/react-query");
    function Probe() {
      // Inline options: every render hands the pending mutation new callbacks.
      const mutation = useMutation({
        mutationFn: () => api.post("probe").json(),
        onSuccess: (data) => onSuccess(data),
        onError: (error) => onSuccess(error),
      });
      return <button onClick={() => mutation.mutate()}>Run {String(mutation.isPending)}</button>;
    }
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("Run false"));
    await settle();
    act(() => useAuthStore.getState().setAuth(bob, "bob-token", [acme]));
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
    response.resolve(json(200, { data: "for Alice" }));
    await settle();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("another tab signs out and signs in as someone else", () => {
  it("resets this tab and discards Alice's late responses and stale announcements", async () => {
    signIn(alice, "alice-token");
    const aliceFiles = deferred<Response>();
    on("GET", "workspaces/ws-acme/files", ({ token }) =>
      token === "alice-token"
        ? aliceFiles.promise
        : json(200, { data: [{ id: "f-bob", name: "Bob plan.pdf" }] }),
    );
    render(<App />);
    await settle();
    act(() => FakeWebSocket.latest().accept());
    const aliceSocket = FakeWebSocket.latest();
    fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "Alice's private note" } });
    expect(screen.getByText("Signed in as Alice")).toBeTruthy();
    const generation = identityGeneration();

    // The other tab is a second copy of the application in this browser.
    vi.resetModules();
    const tab2 = await import("@/stores/auth-store");
    await deliverMessages();
    tab2.useAuthStore.getState().setAuth(alice, "alice-token", [acme]);
    await deliverMessages();
    // Same account: this tab only adopts the token.
    expect(identityGeneration()).toBe(generation);

    await tab2.useAuthStore.getState().logout();
    await deliverMessages();
    await settle();
    expect(useAuthStore.getState().user).toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(aliceSocket.closed).toBe(true);
    expect(visibleText()).not.toContain("Alice");

    tab2.useAuthStore.getState().setAuth(bob, "bob-token", [acme]);
    await deliverMessages();
    await settle();
    act(() => FakeWebSocket.latest().accept());
    expect(useAuthStore.getState()).toMatchObject({ user: bob, accessToken: "bob-token" });
    expect(FakeWebSocket.latest().sent[0]).toEqual({ type: "auth", token: "bob-token" });
    expect(screen.getByText("Bob plan.pdf", { exact: false })).toBeTruthy();
    expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("");

    // Alice's slow file list finally arrives.
    aliceFiles.resolve(json(200, { data: [{ id: "f-alice", name: "Alice salary.pdf" }] }));
    // A third tab announces a refresh it completed before the sign-out.
    otherTab.postMessage({
      type: "refresh",
      epoch: { at: 1, tab: "third" },
      data: { user: alice, accessToken: "alice-token-2", workspaces: [acme] },
    });
    await deliverMessages();
    await settle();
    expect(useAuthStore.getState()).toMatchObject({ user: bob, accessToken: "bob-token" });
    expect(visibleText()).not.toContain("Alice");
    expect(cachedText()).not.toContain("Alice");
  });
});

describe("a refresh racing a sign-out", () => {
  it("cannot restore Alice after she signed out and Bob signed in", async () => {
    signIn(alice, "alice-token");
    const refresh = deferred<Response>();
    on("POST", "auth/refresh", () => refresh.promise);
    // Alice's token has expired: her request is answered 401 and refreshed.
    on("GET", "users/me", ({ token }) =>
      token === "bob-token" ? json(200, { data: bob }) : json(401, { statusCode: 401, message: "Expired" }),
    );
    const request = api.get("users/me").json();
    const rejected = expect(request).rejects.toBeInstanceOf(IdentityChangedError);
    await settle();
    expect(calls.map((c) => c.path)).toEqual(["users/me", "auth/refresh"]);

    act(() => void useAuthStore.getState().logout());
    signIn(bob, "bob-token");
    await deliverMessages();
    announced.length = 0;

    // The refresh sent for Alice finally answers with a new Alice session.
    refresh.resolve(
      json(200, { data: { user: alice, accessToken: "alice-token-2", workspaces: [acme] } }),
    );
    await rejected;
    await settle();
    await deliverMessages();

    expect(useAuthStore.getState()).toMatchObject({ user: bob, accessToken: "bob-token" });
    expect(announced).toEqual([]);
    // Alice's request was not replayed, with any token.
    expect(calls.filter((c) => c.path === "users/me").map((c) => c.token)).toEqual(["alice-token"]);
  });

  it("a failed refresh for Alice does not sign out Bob", async () => {
    signIn(alice, "alice-token");
    const refresh = deferred<Response>();
    on("POST", "auth/refresh", () => refresh.promise);
    on("GET", "users/me", () => json(401, { statusCode: 401, message: "Expired" }));
    const request = api.get("users/me").json();
    const rejected = expect(request).rejects.toBeInstanceOf(IdentityChangedError);
    await settle();

    act(() => void useAuthStore.getState().logout());
    signIn(bob, "bob-token");
    refresh.resolve(json(401, { statusCode: 401, message: "Revoked" }));
    await rejected;
    await settle();
    expect(useAuthStore.getState()).toMatchObject({ user: bob, accessToken: "bob-token" });
  });

  it("a page loading during another tab's sign-out stays signed out", async () => {
    const refresh = deferred<Response>();
    on("POST", "auth/refresh", () => refresh.promise);
    let hydrated = false;
    void useAuthStore
      .getState()
      .hydrate()
      .then(() => (hydrated = true));
    await settle();

    // Another tab signs Alice out while this tab's refresh is in flight.
    otherTab.postMessage({ type: "logout", epoch: { at: Date.now(), tab: "other" } });
    await deliverMessages();
    refresh.resolve(
      json(200, { data: { user: alice, accessToken: "alice-token-2", workspaces: [acme] } }),
    );
    on("POST", "auth/refresh", () => json(401, { statusCode: 401, message: "Revoked" }));
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(hydrated).toBe(true);
    expect(useAuthStore.getState().user).toBeNull();
    expect(announced.filter((m) => m.type === "refresh")).toEqual([]);
  });
});

describe("sign-out", () => {
  it("clears local state immediately and gives up on a hung server after a bound", async () => {
    signIn(alice, "alice-token");
    on("POST", "auth/logout", () => new Promise<Response>(() => {}));
    let settled = false;
    act(() => {
      void useAuthStore
        .getState()
        .logout()
        .then(() => (settled = true));
    });
    expect(useAuthStore.getState().user).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999);
    });
    expect(settled).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(settled).toBe(true);
    await expect(whenLoggedOut()).resolves.toBeUndefined();
  });

  it("revokes the session with a renewed token when the access token has expired", async () => {
    signIn(alice, "alice-token");
    const logouts: (string | null)[] = [];
    on("POST", "auth/logout", ({ token }) => {
      logouts.push(token);
      return token === "alice-token-2" ? json(204, null) : json(401, { statusCode: 401 });
    });
    on("POST", "auth/refresh", () =>
      json(200, { data: { user: alice, accessToken: "alice-token-2", workspaces: [acme] } }),
    );
    await act(async () => {
      await useAuthStore.getState().logout();
    });
    expect(logouts).toEqual(["alice-token", "alice-token-2"]);
    // The renewed token was used only to sign out, never applied here.
    expect(useAuthStore.getState()).toMatchObject({ user: null, accessToken: null });
  });

  it("does not revoke a session the cookie now holds for another account", async () => {
    signIn(alice, "alice-token");
    const logouts: (string | null)[] = [];
    on("POST", "auth/logout", ({ token }) => {
      logouts.push(token);
      return json(401, { statusCode: 401 });
    });
    on("POST", "auth/refresh", () =>
      json(200, { data: { user: bob, accessToken: "bob-token", workspaces: [acme] } }),
    );
    await act(async () => {
      await useAuthStore.getState().logout();
    });
    expect(logouts).toEqual(["alice-token"]);
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("a sign-in waits for the previous sign-out's revocation", async () => {
    signIn(alice, "alice-token");
    const logoutRequest = deferred<Response>();
    on("POST", "auth/logout", () => logoutRequest.promise);
    act(() => void useAuthStore.getState().logout());
    let ready = false;
    void whenLoggedOut().then(() => (ready = true));
    await settle();
    expect(ready).toBe(false);
    logoutRequest.resolve(json(204, null));
    await settle();
    expect(ready).toBe(true);
  });
});

// ─── Review follow-ups ──────────────────────────────────

describe("review follow-ups", () => {
  it("retries a refresh another tab superseded while signing out with an expired token", async () => {
    signIn(alice, "alice-token");
    const logouts: (string | null)[] = [];
    on("POST", "auth/logout", ({ token }) => {
      logouts.push(token);
      return token === "alice-token-2" ? json(204, null) : json(401, { statusCode: 401 });
    });
    let refreshes = 0;
    on("POST", "auth/refresh", () =>
      ++refreshes === 1
        ? json(409, { statusCode: 409 })
        : json(200, { data: { user: alice, accessToken: "alice-token-2", workspaces: [acme] } }),
    );
    let done = false;
    act(() => {
      void useAuthStore
        .getState()
        .logout()
        .then(() => (done = true));
    });
    await settle();
    expect(done).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    await settle();
    expect(done).toBe(true);
    expect(refreshes).toBe(2);
    expect(logouts).toEqual(["alice-token", "alice-token-2"]);
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("an announcement from an earlier build cannot sign an account back in", async () => {
    signIn(alice, "alice-token");
    // An earlier build's tab renews this account's token: adopted.
    otherTab.postMessage({
      type: "refresh",
      data: { user: alice, accessToken: "alice-token-2", workspaces: [acme] },
    });
    await deliverMessages();
    expect(useAuthStore.getState().accessToken).toBe("alice-token-2");

    act(() => void useAuthStore.getState().logout());
    // Its refresh from before the sign-out arrives afterwards: ignored.
    otherTab.postMessage({
      type: "refresh",
      data: { user: alice, accessToken: "alice-token-3", workspaces: [acme] },
    });
    // Nor can it switch this tab to another account.
    signIn(bob, "bob-token");
    otherTab.postMessage({
      type: "refresh",
      data: { user: alice, accessToken: "alice-token-3", workspaces: [acme] },
    });
    await deliverMessages();
    expect(useAuthStore.getState()).toMatchObject({ user: bob, accessToken: "bob-token" });
  });

  it("a sign-out aborts the refresh it overtakes", async () => {
    signIn(alice, "alice-token");
    on("POST", "auth/refresh", () => new Promise<Response>(() => {}));
    let result: boolean | undefined;
    void useAuthStore
      .getState()
      .refresh()
      .then((value) => (result = value));
    await settle();
    const refreshSignal = signals[calls.findIndex((c) => c.path === "auth/refresh")];
    expect(refreshSignal?.aborted).toBe(false);
    act(() => void useAuthStore.getState().logout());
    expect(refreshSignal?.aborted).toBe(true);
    await settle();
    expect(result).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("a sign-in waits for cookie-setting requests still running in another tab", async () => {
    localStorage.setItem("pm-auth-busy:other-tab", String(Date.now() + 3000));
    let ready = false;
    void whenLoggedOut().then(() => (ready = true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(ready).toBe(false);
    // The other tab's request finishes and it removes its marker.
    localStorage.removeItem("pm-auth-busy:other-tab");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(ready).toBe(true);

    // A marker left by a closed tab only holds sign-in until its deadline.
    localStorage.setItem("pm-auth-busy:closed-tab", String(Date.now() + 2000));
    ready = false;
    void whenLoggedOut().then(() => (ready = true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(ready).toBe(true);
    expect(localStorage.getItem("pm-auth-busy:closed-tab")).toBeNull();
  });

  it("a sign-out stops before touching a session another tab signed in meanwhile", async () => {
    signIn(alice, "alice-token");
    const firstLogout = deferred<Response>();
    on("POST", "auth/logout", () => firstLogout.promise);
    on("POST", "auth/refresh", () =>
      json(200, { data: { user: alice, accessToken: "alice-token-2", workspaces: [acme] } }),
    );
    let done = false;
    act(() => {
      void useAuthStore
        .getState()
        .logout()
        .then(() => (done = true));
    });
    // Another tab signs the same account in again while this sign-out runs.
    otherTab.postMessage({
      type: "refresh",
      epoch: { at: Date.now() + 1000, tab: "other" },
      data: { user: alice, accessToken: "alice-new-session", workspaces: [acme] },
    });
    await deliverMessages();
    firstLogout.resolve(json(401, { statusCode: 401 }));
    await settle();
    expect(done).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(["auth/logout"]);
    expect(useAuthStore.getState().accessToken).toBe("alice-new-session");
  });

  it("callbacks passed to mutate() do not run after the account changed", async () => {
    signIn(alice, "alice-token");
    const response = deferred<Response>();
    on("POST", "mark-read", () => response.promise);
    const callbacks = vi.fn();
    const { useMutation } = await import("@tanstack/react-query");
    function MarkRead() {
      const mutation = useMutation({ mutationFn: () => api.post("mark-read").json() });
      return (
        <button
          onClick={() =>
            mutation.mutate(undefined, {
              onSuccess: () => callbacks("success"),
              onError: () => callbacks("error"),
              onSettled: () => callbacks("settled"),
            })
          }
        >
          Mark read {mutation.status}
        </button>
      );
    }
    // Mounted outside any identity boundary, so it stays mounted throughout.
    render(
      <QueryClientProvider client={queryClient}>
        <MarkRead />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText("Mark read idle"));
    await settle();
    expect(screen.getByText("Mark read pending")).toBeTruthy();
    signIn(bob, "bob-token");
    await settle();
    expect(screen.getByText("Mark read idle")).toBeTruthy();
    response.resolve(json(200, { ok: true }));
    await settle();
    expect(callbacks).not.toHaveBeenCalled();
    expect(screen.getByText("Mark read idle")).toBeTruthy();
  });

  it("binds requests to the identity where AbortSignal.any is missing", async () => {
    const original = AbortSignal.any;
    Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true });
    try {
      signIn(alice, "alice-token");
      on("GET", "users/me", perAccount((user) => json(200, { data: user })));
      await expect(api.get("users/me").json()).resolves.toEqual({ data: alice });
      const pending = deferred<Response>();
      on("GET", "users/me", () => pending.promise);
      const request = api.get("users/me").json();
      const rejected = expect(request).rejects.toBeInstanceOf(IdentityChangedError);
      await settle();
      const signal = signals.at(-1);
      signIn(bob, "bob-token");
      await rejected;
      expect(signal?.aborted).toBe(true);
    } finally {
      Object.defineProperty(AbortSignal, "any", { value: original, configurable: true });
    }
  });
});

// ─── Independent review, round 2 ────────────────────────

describe("independent review follow-ups", () => {
  const session = (user: typeof alice, accessToken: string) =>
    json(200, { data: { user, accessToken, workspaces: [acme] } });

  it("R1: a loading tab does not retry its way back into a session another tab signed out", async () => {
    const first = deferred<Response>();
    let refreshes = 0;
    // The other tab's revocation has not reached the server: the cookie still works.
    on("POST", "auth/refresh", () => (++refreshes === 1 ? first.promise : session(alice, "alice-token-2")));
    let hydrated = false;
    void useAuthStore
      .getState()
      .hydrate()
      .then(() => (hydrated = true));
    await settle();
    otherTab.postMessage({ type: "logout", epoch: { at: Date.now(), tab: "other" } });
    await deliverMessages();
    first.resolve(session(alice, "alice-token-2"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await deliverMessages();
    expect(hydrated).toBe(true);
    expect(refreshes).toBe(1);
    expect(useAuthStore.getState().user).toBeNull();
    expect(announced.filter((m) => m.type === "refresh")).toEqual([]);
  });

  it("R1: a page opened during another tab's revocation waits for it before refreshing", async () => {
    // Another tab is revoking the session (its sign-out was announced before
    // this page existed, so this page never received it).
    localStorage.setItem("pm-auth-busy:other", String(Date.now() + 5000));
    let revoked = false;
    let refreshes = 0;
    on("POST", "auth/refresh", () => {
      refreshes++;
      return revoked ? json(401, { statusCode: 401 }) : session(alice, "alice-token-2");
    });
    void useAuthStore.getState().hydrate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(refreshes).toBe(0);
    revoked = true;
    localStorage.removeItem("pm-auth-busy:other");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(refreshes).toBeGreaterThan(0);
    expect(useAuthStore.getState().user).toBeNull();
    expect(announced.filter((m) => m.type === "refresh")).toEqual([]);
  });

  it("R1: the tab that signed out stays signed out while another tab is loading", async () => {
    signIn(alice, "alice-token");
    vi.resetModules();
    const tab2 = await import("@/stores/auth-store");
    const tab2First = deferred<Response>();
    let refreshes = 0;
    on("POST", "auth/refresh", () => (++refreshes === 1 ? tab2First.promise : session(alice, "alice-token-2")));
    // Tab A's revocation is slow: logout is answered only much later.
    const revocation = deferred<Response>();
    on("POST", "auth/logout", () => revocation.promise);
    void tab2.useAuthStore.getState().hydrate();
    await settle();
    act(() => void useAuthStore.getState().logout());
    await deliverMessages();
    tab2First.resolve(session(alice, "alice-token-2"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    await deliverMessages();
    expect(useAuthStore.getState().user).toBeNull();
    expect(tab2.useAuthStore.getState().user).toBeNull();
    expect(refreshes).toBe(1);
    revocation.resolve(json(204, null));
    await settle();
  });

  it("M4: queued uploads stop when another account signs in", async () => {
    const sent: { name: string; token: string | null }[] = [];
    const pending: { respond: () => void }[] = [];
    class FakeXhr {
      status = 0;
      responseText = "";
      withCredentials = false;
      upload: { onprogress: unknown } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      private headers: Record<string, string> = {};
      open() {}
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
      }
      send(form: FormData) {
        const name = (form.get("file") as File).name;
        sent.push({ name, token: this.headers.Authorization?.replace(/^Bearer /, "") ?? null });
        pending.push({
          respond: () => {
            this.status = 201;
            this.responseText = JSON.stringify({ data: { id: name, name } });
            this.onload?.();
          },
        });
      }
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    signIn(alice, "alice-token");
    const { result } = renderHook(() => useFileUpload({ workspaceId: "ws-acme" }), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
    const files = Array.from({ length: 6 }, (_, i) => new File(["x"], `alice-${i}.txt`));
    act(() => result.current.handleUpload(files));
    await settle();
    expect(sent.map((s) => s.token)).toEqual(["alice-token", "alice-token", "alice-token"]);
    // Bob signs in directly (for example in another tab) while three are sent.
    signIn(bob, "bob-token");
    for (const upload of pending.splice(0)) upload.respond();
    await settle();
    expect(sent.filter((s) => s.token !== "alice-token")).toEqual([]);
    expect(sent).toHaveLength(3);
  });

  it("M1: a bulk trash stops when another account signs in", async () => {
    signIn(alice, "alice-token");
    const held: (() => void)[] = [];
    on("PATCH", "*", () => new Promise<Response>((resolve) => held.push(() => resolve(json(200, { data: {} })))));
    const { result } = renderHook(() => useBulkTrashFiles("ws-acme"), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
    const fileIds = Array.from({ length: 12 }, (_, i) => `file-${i}`);
    let failure: unknown;
    act(() => {
      void result.current.mutateAsync(fileIds).catch((error) => (failure = error));
    });
    await settle();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(4);
    signIn(bob, "bob-token");
    for (const release of held.splice(0)) release();
    await settle();
    const tokens = calls.filter((c) => c.method === "PATCH").map((c) => c.token);
    expect(tokens).toEqual(["alice-token", "alice-token", "alice-token", "alice-token"]);
    // Abandoned as a whole, so no per-file result is reported to Bob.
    expect(failure).toBeInstanceOf(IdentityChangedError);
  });

  it("L1: the revocation survives the page being closed", async () => {
    signIn(alice, "alice-token");
    await act(async () => {
      await useAuthStore.getState().logout();
    });
    const logout = calls.findIndex((c) => c.path === "auth/logout");
    expect(inits[logout]?.keepalive).toBe(true);
  });
});

describe("Qodo second pass", () => {
  it("a request replayed after a refresh is never sent as the next account", async () => {
    // Switch accounts at every microtask offset after the refresh resolves,
    // including the gap between the post-refresh check and the replay.
    for (let offset = 0; offset < 12; offset++) {
      act(() =>
        useAuthStore.setState({ user: alice, accessToken: "alice-token", workspaces: [acme] }),
      );
      calls.length = 0;
      on("GET", "users/me", ({ token }) =>
        token === "alice-token" ? json(401, { statusCode: 401 }) : json(200, { data: bob }),
      );
      const refresh = vi.fn(async () => {
        let hops = offset;
        const later = (): void => {
          if (hops-- > 0) queueMicrotask(later);
          else useAuthStore.setState({ user: bob, accessToken: "bob-token" });
        };
        queueMicrotask(later);
        return true;
      });
      useAuthStore.setState({ refresh });
      await api
        .get("users/me")
        .json()
        .catch(() => {});
      await settle();
      expect(
        calls.filter((c) => c.path === "users/me" && c.token === "bob-token"),
        `offset ${offset}`,
      ).toEqual([]);
      act(() => useAuthStore.setState({ user: null, accessToken: null, workspaces: [] }));
    }
  });
});
