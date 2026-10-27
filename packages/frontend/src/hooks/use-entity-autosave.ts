import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { AutosaveQueue } from "@/lib/autosave-queue";

const queues = new Map<
  string,
  { queue: unknown; hasUnsavedChanges: () => boolean }
>();

function hasUnsavedChanges() {
  return [...queues.values()].some((entry) => entry.hasUnsavedChanges());
}

// Failed drafts can outlive an editor. Keep the browser's unload protection active
// for those drafts too; a component's own effect would disappear on navigation.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

export function useEntityAutosave<T extends object>(
  entityKey: string,
  save: (patch: T) => Promise<unknown>,
  delay = 800,
) {
  const queue = useMemo(() => {
    let existing = queues.get(entityKey)?.queue as AutosaveQueue<T> | undefined;
    if (!existing) {
      const created = new AutosaveQueue<T>(
        save,
        delay,
        (_error, retry) => {
          toast.error(
            "Your changes couldn't be saved. Retry before closing this tab.",
            {
              duration: Infinity,
              action: {
                label: "Retry",
                onClick: () => {
                  void retry().catch(() => {});
                },
              },
            },
          );
        },
        () => {
          if (queues.get(entityKey)?.queue === created)
            queues.delete(entityKey);
        },
      );
      existing = created;
      queues.set(entityKey, {
        queue: created,
        hasUnsavedChanges: () => created.getSnapshot().hasUnsavedChanges,
      });
    }
    return existing;
  }, [entityKey]);
  queue.setSave(save);
  const subscribe = useCallback(
    (listener: () => void) => {
      // React can unsubscribe/re-subscribe the same mounted queue (StrictMode).
      // Re-register it so failed drafts retain unload protection and recovery.
      queues.set(entityKey, {
        queue,
        hasUnsavedChanges: () => queue.getSnapshot().hasUnsavedChanges,
      });
      return queue.subscribe(listener);
    },
    [entityKey, queue],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    queue.getSnapshot,
    queue.getSnapshot,
  );

  useEffect(
    () => () => {
      // Capture this queue, not an observer whose options can now target another ID.
      void queue.flush().catch(() => {});
    },
    [queue],
  );

  return { ...snapshot, schedule: queue.schedule, flush: queue.flush };
}
