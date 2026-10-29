import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { AutosaveQueue, type SaveFn } from "@/lib/autosave-queue";
import { useAuthStore } from "@/stores/auth-store";

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

/**
 * Runs a write of an entity made outside its editor, such as a rename from the
 * page tree, after the editor's pending saves have been stored. The editor's
 * later saves are then based on that write's revision when nothing else was
 * written in between, so it is not reported as a conflict.
 */
export async function writeAlongsideAutosave(
  entityKey: string,
  write: () => Promise<number | undefined>,
) {
  const queue = () =>
    queues.get(entityKey)?.queue as AutosaveQueue<object> | undefined;
  await queue()?.flush().catch(() => {});
  const revision = await write();
  queue()?.acknowledgeRevision(revision);
}

function retained<T extends object>(queue: AutosaveQueue<T>) {
  const snapshot = queue.getSnapshot();
  return snapshot.hasUnsavedChanges || snapshot.parked !== undefined;
}

export interface EntityAutosaveOptions {
  /** The signed-in user whose edits this queue holds. */
  author: string;
  /** Why nothing may be sent right now (for example, no page lock), or null. */
  canSave?: () => string | null;
  /** Whether automatic flushes may resend a draft whose last attempt failed. */
  retryFailedAutomatically: boolean;
  /**
   * The stored revision of the entity as currently loaded, when the server
   * reports one. Saves are sent with the revision their edits are based on.
   */
  revision?: number;
  /** Whether a failed save is a conflict; its draft is then set aside. */
  isConflict?: (error: Error) => boolean;
  delay?: number;
}

export function useEntityAutosave<T extends object>(
  entityKey: string,
  save: SaveFn<T>,
  {
    author,
    canSave = () => null,
    retryFailedAutomatically,
    revision,
    isConflict,
    delay = 800,
  }: EntityAutosaveOptions,
) {
  const queue = useMemo(() => {
    let existing = queues.get(entityKey)?.queue as AutosaveQueue<T> | undefined;
    if (!existing) {
      // One notice per entity: repeated failures update it, a save clears it,
      // and it never stays on screen for a different signed-in user.
      const notice = `autosave:${entityKey}`;
      const authorSignedIn = () => useAuthStore.getState().user?.id === author;
      const created = new AutosaveQueue<T>(save, delay, {
        onError: (_error, retry) => {
          if (!authorSignedIn()) {
            toast.dismiss(notice);
            return;
          }
          toast.error(
            "Your changes couldn't be saved. Retry before closing this tab.",
            {
              id: notice,
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
        onIdle: () => {
          if (queues.get(entityKey)?.queue === created)
            queues.delete(entityKey);
        },
        onSaved: () => toast.dismiss(notice),
        onParked: (closed) => {
          toast.dismiss(notice);
          if (!closed || !authorSignedIn()) return;
          toast.error(
            "Some changes couldn't be saved. Reopen the item in this tab to restore or discard them.",
            { id: notice, duration: Infinity },
          );
        },
      });
      existing = created;
      queues.set(entityKey, {
        queue: created,
        hasUnsavedChanges: () => retained(created),
      });
    }
    return existing;
  }, [entityKey]);
  queue.setSave(save);
  queue.setPolicy({ canSave, retryFailedAutomatically, isConflict });
  const subscribe = useCallback(
    (listener: () => void) => {
      // React can unsubscribe/re-subscribe the same mounted queue (StrictMode).
      // Re-register it so failed drafts retain unload protection and recovery.
      queues.set(entityKey, {
        queue,
        hasUnsavedChanges: () => retained(queue),
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

  // An effect, like the editors' own content sync: a newer stored document
  // and the revision it is based on are taken in the same commit.
  useEffect(() => {
    queue.observeRevision(revision);
  }, [queue, revision, snapshot.hasUnsavedChanges]);

  return {
    ...snapshot,
    schedule: queue.schedule,
    flush: queue.flush,
    retry: queue.retry,
    discard: queue.discard,
    park: queue.park,
    restoreParked: queue.restoreParked,
    discardParked: queue.discardParked,
    adoptRevision: queue.adoptRevision,
  };
}
