import { create } from "zustand";
import { apiUrl } from "@/lib/api-url";
import { changeIdentity, identityGeneration } from "@/lib/identity";

interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  jobTitle: string | null;
  phone: string | null;
  timezone: string | null;
  emailVerified: boolean;
}

export interface WorkspaceMembership {
  id: string;
  workspaceId: string;
  role: "ADMIN" | "MEMBER" | "VIEWER";
  workspace: {
    id: string;
    name: string;
    slug: string;
    logoUrl: string | null;
  };
}

interface Session {
  user: User;
  accessToken: string;
  workspaces: WorkspaceMembership[];
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  workspaces: WorkspaceMembership[];
  isHydrated: boolean;
  _refreshPromise: Promise<boolean> | null;

  setAuth: (
    user: User,
    accessToken: string,
    workspaces: WorkspaceMembership[],
  ) => void;
  setWorkspaces: (workspaces: WorkspaceMembership[]) => void;
  setWorkspacesForUser: (
    userId: string,
    workspaces: WorkspaceMembership[],
  ) => boolean;
  /**
   * Signs out at once, here and in this browser's other tabs, then revokes the
   * session on the server. The returned promise settles when revocation has
   * finished or given up (bounded); it never rejects.
   */
  logout: () => Promise<void>;
  /**
   * Signs out after a refresh started in `generation` failed, unless the
   * identity has changed since. Nothing is sent to the server: the session
   * cookie no longer works.
   */
  expireSession: (generation: number) => void;
  refresh: () => Promise<boolean>;
  hydrate: () => Promise<void>;
}

// ─── Cross-tab ordering ──────────────────────────────────
//
// Tabs share one refresh cookie and announce identity changes over a
// BroadcastChannel. Each announcement carries the epoch of the identity change
// it reflects; a tab ignores announcements older than the newest change it
// knows of. Without this, a refresh that another tab completed just before
// this tab signed out could sign this tab back in.
//
// An epoch is a time plus the id of the tab that made the change (to order
// changes made in the same millisecond). A change is dated by the evidence it
// rests on: sign-in and sign-out by the user's action, a refresh that reports
// a different account by when its request was sent, so that it cannot
// outrank a sign-out that happened while it was in flight.

interface Epoch {
  at: number;
  tab: string;
}

const tabId = Math.random().toString(36).slice(2);
let knownEpoch: Epoch = { at: 0, tab: "" };

function compareEpochs(a: Epoch, b: Epoch) {
  if (a.at !== b.at) return a.at - b.at;
  return a.tab < b.tab ? -1 : a.tab > b.tab ? 1 : 0;
}

/** Starts a newer epoch, dated `at` unless that would not be newer. */
function advanceEpoch(at: number): Epoch {
  knownEpoch = { at: Math.max(at, knownEpoch.at + 1), tab: tabId };
  return knownEpoch;
}

function isEpoch(value: unknown): value is Epoch {
  const epoch = value as Epoch | null | undefined;
  return typeof epoch?.at === "number" && typeof epoch.tab === "string";
}

/**
 * Accepts an announcement's epoch unless it is older than one already known.
 * Messages from tabs still running an earlier build carry no epoch and cannot
 * be ordered: the message handler lets them sign out, or renew the token of
 * the account already signed in, but never sign an account in.
 */
function acceptEpoch(value: unknown): boolean {
  if (!isEpoch(value)) return true;
  if (compareEpochs(value, knownEpoch) < 0) return false;
  knownEpoch = value;
  return true;
}

type AuthMessage =
  | { type: "logout"; epoch: Epoch }
  | { type: "refresh"; epoch: Epoch; data: Session }
  | {
      type: "workspaces";
      epoch: Epoch;
      data: { userId: string; workspaces: WorkspaceMembership[] };
    };

// BroadcastChannel for cross-tab sync
const channel =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("pm-auth")
    : null;

function announce(message: AuthMessage) {
  channel?.postMessage(message);
}

// ─── Refresh ──────────────────────────────────────────────

let lastRefreshTime = 0;

// Tabs share one refresh cookie. When another tab rotates it first, the server
// answers 409 without minting or revoking anything. The winning tab's response
// replaces the cookie and normally broadcasts the new access token: adopt that
// broadcast as soon as it arrives, or retry with the replaced cookie. A 503
// means the session was busy and the unchanged cookie is retried the same way.
//
// The server answers the old cookie 409 for 30 s after its rotation and then
// treats it as reuse, revoking the session. A run of 409s is therefore tracked
// across refresh calls (hydration repeats them): 15 s after the first one,
// the winning response is treated as lost and the old cookie is not sent
// again until another tab broadcasts a refresh or this tab signs in.
const SUPERSEDED_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 6000];
const SUPERSEDED_BUDGET_MS = 15_000;
let supersededSince: number | null = null;
const broadcastWaiters = new Set<() => void>();
// The identity generation the pending `_refreshPromise` was started in.
let refreshGeneration = -1;

function supersededTooLong() {
  return (
    supersededSince !== null &&
    Date.now() - supersededSince >= SUPERSEDED_BUDGET_MS
  );
}

/** What a refresh started at `start` may still change. */
interface RefreshStart {
  generation: number;
  epoch: Epoch;
}

/** The identity or the cross-tab epoch changed after `start`. */
function isStale(start: RefreshStart) {
  return (
    identityGeneration() !== start.generation ||
    compareEpochs(knownEpoch, start.epoch) !== 0
  );
}

// Refresh requests in flight in this tab. A sign-out aborts them: the session
// they would renew is being revoked, and a response arriving later could set
// its cookie over the cookie of the next sign-in.
const refreshAborts = new Set<AbortController>();

function abortRefreshes() {
  for (const controller of refreshAborts) controller.abort();
  refreshAborts.clear();
}

async function requestRefresh(start: RefreshStart) {
  const sentAt = Date.now();
  const controller = new AbortController();
  refreshAborts.add(controller);
  // Settles on abort even if the network layer ignores the signal.
  const aborted = new Promise<never>((_, reject) =>
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason),
      { once: true },
    ),
  );
  const res = await cookieRequest(() =>
    Promise.race([
      fetch(apiUrl("auth/refresh"), {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
      }),
      aborted,
    ]),
  ).finally(() => refreshAborts.delete(controller));
  // A stale answer says nothing about the cookie of the current session.
  if (isStale(start)) return res;
  // A 409 for a cookie sent before a newer refresh landed says nothing about
  // the cookie the browser holds now; a busy 503 leaves the cookie unchanged.
  if (res.status === 409) {
    if (lastRefreshTime < sentAt) supersededSince ??= Date.now();
  } else if (res.status !== 503) {
    supersededSince = null;
  }
  return res;
}

const retryable = (res: Response) => res.status === 409 || res.status === 503;

function waitForBroadcast(ms: number) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      broadcastWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    broadcastWaiters.add(done);
  });
}

function wakeRefreshWaiters() {
  for (const wake of [...broadcastWaiters]) wake();
}

// ─── Cookie-setting requests ─────────────────────────────
//
// A refresh or a sign-out still in flight sets or clears the shared refresh
// cookie when its response arrives, possibly after a new sign-in in this or
// another tab has set the new session's cookie. While such a request runs,
// its tab records a deadline in localStorage under its own key, and a sign-in
// in any tab first waits (bounded) until none is left, so the new session's
// cookie is the last one set.

const LOGOUT_TIMEOUT_MS = 10_000;
const BUSY_KEY_PREFIX = "pm-auth-busy:";
const busyKey = `${BUSY_KEY_PREFIX}${tabId}`;
let cookieRequests = 0;

function writeBusy(value: string | null) {
  try {
    if (value === null) localStorage.removeItem(busyKey);
    else localStorage.setItem(busyKey, value);
  } catch {
    // Storage unavailable: only this tab's own work is waited for.
  }
}

async function cookieRequest<T>(run: () => Promise<T>): Promise<T> {
  cookieRequests += 1;
  writeBusy(String(Date.now() + LOGOUT_TIMEOUT_MS));
  try {
    return await run();
  } finally {
    cookieRequests -= 1;
    if (cookieRequests === 0) writeBusy(null);
  }
}

/** The latest deadline of a cookie-setting request in flight in any tab. */
function busyUntil(): number {
  let until = 0;
  const now = Date.now();
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (!key?.startsWith(BUSY_KEY_PREFIX)) continue;
      const deadline = Number(localStorage.getItem(key)) || 0;
      // Left behind by a tab that closed mid-request.
      if (deadline <= now) localStorage.removeItem(key);
      else until = Math.max(until, deadline);
    }
  } catch {
    // Storage unavailable
  }
  return until;
}

let pendingLogout: Promise<void> | null = null;

/**
 * Settles once no sign-out or refresh, in this tab or another, can still set
 * or clear the session cookie: when those requests have finished or reached
 * their deadline. A new sign-in waits for it, so its cookie is the last set.
 */
export async function whenLoggedOut(): Promise<void> {
  await (pendingLogout ?? Promise.resolve());
  const giveUpAt = Date.now() + LOGOUT_TIMEOUT_MS;
  while (Date.now() < Math.min(busyUntil(), giveUpAt)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const LOGOUT_REFRESH_RETRY_DELAYS_MS = [250, 500, 1000, 2000];

async function revokeSession(
  accessToken: string | null,
  userId: string,
  logoutEpoch: Epoch,
) {
  const controller = new AbortController();
  // Another tab announced a newer sign-in or sign-out: the cookie may now
  // belong to that session, which this sign-out must not touch.
  const overtaken = () => compareEpochs(knownEpoch, logoutEpoch) > 0;
  const signOut = (token: string | null) =>
    fetch(apiUrl("auth/logout"), {
      method: "POST",
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
  const refreshCookie = () =>
    fetch(apiUrl("auth/refresh"), {
      method: "POST",
      credentials: "include",
      signal: controller.signal,
    });
  const revoke = async () => {
    const res = await signOut(accessToken);
    if (res.status !== 401 || overtaken()) return;
    // The server only accepts a sign-out with a current access token. When
    // ours has expired, exchange the cookie for one, without signing this
    // tab back in, and sign out with that, unless the cookie now belongs to
    // another account (signed in from another tab meanwhile). A cookie that
    // another tab has just rotated (409) or a busy session (503) is retried
    // with the browser's current cookie, within the deadline.
    let refreshed = await refreshCookie();
    for (const delay of LOGOUT_REFRESH_RETRY_DELAYS_MS) {
      if (!retryable(refreshed) || overtaken()) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (overtaken()) return;
      refreshed = await refreshCookie();
    }
    if (!refreshed.ok || overtaken()) return;
    const body = (await refreshed.json()) as {
      data?: { user?: { id?: string }; accessToken?: string };
    };
    if (body.data?.user?.id !== userId || !body.data.accessToken) return;
    if (overtaken()) return;
    await signOut(body.data.accessToken);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Settles at the deadline even if a request ignores its abort signal.
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, LOGOUT_TIMEOUT_MS);
  });
  try {
    await cookieRequest(() => Promise.race([revoke(), deadline]));
  } catch {
    // Local state is already cleared; the network may be unavailable.
  } finally {
    clearTimeout(timer);
  }
}

// ─── Store ────────────────────────────────────────────────

export const useAuthStore = create<AuthState>((set, get) => {
  /** Applies a session; an account change resets everything held for the previous one. */
  function applySession(session: Session, epoch: Epoch) {
    supersededSince = null;
    set({
      user: session.user,
      accessToken: session.accessToken,
      workspaces: session.workspaces,
    });
    announce({ type: "refresh", epoch, data: session });
  }

  /** Clears the session here and tells other tabs at `epoch` or older. */
  function endSession(epoch: Epoch) {
    abortRefreshes();
    lastRefreshTime = 0;
    supersededSince = null;
    set({ user: null, accessToken: null, workspaces: [] });
    announce({ type: "logout", epoch });
  }

  // Listen for cross-tab messages
  channel?.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as Partial<AuthMessage> | null;
    if (!message) return;
    const legacy = !isEpoch(message.epoch);
    if (!acceptEpoch(message.epoch)) return;
    if (message.type === "logout") {
      abortRefreshes();
      lastRefreshTime = 0;
      supersededSince = null;
      set({ user: null, accessToken: null, workspaces: [], isHydrated: true });
      wakeRefreshWaiters();
    } else if (message.type === "refresh" && message.data) {
      const { user, accessToken, workspaces } = message.data;
      // Unordered (earlier build): it may only renew this account's token.
      if (legacy && get().user?.id !== user.id) return;
      lastRefreshTime = Date.now();
      supersededSince = null;
      set({ user, accessToken, workspaces });
      wakeRefreshWaiters();
    } else if (message.type === "workspaces" && message.data) {
      const { userId, workspaces } = message.data;
      // Memberships of one account; ignored by tabs signed in as another.
      set((state) =>
        state.user?.id === userId ? { workspaces } : state,
      );
    }
  });

  return {
    user: null,
    accessToken: null,
    workspaces: [],
    isHydrated: false,
    _refreshPromise: null,

    setAuth: (user, accessToken, workspaces) => {
      // A sign-in is newer than anything announced before it.
      applySession({ user, accessToken, workspaces }, advanceEpoch(Date.now()));
    },

    setWorkspaces: (workspaces) => {
      set({ workspaces });
    },

    // Applies committed memberships returned for one account, only while that
    // account is signed in here, and shares them with its other open tabs.
    setWorkspacesForUser: (userId, workspaces) => {
      let applied = false;
      set((state) => {
        if (state.user?.id !== userId) return state;
        applied = true;
        return { workspaces };
      });
      if (applied)
        announce({
          type: "workspaces",
          epoch: knownEpoch,
          data: { userId, workspaces },
        });
      return applied;
    },

    logout: () => {
      const { user, accessToken } = get();
      const epoch = advanceEpoch(Date.now());
      endSession(epoch);
      if (!user) return pendingLogout ?? Promise.resolve();
      const revoking = revokeSession(accessToken, user.id, epoch);
      pendingLogout = revoking;
      void revoking.then(() => {
        if (pendingLogout === revoking) pendingLogout = null;
      });
      return revoking;
    },

    expireSession: (generation) => {
      if (identityGeneration() !== generation) return;
      const { user, accessToken } = get();
      if (!user && !accessToken) return;
      // Only just newer than the session that failed: tabs that have already
      // moved on to a later sign-in ignore it.
      endSession(advanceEpoch(0));
    },

    refresh: async () => {
      // If another tab refreshed recently, skip
      if (Date.now() - lastRefreshTime < 5000) {
        return !!get().accessToken;
      }

      const start: RefreshStart = {
        generation: identityGeneration(),
        epoch: knownEpoch,
      };
      // Mutex: reuse the refresh already running for this identity.
      const existing = get()._refreshPromise;
      if (existing && refreshGeneration === start.generation) return existing;
      // Checked before the mutex promise exists: a synchronous result inside
      // it would leave a settled promise behind as the "pending" refresh.
      if (supersededTooLong()) return false;

      // A refresh overtaken by an identity change reports success only if this
      // tab is still the same identity and has a token (adopted from another
      // tab's newer announcement); its own result is never applied.
      const overtaken = () =>
        identityGeneration() === start.generation && !!get().accessToken;

      const run = async () => {
        try {
          const startedAt = Date.now();
          let res = await requestRefresh(start);
          for (const delay of SUPERSEDED_RETRY_DELAYS_MS) {
            if (isStale(start)) return overtaken();
            if (!retryable(res)) break;
            await waitForBroadcast(delay);
            if (isStale(start)) return overtaken();
            if (lastRefreshTime > startedAt && get().accessToken) {
              supersededSince = null;
              return true;
            }
            if (supersededTooLong()) return false;
            res = await requestRefresh(start);
          }

          if (isStale(start)) return overtaken();
          if (!res.ok) return false;

          const body = await res.json();
          if (isStale(start)) return overtaken();
          const session = body.data as Session;
          lastRefreshTime = Date.now();
          const epoch =
            get().user?.id === session.user.id
              ? knownEpoch
              : advanceEpoch(startedAt);
          applySession(session, epoch);
          return true;
        } catch {
          // A sign-out aborts the refreshes it overtakes.
          return isStale(start) ? overtaken() : false;
        }
      };
      const promise: Promise<boolean> = run().finally(() => {
        if (get()._refreshPromise === promise) set({ _refreshPromise: null });
      });

      refreshGeneration = start.generation;
      set({ _refreshPromise: promise });
      return promise;
    },

    hydrate: async () => {
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts) {
        const success = await get().refresh();
        if (success) break;
        attempts++;
        if (attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      set({ isHydrated: true });
    },
  };
});

// Every change of the signed-in account, from any source, goes through the
// identity transition. The refresh state above belongs to the previous one.
useAuthStore.subscribe((state, previous) => {
  const userId = state.user?.id ?? null;
  const previousUserId = previous.user?.id ?? null;
  if (userId === previousUserId) return;
  supersededSince = null;
  changeIdentity(previousUserId, userId);
  wakeRefreshWaiters();
});
