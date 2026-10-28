import { useEffect } from "react";
import { useRealtimeClient } from "@/components/providers/realtime-provider";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { readText, type RealtimeEnvelope } from "@/lib/realtime-events";
import { toast } from "sonner";

export function useNotificationRealtime() {
  const client = useRealtimeClient();

  useEffect(() => {
    if (!client) return;

    // The lists and the unread count, in one pass (each refetches once);
    // preferences are not affected by a new notification.
    const refresh = () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.notifications,
        predicate: (query) =>
          query.queryKey[1] !== queryKeys.notificationPreferences[1],
      });
    };

    // Pushed to this user only; data is the stored notification.
    const onNew = (msg: RealtimeEnvelope) => {
      refresh();
      const title = readText(msg.data, "title");
      if (title) toast(title, { duration: 4000 });
    };

    client.on("notification_new", onNew);
    // Chat mentions and direct messages use this name for the same push.
    client.on("notification_created", refresh);

    return () => {
      client.off("notification_new", onNew);
      client.off("notification_created", refresh);
    };
  }, [client]);
}
