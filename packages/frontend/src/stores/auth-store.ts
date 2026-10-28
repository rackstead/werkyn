import { create } from "zustand";

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
  logout: () => Promise<void>;
  refresh: () => Promise<boolean>;
  hydrate: () => Promise<void>;
}

// BroadcastChannel for cross-tab sync
const channel =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("pm-auth")
    : null;

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

function supersededTooLong() {
  return (
    supersededSince !== null &&
    Date.now() - supersededSince >= SUPERSEDED_BUDGET_MS
  );
}

async function requestRefresh() {
  const sentAt = Date.now();
  const res = await fetch("/api/auth/refresh", {
    method: "POST",
    credentials: "include",
  });
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

export const useAuthStore = create<AuthState>((set, get) => {
  // Listen for cross-tab messages
  channel?.addEventListener("message", (event) => {
    const { type, data } = event.data;
    if (type === "logout") {
      set({ user: null, accessToken: null, workspaces: [], isHydrated: true });
    } else if (type === "refresh") {
      lastRefreshTime = Date.now();
      supersededSince = null;
      set({
        user: data.user,
        accessToken: data.accessToken,
        workspaces: data.workspaces,
      });
      for (const wake of [...broadcastWaiters]) wake();
    } else if (type === "workspaces") {
      // Memberships of one account; ignored by tabs signed in as another.
      set((state) =>
        state.user?.id === data.userId ? { workspaces: data.workspaces } : state,
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
      supersededSince = null;
      set({ user, accessToken, workspaces });
      channel?.postMessage({
        type: "refresh",
        data: { user, accessToken, workspaces },
      });
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
        channel?.postMessage({ type: "workspaces", data: { userId, workspaces } });
      return applied;
    },

    logout: async () => {
      try {
        await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "include",
          headers: {
            Authorization: `Bearer ${get().accessToken}`,
          },
        });
      } catch {
        // Ignore errors during logout
      }
      set({ user: null, accessToken: null, workspaces: [] });
      channel?.postMessage({ type: "logout" });
    },

    refresh: async () => {
      // If another tab refreshed recently, skip
      if (Date.now() - lastRefreshTime < 5000) {
        return !!get().accessToken;
      }

      // Mutex: reuse existing refresh promise
      const existing = get()._refreshPromise;
      if (existing) return existing;
      // Checked before the mutex promise exists: a synchronous result inside
      // it would leave a settled promise behind as the "pending" refresh.
      if (supersededTooLong()) return false;

      const promise = (async () => {
        try {
          const startedAt = Date.now();
          let res = await requestRefresh();
          for (const delay of SUPERSEDED_RETRY_DELAYS_MS) {
            if (!retryable(res)) break;
            await waitForBroadcast(delay);
            if (lastRefreshTime > startedAt && get().accessToken) {
              supersededSince = null;
              return true;
            }
            if (supersededTooLong()) return false;
            res = await requestRefresh();
          }

          if (!res.ok) return false;

          const body = await res.json();
          const { user, accessToken, workspaces } = body.data;
          lastRefreshTime = Date.now();
          set({ user, accessToken, workspaces });
          channel?.postMessage({
            type: "refresh",
            data: { user, accessToken, workspaces },
          });
          return true;
        } catch {
          return false;
        } finally {
          set({ _refreshPromise: null });
        }
      })();

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
