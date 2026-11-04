import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { AutosaveQueue, advanceOwnRevision, recordOwnRevision, type OwnRevisionSpan, type SaveFn } from "@/lib/autosave-queue";
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

// Entries exist only while outside writes are pending, across every mounted
// writer for the same author/entity. An idle page adds no retained global cache.
const outsideWrites = new Map<string, { tail: Promise<void>; ownSpan?: OwnRevisionSpan }>();

/**
 * Runs a write of an entity made outside its editor, such as a rename from the
 * page tree, between the editor's saves (see AutosaveQueue.writeAlongside).
 * Rejects with PendingEditsError, without writing, when the editor's pending
 * edits cannot be stored first.
 */
export async function writeAlongsideAutosave(
  entityKey: string,
  write: (baseRevision?: number) => Promise<number | undefined>,
  capturedBase?: number,
) {
  let owner = outsideWrites.get(entityKey);
  if (!owner) {
    owner = { tail: Promise.resolve() };
    outsideWrites.set(entityKey, owner);
  }
  const state = owner;
  const operation = state.tail.then(async () => {
    // Resolve after the previous writer: an editor may have mounted/unmounted.
    const queue = queues.get(entityKey)?.queue as AutosaveQueue<object> | undefined;
    const base = advanceOwnRevision(state.ownSpan, capturedBase);
    let appliedBase: number | undefined, acknowledged: number | undefined;
    const perform = async (revision?: number) => {
      appliedBase = revision;
      acknowledged = await write(revision);
      return acknowledged;
    };
    if (queue) await queue.writeAlongside(perform, base);
    else await perform(base);
    state.ownSpan = recordOwnRevision(state.ownSpan, appliedBase, acknowledged);
  });
  const settled = operation.then(() => {}, () => {});
  state.tail = settled;
  try { await operation; }
  finally {
    if (outsideWrites.get(entityKey) === state && state.tail === settled) outsideWrites.delete(entityKey);
  }
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
