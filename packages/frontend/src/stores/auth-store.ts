import { create } from "zustand";
import { apiUrl } from "@/lib/api-url";
import { changeIdentity, identityGeneration } from "@/lib/identity";
import { clearOidcSignIn, oidcSignInAttempt } from "@/lib/oidc-sign-in";
import {
  clearPendingSignOut,
  hasPendingSignOut,
  pendingSignOuts,
  recordPendingSignOut,
  sessionIdOf,
} from "@/lib/pending-sign-out";

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
  membershipRevision?: number;
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
    membershipRevision?: number,
  ) => void;
  setWorkspaces: (workspaces: WorkspaceMembership[]) => void;
  setWorkspacesForUser: (
    userId: string,
    workspaces: WorkspaceMembership[],
    membershipRevision?: number,
  ) => boolean;
  /**
   * Signs out at once, here and in this browser's other tabs, then revokes the
   * session on the server. The returned promise settles when revocation has
   * finished or given up (bounded); it never rejects. A revocation that did not
   * finish is completed by the next page load or sign-in, in any tab.
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

// Workspace lists are ordered by the revision captured with that list, not by
// the sign-in epoch. An equal or older revision is left in place, so a refresh
// that read memberships before a join cannot erase the join. The epoch does
// not move: a membership update cannot outrank a sign-out.
let appliedMembershipUserId: string | null = null;
let appliedMembershipRevision: number | null = null;

function membershipRevisionOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** True when this list may replace the one already applied for `userId`. */
function isNewerMembershipRevision(userId: string, revision: number | null) {
  const applied =
    appliedMembershipUserId === userId ? appliedMembershipRevision : null;
  // A list with no revision is the previous protocol. It can fill an
  // unversioned tab, and cannot replace a list that already has a revision.
  if (revision === null) return applied === null;
  if (applied === null) return true;
  return revision > applied;
}

function rememberMembershipRevision(userId: string, revision: number | null) {
  appliedMembershipUserId = userId;
  appliedMembershipRevision = revision;
}

type AuthMessage =
  | { type: "logout"; epoch: Epoch }
  | { type: "refresh"; epoch: Epoch; data: Session }
  | {
      type: "workspaces";
      epoch: Epoch;
      data: {
        userId: string;
        workspaces: WorkspaceMembership[];
        membershipRevision?: number;
      };
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

// The sessions still recorded as signed out (see pending-sign-out.ts) when
// this tab's sign-in was about to be sent. Its response replaces the cookie,
// so this browser can no longer restore those sessions, and setAuth removes
// their records. Only these: a record written later, for example by another
// tab that signed in and out again meanwhile, may name the session the cookie
// holds by the time the response is applied.
let recordedBeforeSignIn: string[] = [];

/**
 * Settles once no sign-out or refresh, in this tab or another, can still set
 * or clear the session cookie: when those requests have finished or reached
 * their deadline. A new sign-in waits for it, so its cookie is the last set.
 *
 * It also completes, while the cookie is still theirs, sign-outs that have
 * not reached the server: the sign-in that follows replaces the cookie, after
 * which this browser can no longer revoke those sessions. Every sign-in calls
 * it immediately before sending its request.
 */
export async function whenLoggedOut(): Promise<void> {
  await (pendingLogout ?? Promise.resolve());
  await whenCookieRequestsSettle();
  await settlePendingSignOuts();
  recordedBeforeSignIn = pendingSignOuts().map((record) => record.sessionId);
}

/** Waits (bounded) until no tab has a cookie-setting request in flight. */
async function whenCookieRequestsSettle() {
  const giveUpAt = Date.now() + LOGOUT_TIMEOUT_MS;
  while (Date.now() < Math.min(busyUntil(), giveUpAt)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Counts the sign-outs this tab has made or accepted from another tab. A tab
// still loading stops trying to restore a session once it sees one.
let signOuts = 0;

const LOGOUT_REFRESH_RETRY_DELAYS_MS = [250, 500, 1000, 2000];

/**
 * Revokes the session being signed out. Its pending record (see
 * pending-sign-out.ts) is removed once the server has settled the sign-out;
 * otherwise a later page load completes it.
 */
async function revokeSession(
  accessToken: string | null,
  userId: string,
  sessionId: string | null,
  logoutEpoch: Epoch,
) {
  const controller = new AbortController();
  // Another tab announced a newer sign-in or sign-out: the cookie may now
  // belong to that session, which this sign-out must not touch.
  const overtaken = () => compareEpochs(knownEpoch, logoutEpoch) > 0;
  // keepalive: the UI is already signed out, so the user may close or reload
  // the tab at once; the revocation must still reach the server.
  const signOut = (token: string | null) =>
    fetch(apiUrl("auth/logout"), {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
  const refreshCookie = () =>
    fetch(apiUrl("auth/refresh"), {
      method: "POST",
      credentials: "include",
      keepalive: true,
      signal: controller.signal,
    });
  // Resolves true once the server has settled the sign-out: this browser can
  // no longer restore the session (see completeSignOuts).
  const revoke = async (): Promise<boolean> => {
    let res = await signOut(accessToken);
    // An expired session token can now settle logout itself, even where
    // origin-bound recovery is unavailable. Retry lock/rate-limit contention
    // within the existing deadline, without touching a newer announced login.
    if (sessionId) {
      for (const delay of RECOVERY_RETRY_DELAYS_MS) {
        if ((res.status !== 503 && res.status !== 429) || overtaken() || controller.signal.aborted) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (overtaken() || controller.signal.aborted) return false;
        res = await signOut(accessToken);
      }
    }
    if (res.ok) return true;
    if (res.status !== 401) return false;
    // An older server may reject the expired token. Ask it to end only the
    // selected family, without replacing or ending a newer browser sign-in.
    if (sessionId) {
      const recovery = await recoverSession(sessionId, controller.signal);
      return recovery !== "unsettled";
    }
    // A token without a session id (from an earlier server): exchange the
    // cookie for a token, without signing this tab back in, and sign out with
    // that, unless the cookie now belongs to another account (signed in from
    // another tab meanwhile). A cookie that another tab has just rotated
    // (409) or a busy session (503) is retried with the browser's current
    // cookie, within the deadline. No sign-out is recorded for such a token.
    if (overtaken()) return false;
    let refreshed = await refreshCookie();
    for (const delay of LOGOUT_REFRESH_RETRY_DELAYS_MS) {
      if (!retryable(refreshed) || overtaken()) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (overtaken()) return false;
      refreshed = await refreshCookie();
    }
    if (!refreshed.ok || overtaken()) return false;
    const body = (await refreshed.json()) as {
      data?: { user?: { id?: string }; accessToken?: string };
    };
    if (body.data?.user?.id !== userId || !body.data.accessToken) return false;
    if (overtaken()) return false;
    await signOut(body.data.accessToken);
    return false;
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
    const settled = await cookieRequest(() =>
      Promise.race([revoke(), deadline]),
    );
    if (settled === true && sessionId) clearPendingSignOut(sessionId);
  } catch {
    // Local state is already cleared; the network may be unavailable. The
    // pending record remains for the next page load.
  } finally {
    clearTimeout(timer);
  }
}

// ─── Unfinished sign-outs ────────────────────────────────
//
// A sign-out is recorded in localStorage before its request is sent and the
// record is removed once the server has settled it (pending-sign-out.ts).
// Before restoring a session, a page load (and a sign-in, before it replaces
// the cookie) completes the sign-outs still recorded, in any tab:
//
// - POST auth/logout/recover asks the server to revoke the recorded session
//   only if the cookie this browser sends now belongs to it. It never sets or
//   clears the cookie, and it settles the record: "revoked" (the cookie is now
//   useless, so nothing is restored), "superseded" (the cookie belongs to a
//   newer sign-in, which is left alone; the recorded session can no longer be
//   restored from here) or "absent" (the cookie holds no session).
// - A busy server (503/429) is retried within the deadline. Any other answer
//   (unreachable, refused, failed) leaves the record for a later load, and
//   this load restores nothing. Nothing that sets or clears the cookie is
//   sent to settle a record: a refresh or an ordinary logout could replace or
//   end a sign-in that lands meanwhile (such as a single sign-on callback).
// - A password sign-in or registration replaces the cookie, so the records
//   that existed when its request was sent are then removed (see setAuth):
//   this browser can no longer restore those sessions, and the new session is
//   not held back by them.

/**
 * "clear": nothing is left to complete and a session may be restored;
 * "revoked": the cookie's session was just revoked; "pending": a sign-out
 * could not be completed, and no session may be restored now.
 */
type Settlement = "clear" | "revoked" | "pending";
type Recovery = "revoked" | "superseded" | "absent" | "unsettled";

const RECOVERY_RETRY_DELAYS_MS = [250, 500, 1000, 2000];
let settling: Promise<Settlement> | null = null;

/** Completes the sign-outs recorded in this browser (bounded; never rejects). */
function settlePendingSignOuts(): Promise<Settlement> {
  // One run at a time per tab; a run may still be finishing a record it has
  // already removed.
  if (!settling && pendingSignOuts().length === 0)
    return Promise.resolve("clear");
  settling ??= (async () => {
    // A sign-out still running in some tab settles its own record.
    await whenCookieRequestsSettle();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Settlement>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("pending");
      }, LOGOUT_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        completeSignOuts(controller.signal),
        deadline,
      ]);
    } catch {
      return "pending";
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => {
    settling = null;
  });
  return settling;
}

async function completeSignOuts(signal: AbortSignal): Promise<Settlement> {
  let revoked = false;
  for (const record of pendingSignOuts()) {
    const recovery = await recoverSession(record.sessionId, signal);
    if (recovery === "unsettled") continue;
    clearPendingSignOut(record.sessionId);
    if (recovery === "revoked") revoked = true;
  }
  if (revoked) return "revoked";
  // Includes a sign-out another tab recorded meanwhile.
  return pendingSignOuts().length === 0 ? "clear" : "pending";
}

async function recoverSession(
  sessionId: string,
  signal: AbortSignal,
): Promise<Recovery> {
  // keepalive: the user may close or leave the page meanwhile. A browser that
  // cannot send it (a cross-origin API needs a preflight) is asked again
  // without it.
  const send = async (keepalive: boolean) => {
    try {
      return await fetch(apiUrl("auth/logout/recover"), {
        method: "POST",
        credentials: "include",
        keepalive,
        headers: {
          "Content-Type": "application/json",
          "X-Werkyn-Session-Recovery": "1",
        },
        body: JSON.stringify({ sessionId }),
        signal,
      });
    } catch {
      return null;
    }
  };
  for (let attempt = 0; ; attempt++) {
    const res =
      (await send(true)) ?? (signal.aborted ? null : await send(false));
    if (!res) return "unsettled";
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as {
        data?: { status?: unknown };
      } | null;
      const status = body?.data?.status;
      return status === "revoked" ||
        status === "superseded" ||
        status === "absent"
        ? status
        : "unsettled";
    }
    if (res.status !== 503 && res.status !== 429) return "unsettled";
    const delay = RECOVERY_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return "unsettled";
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (signal.aborted) return "unsettled";
  }
}

// ─── Store ────────────────────────────────────────────────

export const useAuthStore = create<AuthState>((set, get) => {
  /**
   * Applies a session. The access token is always stored. A same-account
   * workspace list is stored only when its membership revision is newer, so a
   * sign-in snapshot cannot erase a join that was applied while it was in
   * flight. An account change replaces the list.
   */
  function applySession(session: Session, epoch: Epoch) {
    // A late sign-in can leave one family in memory while another family's
    // cookie is in the browser. Check the returned family, not only the one
    // this tab held before refreshing, and never publish a signed-out one.
    if (hasPendingSignOut(sessionIdOf(session.accessToken))) {
      endSession(epoch);
      return false;
    }
    const revision = membershipRevisionOf(session.membershipRevision);
    const sameUser = get().user?.id === session.user.id;
    // A same-account sign-in still loses to a newer list already applied.
    // Only an account change replaces the list without comparing revisions.
    const replaceWorkspaces =
      !sameUser || isNewerMembershipRevision(session.user.id, revision);
    const workspaces = replaceWorkspaces ? session.workspaces : get().workspaces;
    if (replaceWorkspaces) rememberMembershipRevision(session.user.id, revision);
    const announcedRevision = replaceWorkspaces
      ? revision
      : appliedMembershipRevision;
    supersededSince = null;
    set({
      user: session.user,
      accessToken: session.accessToken,
      workspaces,
    });
    announce({
      type: "refresh",
      epoch,
      data: {
        user: session.user,
        accessToken: session.accessToken,
        workspaces,
        ...(announcedRevision !== null
          ? { membershipRevision: announcedRevision }
          : {}),
      },
    });
    return true;
  }

  /** Clears the session here and tells other tabs at `epoch` or older. */
  function endSession(epoch: Epoch) {
    signOuts += 1;
    abortRefreshes();
    lastRefreshTime = 0;
    supersededSince = null;
    appliedMembershipUserId = null;
    appliedMembershipRevision = null;
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
      signOuts += 1;
      abortRefreshes();
      lastRefreshTime = 0;
      supersededSince = null;
      appliedMembershipUserId = null;
      appliedMembershipRevision = null;
      set({ user: null, accessToken: null, workspaces: [], isHydrated: true });
      wakeRefreshWaiters();
    } else if (message.type === "refresh" && message.data) {
      const { user, accessToken, workspaces } = message.data;
      // Unordered (earlier build): it may only renew this account's token.
      if (legacy && get().user?.id !== user.id) return;
      const sessionId = sessionIdOf(accessToken);
      if (hasPendingSignOut(sessionId)) {
        if (sessionIdOf(get().accessToken) === sessionId)
          get().expireSession(identityGeneration());
        wakeRefreshWaiters();
        return;
      }
      const revision = membershipRevisionOf(message.data.membershipRevision);
      const sameUser = get().user?.id === user.id;
      const replaceWorkspaces =
        !sameUser || isNewerMembershipRevision(user.id, revision);
      if (replaceWorkspaces) rememberMembershipRevision(user.id, revision);
      lastRefreshTime = Date.now();
      supersededSince = null;
      set({
        user,
        accessToken,
        workspaces: replaceWorkspaces ? workspaces : get().workspaces,
      });
      wakeRefreshWaiters();
    } else if (message.type === "workspaces" && message.data) {
      const { userId, workspaces } = message.data;
      const revision = membershipRevisionOf(message.data.membershipRevision);
      // Memberships of one account; ignored by tabs signed in as another,
      // and ignored when this revision is not newer than the applied one.
      let applied = false;
      set((state) => {
        if (state.user?.id !== userId) return state;
        if (!isNewerMembershipRevision(userId, revision)) return state;
        applied = true;
        return { workspaces };
      });
      if (applied) rememberMembershipRevision(userId, revision);
    }
  });

  return {
    user: null,
    accessToken: null,
    workspaces: [],
    isHydrated: false,
    _refreshPromise: null,

    setAuth: (user, accessToken, workspaces, membershipRevision) => {
      // The sign-in's response replaced the cookie: sign-outs recorded before
      // its request was sent can no longer be completed from this browser,
      // and their sessions can no longer be restored here.
      const sessionId = sessionIdOf(accessToken);
      for (const recorded of recordedBeforeSignIn) {
        if (recorded !== sessionId) clearPendingSignOut(recorded);
      }
      recordedBeforeSignIn = [];
      // A sign-in is newer than anything announced before it.
      applySession(
        { user, accessToken, workspaces, membershipRevision },
        advanceEpoch(Date.now()),
      );
    },

    setWorkspaces: (workspaces) => {
      set({ workspaces });
    },

    // Applies committed memberships returned for one account, only while that
    // account is signed in here and the revision is newer than the list
    // already applied, and shares them with its other open tabs.
    setWorkspacesForUser: (userId, workspaces, membershipRevision) => {
      const revision = membershipRevisionOf(membershipRevision);
      let applied = false;
      set((state) => {
        if (state.user?.id !== userId) return state;
        if (!isNewerMembershipRevision(userId, revision)) return state;
        applied = true;
        return { workspaces };
      });
      if (!applied) return false;
      rememberMembershipRevision(userId, revision);
      announce({
        type: "workspaces",
        epoch: knownEpoch,
        data: {
          userId,
          workspaces,
          ...(revision !== null ? { membershipRevision: revision } : {}),
        },
      });
      return true;
    },

    logout: () => {
      const { user, accessToken } = get();
      const sessionId = sessionIdOf(accessToken);
      // Recorded before anything is sent: if the revocation below fails or
      // never finishes, the next page load, in any tab, completes it.
      if (user && sessionId) recordPendingSignOut(sessionId, user.id);
      const epoch = advanceEpoch(Date.now());
      endSession(epoch);
      if (!user) return pendingLogout ?? Promise.resolve();
      const revoking = revokeSession(accessToken, user.id, sessionId, epoch);
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
      // Another tab signed this session out, and this tab missed its
      // announcement: end it here instead of renewing it.
      if (hasPendingSignOut(sessionIdOf(get().accessToken))) {
        get().expireSession(identityGeneration());
        return false;
      }
      // If another tab refreshed recently, skip
      if (Date.now() - lastRefreshTime < 5000) {
        return !!get().accessToken;
      }
      // Without a session here, a sign-out or refresh still running in another
      // tab decides whether the shared cookie is valid: let it finish first, so
      // that a cookie about to be revoked does not sign this tab in. A sign-out
      // that never reached the server is completed first, and while it cannot
      // be, no session is restored.
      if (!get().user) {
        await whenCookieRequestsSettle();
        if ((await settlePendingSignOuts()) !== "clear") return false;
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
          return applySession(session, epoch);
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
      const signOutsAtStart = signOuts;
      // A sign-out announced after this page started loading is final for it:
      // retrying would sign the account back in, in every tab, if that
      // sign-out's revocation has not reached the server yet.
      const signedOutSinceStart = () => signOuts !== signOutsAtStart;

      // A sign-out this browser has not completed comes first. A session is
      // restored only once none is left: when the cookie's session was just
      // revoked, or a sign-out cannot be completed now, nothing is.
      if ((await settlePendingSignOuts()) !== "clear") attempts = maxAttempts;

      while (attempts < maxAttempts) {
        const success = await get().refresh();
        if (success) break;
        attempts++;
        if (signedOutSinceStart()) break;
        if (attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1000));
          if (signedOutSinceStart()) break;
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
  // A revision stamped for this account, just before the set, is kept.
  // Every other identity change drops the previous account's revision.
  if (appliedMembershipUserId !== userId) {
    appliedMembershipUserId = userId;
    appliedMembershipRevision = null;
  }
  changeIdentity(previousUserId, userId);
  wakeRefreshWaiters();
});

/** Completes only the SSO attempt whose signed proof matches this cookie. */
export async function completeOidcSignIn(): Promise<boolean> {
  const attempt = oidcSignInAttempt();
  if (!attempt) return useAuthStore.getState().refresh();
  const start: RefreshStart = { generation: identityGeneration(), epoch: knownEpoch };
  const alreadyRestored = () => {
    clearOidcSignIn(attempt.attemptId);
    const token = useAuthStore.getState().accessToken;
    // No new restore request and no record retirement without proof. Hydration
    // may already hold a session; keep it only when that session is not pending.
    return !isStale(start) && !!token && !hasPendingSignOut(sessionIdOf(token));
  };
  try {
    const response = await fetch(apiUrl("auth/oidc/complete-session"), {
      // This read changes no cookie or family. Let it finish across a same-
      // family broadcast; its response is checked against the current identity.
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", "X-Werkyn-OIDC-Completion": "1" },
      body: JSON.stringify({ attemptId: attempt.attemptId }),
    });
    if (!response.ok) return alreadyRestored();
    const body = (await response.json()) as { data?: Session };
    const session = body.data;
    if (!session || typeof session.user?.id !== "string" ||
        !Array.isArray(session.workspaces) || !sessionIdOf(session.accessToken)) return alreadyRestored();
    const sessionId = sessionIdOf(session.accessToken)!;
    if (isStale(start)) {
      const current = useAuthStore.getState();
      if (current.user?.id !== session.user.id ||
          sessionIdOf(current.accessToken) !== sessionId || hasPendingSignOut(sessionId)) return false;
      // Another tab already adopted this exact proven family. Keep its newer
      // token and epoch, and retire only the pre-redirect sign-out snapshot.
      for (const recorded of attempt.sessionIds) {
        if (recorded !== sessionId) clearPendingSignOut(recorded);
      }
      clearOidcSignIn(attempt.attemptId);
      return true;
    }
    // Proof of a new completed sign-in replaces only its pre-redirect records.
    // A sign-out made while that request was in flight remains authoritative.
    recordedBeforeSignIn = attempt.sessionIds;
    useAuthStore.getState().setAuth(
      session.user,
      session.accessToken,
      session.workspaces,
      session.membershipRevision,
    );
    clearOidcSignIn(attempt.attemptId);
    return useAuthStore.getState().accessToken === session.accessToken;
  } catch {
    return alreadyRestored();
  }
}
