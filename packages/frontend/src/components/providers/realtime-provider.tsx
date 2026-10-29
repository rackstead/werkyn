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
      // The session behind the token expired or ended (4004/4005). One
      // refresh yields a token that rebuilds this client, or signs out.
      onSessionEnded: () => {
        const auth = useAuthStore.getState();
        void auth.refresh().then((refreshed) => {
          if (!refreshed) return auth.logout();
        });
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
