import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { WebSocketClient } from "@/lib/websocket-client";
import { useAuthStore } from "@/stores/auth-store";
import { queryClient } from "@/lib/query-client";
import { apiWebSocketUrl } from "@/lib/api-url";
import { onIdentityChange } from "@/lib/identity";

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

  useEffect(() => {
    if (!accessToken) {
      setClient((prev) => {
        prev?.disconnect();
        return null;
      });
      return;
    }

    const wsClient = new WebSocketClient({
      url: apiWebSocketUrl(),
      getToken: () => useAuthStore.getState().accessToken,
      onReconnect: () => {
        // Invalidate all queries to catch missed events
        queryClient.invalidateQueries();
      },
      // The session behind the token expired (4004) or ended (4005). One
      // refresh yields a token that rebuilds this client. An ended session
      // that cannot be refreshed signs out, unless another tab supplied a new
      // token meanwhile. After an expiry a failed refresh may be transient,
      // so sign-out is left to the HTTP 401 path.
      onSessionEnded: async (code) => {
        const auth = useAuthStore.getState();
        if (await auth.refresh()) return;
        if (code === 4005 && useAuthStore.getState().accessToken === accessToken) {
          await auth.logout();
        }
      },
    });

    setClient(wsClient);
    wsClient.connect();
    // The socket is authenticated as the identity that opened it. Close it as
    // soon as the identity changes, before React unmounts this provider, so
    // no further event for the previous account reaches the caches.
    const stopOnIdentityChange = onIdentityChange(() => wsClient.disconnect());

    return () => {
      stopOnIdentityChange();
      wsClient.disconnect();
      setClient(null);
    };
  }, [accessToken]);

  return (
    <RealtimeContext.Provider value={client}>
      {children}
    </RealtimeContext.Provider>
  );
}
