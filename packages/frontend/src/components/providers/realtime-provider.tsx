import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { WebSocketClient } from "@/lib/websocket-client";
import { useAuthStore } from "@/stores/auth-store";
import { queryClient } from "@/lib/query-client";
import { apiWebSocketUrl } from "@/lib/api-url";
import { identityGeneration, onIdentityChange } from "@/lib/identity";

const RealtimeContext = createContext<WebSocketClient | null>(null);

export function useRealtimeClient(): WebSocketClient | null {
  return useContext(RealtimeContext);
}

interface RealtimeProviderProps {
  children: ReactNode;
}

export function RealtimeProvider({ children }: RealtimeProviderProps) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [client, setClient] = useState<WebSocketClient | null>(null);
  const held = useRef<{
    client: WebSocketClient | null;
    stopIdentity: () => void;
  }>({ client: null, stopIdentity: () => {} });
  // Bumped on every run. A token rotation's cleanup leaves the client in
  // place only when a later run adopts it; unmount does not bump this.
  const life = useRef(0);

  useEffect(() => {
    const lifeId = ++life.current;

    const release = () => {
      held.current.stopIdentity();
      held.current.stopIdentity = () => {};
      held.current.client?.disconnect();
      held.current.client = null;
      setClient(null);
    };

    const cleanup = () => {
      const nextToken = useAuthStore.getState().accessToken;
      // A new token keeps this client. Sign-out and unmount do not.
      // The next run adopts it; if this provider unmounted instead,
      // nothing bumps `life` and the microtask still closes the socket.
      if (nextToken && nextToken !== accessToken) {
        queueMicrotask(() => {
          if (life.current === lifeId) release();
        });
        return;
      }
      release();
    };

    // A null token drops the socket. An access-token rotation does not:
    // getToken reads the store when the socket authenticates, and the
    // holders stay on this client. An identity change nulls `held` before
    // this effect runs, so that account does not keep the old client.
    if (!accessToken) {
      release();
      return;
    }

    if (held.current.client) {
      return cleanup;
    }

    release();

    // The identity this socket was opened for; a session close that arrives
    // after it changed concerns nobody here.
    const generation = identityGeneration();
    const wsClient = new WebSocketClient({
      url: apiWebSocketUrl(),
      getToken: () => useAuthStore.getState().accessToken,
      onReconnect: () => {
        // Invalidate all queries to catch missed events
        queryClient.invalidateQueries();
      },
      // The session behind the token expired (4004) or ended (4005). One
      // refresh lets this same client reconnect; it is not rebuilt. An ended
      // session that cannot be refreshed is expired locally (nothing is
      // revoked, and tabs already on a later sign-in ignore it), unless the
      // identity changed or another tab supplied a new token meanwhile. The
      // token compared here is the one in the store when the close was
      // handled, so an earlier rotation that kept this client does not look
      // like a foreign token. After an expiry a failed refresh may be
      // transient, so sign-out is left to the HTTP 401 path.
      onSessionEnded: async (code) => {
        if (identityGeneration() !== generation) return;
        const tokenAtClose = useAuthStore.getState().accessToken;
        if (await useAuthStore.getState().refresh()) return;
        if (code === 4005 && useAuthStore.getState().accessToken === tokenAtClose) {
          useAuthStore.getState().expireSession(generation);
        }
      },
    });

    held.current.client = wsClient;
    setClient(wsClient);
    wsClient.connect();
    // The socket is authenticated as the identity that opened it. Close it as
    // soon as the identity changes, before React unmounts this provider, so
    // no further event for the previous account reaches the caches. A new
    // token is not opened here: the effect above does that only when the
    // access token changes as well.
    held.current.stopIdentity = onIdentityChange(() => {
      if (held.current.client !== wsClient) return;
      held.current.stopIdentity();
      held.current.stopIdentity = () => {};
      wsClient.disconnect();
      held.current.client = null;
      setClient(null);
    });

    return cleanup;
  }, [accessToken]);

  return (
    <RealtimeContext.Provider value={client}>
      {children}
    </RealtimeContext.Provider>
  );
}
