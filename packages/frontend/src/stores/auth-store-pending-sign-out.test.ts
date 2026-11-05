import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A failed sign-out must not leave a session that a later page load adopts.
// Each "tab" is a fresh copy of the auth store module; tabs share this
// browser's localStorage, BroadcastChannel and one refresh cookie. The test
// plays the server: refresh-token families, the cookie, ordinary logout and
// the cookie-safe conditional recovery endpoint.

vi.hoisted(() => {
  vi.stubEnv("VITE_API_BASE_URL", "http://localhost/api");
});

type Tab = typeof import("./auth-store");

// ─── Server ─────────────────────────────────────────────

interface Family {
  id: string;
  userId: string;
  revoked: boolean;
}

const users = {
  alice: account("alice"),
  bob: account("bob"),
};
type UserId = keyof typeof users;

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

let families: Map<string, Family>;
let active: Map<string, string>; // current refresh token -> family
let rotated: Map<string, string>; // retired refresh token -> family
let cookie: string | null; // the browser's single refresh cookie
let offline: boolean;
let counter = 0;

interface Call {
  path: string;
  keepalive: boolean;
  token: string | null;
  body: unknown;
  recoveryHeader: string | null;
  cookie: string | null;
}
let calls: Call[];
type Route = (call: Call) => Response | Promise<Response>;
let routes: Map<string, Route>;

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function base64url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** An access token shaped like the server's: its `sid` is the family id. */
function accessToken(userId: string, sid: string, expiresInSeconds = 900) {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  return `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url({ sub: userId, sid, exp })}.signature`;
}

function sidOf(token: string | null) {
  if (!token) return null;
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
      .sid as string;
  } catch {
    return null;
  }
}

function uuid() {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
}

function newRefreshToken(familyId: string) {
  const token = `refresh-${uuid()}`;
  active.set(token, familyId);
  return token;
}

function sessionBody(family: Family) {
  return {
    data: {
      user: users[family.userId as UserId],
      accessToken: accessToken(family.userId, family.id),
      workspaces: [],
    },
  };
}

/** The family a cookie (as sent with a request) belongs to. */
function familyOf(sent: string | null): Family | undefined {
  if (!sent) return undefined;
  const id = active.get(sent) ?? rotated.get(sent);
  return id ? families.get(id) : undefined;
}

function revoke(family: Family) {
  family.revoked = true;
  for (const [token, id] of [...active])
    if (id === family.id) active.delete(token);
}

const defaultRoutes: Record<string, Route> = {
  "auth/login": ({ body }) => {
    const userId = (body as { email: string }).email.split("@")[0] as UserId;
    const family: Family = { id: uuid(), userId, revoked: false };
    families.set(family.id, family);
    cookie = newRefreshToken(family.id);
    return json(200, sessionBody(family));
  },
  "auth/refresh": ({ cookie: sent }) => {
    const id = sent ? active.get(sent) : undefined;
    const family = id ? families.get(id) : undefined;
    if (!family || family.revoked) return json(401, { statusCode: 401 });
    active.delete(sent!);
    rotated.set(sent!, family.id);
    cookie = newRefreshToken(family.id);
    return json(200, sessionBody(family));
  },
  "auth/logout": ({ token, cookie: sent }) => {
    const family = families.get(sidOf(token) ?? "");
    if (!family || family.revoked) return json(401, { statusCode: 401 });
    const held = familyOf(sent);
    cookie = null;
    if (held) revoke(held);
    return json(204);
  },
  // Never sets or clears the cookie; revokes only the family it proves.
  "auth/logout/recover": ({ body, recoveryHeader, cookie: sent }) => {
    if (recoveryHeader !== "1") return json(403, { statusCode: 403 });
    const { sessionId } = body as { sessionId: string };
    const family = familyOf(sent);
    if (!family) return json(200, { data: { status: "absent" } });
    if (family.id !== sessionId)
      return json(200, { data: { status: "superseded" } });
    revoke(family);
    return json(200, { data: { status: "revoked" } });
  },
};

const fetchMock = vi.fn(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(String(input), init);
    const text = await request.text();
    const call: Call = {
      path: new URL(request.url).pathname.replace(/^\/api\//, ""),
      keepalive: init?.keepalive === true,
      token:
        request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? null,
      body: text ? JSON.parse(text) : undefined,
      recoveryHeader: request.headers.get("X-Werkyn-Session-Recovery"),
      cookie,
    };
    calls.push(call);
    if (offline) throw new TypeError("Failed to fetch");
    const route = routes.get(call.path) ?? defaultRoutes[call.path];
    if (!route) return json(404, { statusCode: 404 });
    return route(call);
  },
);

/** Signs in on the server, as another device or a previous visit would. */
function serverSignIn(userId: UserId) {
  const family: Family = { id: uuid(), userId, revoked: false };
  families.set(family.id, family);
  cookie = newRefreshToken(family.id);
  return { family, session: sessionBody(family).data };
}

// ─── Browser ────────────────────────────────────────────

const tabs: Tab[] = [];

/** Loads the application in a new tab (or reloads one: same storage). */
async function openTab(): Promise<Tab> {
  vi.resetModules();
  const tab = await import("./auth-store");
  tabs.push(tab);
  return tab;
}

/** Runs fake time until `promise` settles (bounded). */
async function run<T>(promise: Promise<T>, limitMs = 60_000): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let elapsed = 0; !done && elapsed < limitMs; elapsed += 50) {
    await vi.advanceTimersByTimeAsync(50);
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(done).toBe(true);
  return promise;
}

/** Delivers BroadcastChannel messages, which use real (not faked) tasks. */
async function deliverMessages() {
  for (let round = 0; round < 3; round++) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
  }
}

async function load(): Promise<Tab> {
  const tab = await openTab();
  await run(tab.useAuthStore.getState().hydrate());
  return tab;
}

/** What the sign-in form does: wait for sign-outs, sign in, apply it. */
async function signInWithForm(tab: Tab, userId: UserId) {
  await run(tab.whenLoggedOut());
  const res = await fetch("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${userId}@example.test`, password: "x" }),
  });
  const { data } = await res.json();
  tab.useAuthStore
    .getState()
    .setAuth(data.user, data.accessToken, data.workspaces);
  return sidOf(data.accessToken)!;
}

/** Signs in with a session restored from the cookie (an earlier visit). */
async function signedInTab(userId: UserId) {
  const { family } = serverSignIn(userId);
  const tab = await load();
  expect(tab.useAuthStore.getState().user?.id).toBe(userId);
  return { tab, family };
}

function pendingKeys() {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith("pm-auth-signout:")) keys.push(key);
  }
  return keys;
}

const paths = (from = 0) => calls.slice(from).map((call) => call.path);
const refreshes = (from = 0) =>
  paths(from).filter((path) => path === "auth/refresh").length;

let clock = Date.UTC(2026, 10, 4);

beforeEach(() => {
  clock += 30 * 24 * 60 * 60 * 1000;
  vi.useFakeTimers({
    now: clock,
    toFake: ["setTimeout", "clearTimeout", "Date"],
  });
  vi.stubGlobal("fetch", fetchMock);
  families = new Map();
  active = new Map();
  rotated = new Map();
  cookie = null;
  offline = false;
  calls = [];
  routes = new Map();
  localStorage.clear();
});

afterEach(async () => {
  for (const tab of tabs.splice(0))
    tab.useAuthStore.setState({ user: null, accessToken: null });
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ─── Scenarios ──────────────────────────────────────────

describe("a sign-out whose request fails", () => {
  it("is completed by the next page load, which revokes the session and stays signed out", async () => {
    const { tab, family } = await signedInTab("alice");
    offline = true;
    await run(tab.useAuthStore.getState().logout());
    expect(tab.useAuthStore.getState().user).toBeNull();
    expect(family.revoked).toBe(false);
    expect(pendingKeys()).toHaveLength(1);

    offline = false;
    const from = calls.length;
    const reloaded = await load();
    expect(reloaded.useAuthStore.getState()).toMatchObject({
      user: null,
      isHydrated: true,
    });
    expect(family.revoked).toBe(true);
    // Revoked first, with keepalive, and never exchanged for a session.
    expect(paths(from)[0]).toBe("auth/logout/recover");
    expect(calls[from]).toMatchObject({
      keepalive: true,
      body: { sessionId: family.id },
    });
    expect(refreshes(from)).toBe(0);
    expect(pendingKeys()).toHaveLength(0);

    // Settled: later loads do not ask again.
    const again = calls.length;
    await load();
    expect(paths(again)).not.toContain("auth/logout/recover");
  });

  it.each([
    [
      "a proxy answers 502",
      () => routes.set("auth/logout", () => json(502, { statusCode: 502 })),
    ],
    [
      "the tab is closed before it answers",
      () => routes.set("auth/logout", () => new Promise<Response>(() => {})),
    ],
  ])("is completed by the next page load when %s", async (_label, fail) => {
    const { tab, family } = await signedInTab("alice");
    fail();
    void tab.useAuthStore.getState().logout();
    await vi.advanceTimersByTimeAsync(0);
    expect(pendingKeys()).toHaveLength(1);
    routes.delete("auth/logout");

    const reloaded = await load();
    expect(reloaded.useAuthStore.getState().user).toBeNull();
    expect(family.revoked).toBe(true);
    expect(pendingKeys()).toHaveLength(0);
  });

  it("is completed by a reload of another tab while the first tab stays open", async () => {
    const { tab: tabA, family } = await signedInTab("alice");
    const tabB = await load();
    expect(tabB.useAuthStore.getState().user?.id).toBe("alice");

    offline = true;
    await run(tabA.useAuthStore.getState().logout());
    await deliverMessages();
    expect(tabB.useAuthStore.getState().user).toBeNull();
    offline = false;

    const reloadedB = await load();
    expect(reloadedB.useAuthStore.getState().user).toBeNull();
    expect(family.revoked).toBe(true);
    await deliverMessages();
    expect(tabA.useAuthStore.getState().user).toBeNull();
  });

  it("keeps the request while the server stays unreachable and never adopts the session meanwhile", async () => {
    const { tab, family } = await signedInTab("alice");
    offline = true;
    await run(tab.useAuthStore.getState().logout());
    const stillOffline = await load();
    expect(stillOffline.useAuthStore.getState().user).toBeNull();
    expect(pendingKeys()).toHaveLength(1);

    // Back online but the recovery endpoint is briefly busy: retried, and the
    // session is not adopted on a load that could not finish the sign-out.
    offline = false;
    routes.set("auth/logout/recover", () => json(503, { statusCode: 503 }));
    const busy = await load();
    expect(busy.useAuthStore.getState().user).toBeNull();
    expect(family.revoked).toBe(false);
    expect(
      paths().filter((path) => path === "auth/logout/recover").length,
    ).toBeGreaterThan(1);
    expect(pendingKeys()).toHaveLength(1);

    routes.delete("auth/logout/recover");
    const recovered = await load();
    expect(recovered.useAuthStore.getState().user).toBeNull();
    expect(family.revoked).toBe(true);
    expect(pendingKeys()).toHaveLength(0);
  });

  it.each([
    ["refuses the request (untrusted Origin)", 403],
    ["has no recovery route", 404],
    ["keeps failing", 500],
  ])(
    "is kept, restoring nothing and sending nothing that changes the cookie, while the server %s",
    async (_label, status) => {
      const { tab, family } = await signedInTab("alice");
      offline = true;
      await run(tab.useAuthStore.getState().logout());
      offline = false;
      routes.set("auth/logout/recover", () =>
        json(status, { statusCode: status }),
      );
      const from = calls.length;
      const reloaded = await load();
      expect(reloaded.useAuthStore.getState().user).toBeNull();
      expect(family.revoked).toBe(false);
      // No refresh or ordinary logout: either could replace or end a sign-in
      // landing meanwhile, such as a single sign-on callback.
      expect(paths(from)).toEqual(["auth/logout/recover"]);
      expect(pendingKeys()).toHaveLength(1);

      // Signing in again replaces the cookie; the record cannot hold back the
      // new session.
      const second = await signInWithForm(reloaded, "alice");
      expect(pendingKeys()).toHaveLength(0);
      const again = await load();
      expect(sidOf(again.useAuthStore.getState().accessToken)).toBe(second);
      expect(families.get(second)!.revoked).toBe(false);
    },
  );

  it("is recorded even when the access token has already expired", async () => {
    const { family } = serverSignIn("alice");
    const tab = await openTab();
    tab.useAuthStore
      .getState()
      .setAuth(users.alice, accessToken("alice", family.id, -60), []);
    offline = true;
    await run(tab.useAuthStore.getState().logout());
    offline = false;
    await load();
    expect(family.revoked).toBe(true);
  });

  it("whose access token has expired is completed by recovery, without renewing the session", async () => {
    const { family } = serverSignIn("alice");
    const tab = await openTab();
    tab.useAuthStore
      .getState()
      .setAuth(users.alice, accessToken("alice", family.id, -60), []);
    routes.set("auth/logout", () => json(401, { statusCode: 401 }));
    const from = calls.length;
    await run(tab.useAuthStore.getState().logout());
    expect(paths(from)).toEqual(["auth/logout", "auth/logout/recover"]);
    expect(calls.at(-1)).toMatchObject({
      keepalive: true,
      body: { sessionId: family.id },
    });
    expect(family.revoked).toBe(true);
    expect(pendingKeys()).toHaveLength(0);
  });

  it("leaves nothing behind when the sign-out succeeds", async () => {
    const { tab, family } = await signedInTab("alice");
    await run(tab.useAuthStore.getState().logout());
    expect(family.revoked).toBe(true);
    expect(pendingKeys()).toHaveLength(0);
    const from = calls.length;
    await load();
    expect(paths(from).length).toBeGreaterThan(0);
    expect(paths(from).every((path) => path === "auth/refresh")).toBe(true);
  });
});

describe("a newer sign-in", () => {
  it("is never revoked by an older pending sign-out, signed in again in the same tab", async () => {
    const { tab, family: first } = await signedInTab("alice");
    offline = true;
    await run(tab.useAuthStore.getState().logout());
    offline = false;
    // The old session cannot be reached while signing in (recovery fails), so
    // it is still pending when the new session's cookie replaces the old one.
    routes.set("auth/logout/recover", () => {
      throw new TypeError("Failed to fetch");
    });
    const second = await signInWithForm(tab, "alice");
    routes.delete("auth/logout/recover");
    expect(first.revoked).toBe(false);

    const reloaded = await load();
    expect(reloaded.useAuthStore.getState().user?.id).toBe("alice");
    expect(sidOf(reloaded.useAuthStore.getState().accessToken)).toBe(second);
    expect(families.get(second)!.revoked).toBe(false);
    expect(pendingKeys()).toHaveLength(0);
  });

  it("finishes the old sign-out before signing in when the server is reachable", async () => {
    const { tab, family: first } = await signedInTab("alice");
    offline = true;
    await run(tab.useAuthStore.getState().logout());
    offline = false;
    const from = calls.length;
    const second = await signInWithForm(tab, "bob");
    expect(paths(from)).toEqual(["auth/logout/recover", "auth/login"]);
    expect(first.revoked).toBe(true);
    const reloaded = await load();
    expect(reloaded.useAuthStore.getState().user?.id).toBe("bob");
    expect(families.get(second)!.revoked).toBe(false);
  });

  it("in another tab wins over a sign-out still pending from the first tab", async () => {
    const { tab: tabA, family: first } = await signedInTab("alice");
    const tabB = await load();
    // Tab A's sign-out hangs; tab B signs in again meanwhile.
    const hung = new Promise<Response>(() => {});
    routes.set("auth/logout", () => hung);
    void tabA.useAuthStore.getState().logout();
    await deliverMessages();
    expect(tabB.useAuthStore.getState().user).toBeNull();
    routes.set("auth/logout/recover", () => {
      throw new TypeError("Failed to fetch");
    });
    const second = await signInWithForm(tabB, "alice");
    routes.delete("auth/logout/recover");
    routes.delete("auth/logout");
    await deliverMessages();

    // A third tab loads: the stale request finds a newer session and leaves it.
    const tabC = await load();
    expect(tabC.useAuthStore.getState().user?.id).toBe("alice");
    expect(sidOf(tabC.useAuthStore.getState().accessToken)).toBe(second);
    expect(families.get(second)!.revoked).toBe(false);
    expect(first.revoked).toBe(false);
    expect(pendingKeys()).toHaveLength(0);
  });

  it("racing a load that is completing the old sign-out is kept, not revoked", async () => {
    const { tab, family: first } = await signedInTab("alice");
    offline = true;
    await run(tab.useAuthStore.getState().logout());
    offline = false;

    // Tab B loads and sends its recovery request with the old cookie; tab C
    // signs Bob in before that request is answered.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    routes.set("auth/logout/recover", async (call) => {
      await held;
      return defaultRoutes["auth/logout/recover"](call);
    });
    const tabB = await openTab();
    const hydrating = tabB.useAuthStore.getState().hydrate();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(paths()).toContain("auth/logout/recover"));
    routes.delete("auth/logout/recover");
    const tabC = await openTab();
    const bob = serverSignIn("bob");
    tabC.useAuthStore
      .getState()
      .setAuth(bob.session.user, bob.session.accessToken, []);
    release();
    await run(hydrating);
    await deliverMessages();

    expect(first.revoked).toBe(true);
    expect(bob.family.revoked).toBe(false);
    expect(tabB.useAuthStore.getState().user?.id).toBe("bob");
    expect(pendingKeys()).toHaveLength(0);
    const tabD = await load();
    expect(tabD.useAuthStore.getState().user?.id).toBe("bob");
  });

  it("set by a single sign-on callback is restored: recovery reports superseded and leaves it", async () => {
    const { tab, family: first } = await signedInTab("alice");
    offline = true;
    await run(tab.useAuthStore.getState().logout());
    offline = false;
    // The callback sets the new session's cookie without this page's sign-in.
    const { family: second } = serverSignIn("alice");
    const from = calls.length;
    const reloaded = await load();
    expect(calls[from]).toMatchObject({
      path: "auth/logout/recover",
      body: { sessionId: first.id },
    });
    expect(reloaded.useAuthStore.getState().user?.id).toBe("alice");
    expect(sidOf(reloaded.useAuthStore.getState().accessToken)).toBe(second.id);
    expect(second.revoked).toBe(false);
    expect(pendingKeys()).toHaveLength(0);
  });

  it("set by a single sign-on callback is not restored while recovery is refused", async () => {
    const { tab } = await signedInTab("alice");
    offline = true;
    await run(tab.useAuthStore.getState().logout());
    offline = false;
    routes.set("auth/logout/recover", () => json(404, { statusCode: 404 }));
    const { family: second } = serverSignIn("alice");
    const reloaded = await load();
    // Fail closed: nothing restored, nothing revoked, the record kept.
    expect(reloaded.useAuthStore.getState().user).toBeNull();
    expect(second.revoked).toBe(false);
    expect(pendingKeys()).toHaveLength(1);
  });

  it("of the same account is not revoked when an expired-token sign-out completes", async () => {
    const { tab, family: first } = await signedInTab("alice");
    // Alice's access token is rejected; meanwhile the cookie was replaced by a
    // newer Alice sign-in elsewhere in this browser.
    routes.set("auth/logout", (call) =>
      sidOf(call.token) === first.id
        ? json(401, { statusCode: 401 })
        : defaultRoutes["auth/logout"](call),
    );
    const { family: second } = serverSignIn("alice");
    const from = calls.length;
    await run(tab.useAuthStore.getState().logout());
    expect(second.revoked).toBe(false);
    // Completed by conditional recovery, which never touches the cookie.
    expect(paths(from)).toEqual(["auth/logout", "auth/logout/recover"]);
    expect(pendingKeys()).toHaveLength(0);
  });
});

describe("the pending sign-out record", () => {
  it("signs out a tab that still holds the session when it next refreshes", async () => {
    const { tab: tabA, family } = await signedInTab("alice");
    const tabB = await load();
    offline = true;
    await run(tabA.useAuthStore.getState().logout());
    offline = false;
    // Tab B missed tab A's announcement (for example, no BroadcastChannel).
    tabB.useAuthStore.setState({
      user: users.alice,
      accessToken: accessToken("alice", family.id),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const from = calls.length;
    await expect(run(tabB.useAuthStore.getState().refresh())).resolves.toBe(
      false,
    );
    expect(tabB.useAuthStore.getState().user).toBeNull();
    expect(refreshes(from)).toBe(0);
  });

  it("is bounded, keeping the newest sign-outs", async () => {
    let last: Family | undefined;
    for (let n = 0; n < 20; n++) {
      // Each session is restored from a cookie set elsewhere (such as single
      // sign-on), so older records cannot be settled and are not retired.
      const { family, session } = serverSignIn("alice");
      const tab = await openTab();
      tab.useAuthStore.setState({
        user: session.user,
        accessToken: session.accessToken,
      });
      offline = true;
      await run(tab.useAuthStore.getState().logout());
      offline = false;
      last = family;
    }
    expect(pendingKeys().length).toBeGreaterThan(0);
    expect(pendingKeys().length).toBeLessThanOrEqual(8);
    expect(pendingKeys().some((key) => key.endsWith(last!.id))).toBe(true);

    const reloaded = await load();
    expect(reloaded.useAuthStore.getState().user).toBeNull();
    expect(last!.revoked).toBe(true);
    expect(pendingKeys()).toHaveLength(0);
  });

  it("expires after the longest lifetime a refresh token can have", async () => {
    const { tab, family } = await signedInTab("alice");
    offline = true;
    await run(tab.useAuthStore.getState().logout());
    expect(pendingKeys()).toHaveLength(1);
    // The cookie and every token of the family have expired by now.
    vi.setSystemTime(Date.now() + 9 * 24 * 60 * 60 * 1000);
    cookie = null;
    offline = false;
    const from = calls.length;
    const reloaded = await load();
    expect(reloaded.useAuthStore.getState().user).toBeNull();
    expect(pendingKeys()).toHaveLength(0);
    expect(paths(from)).not.toContain("auth/logout/recover");
    expect(family.revoked).toBe(false);
  });
});
