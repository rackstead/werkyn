import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { UpdateWikiPageInput } from "@pm/shared";
import { useAuthStore } from "@/stores/auth-store";
import type { useEntityAutosave } from "@/hooks/use-entity-autosave";
import { queryKeys } from "@/lib/query-keys";
import { markWikiPageAvailability, type useWikiPage } from "../api";

type Autosave = ReturnType<typeof useEntityAutosave<Omit<UpdateWikiPageInput, "expectedRevision">>>;
type Flush = Autosave["flush"];
interface Owner { token: symbol; active: boolean; notify: () => void }
interface Barrier { ready: boolean }
interface Resume { owner: Owner; epoch: number; ready: boolean; consumed: boolean }
interface QueueOwnership { owner?: Owner; terminal?: Barrier; resume?: Resume }
// The existing queue, not a page-ID store, owns settlement across remounts.
// No draft/document fields are copied into these records.
const queues = new WeakMap<Flush, QueueOwnership>();
function ownership(flush: Flush) {
  let value = queues.get(flush);
  if (!value) { value = {}; queues.set(flush, value); }
  return value;
}
function retire(flush: Flush) {
  const queue = ownership(flush);
  if (queue.terminal) return;
  const barrier: Barrier = { ready: false };
  queue.terminal = barrier;
  queue.resume = undefined;
  queue.owner?.notify();
  // The fence is closed before joining the old operation. In-flight A may
  // ACK, but no pending B can leave. Park only after the whole queue settles.
  void flush().catch(() => {}).then(() => {
    if (queue.terminal !== barrier) return;
    barrier.ready = true;
    queue.owner?.notify();
  });
}

function retirementBridge(flush: Flush) {
  const weak = new WeakRef(flush);
  return () => { const current = weak.deref(); if (current) retire(current); };
}

export function useWikiPageAvailability({ pageId, workspaceId, userId, pageQuery, autosave, isLocked }: {
  pageId: string; workspaceId: string; userId: string;
  pageQuery: ReturnType<typeof useWikiPage>; autosave: Autosave; isLocked: () => boolean;
}) {
  const client = useQueryClient();
  const queue = ownership(autosave.flush);
  const [, notify] = useReducer((n: number) => n + 1, 0);
  const [documentVersion, remount] = useReducer((n: number) => n + 1, 0);
  const committed = useRef(autosave);
  const currentOwner = useRef<Owner | undefined>(undefined);
  const owner = pageQuery.ownership;
  const phase = pageQuery.availability;
  const epoch = owner?.state.epoch;

  useLayoutEffect(() => { committed.current = autosave; });
  useLayoutEffect(() => {
    const lifetime: Owner = { token: Symbol("wiki-availability-owner"), active: true, notify };
    queue.owner = lifetime;
    currentOwner.current = lifetime;
    if (queue.resume?.owner !== lifetime) queue.resume = undefined;
    if (owner) {
      // This bridge belongs to the queue, not this component's lifetime.
      // Its weak reference survives an inactive cached page without retaining
      // another draft or an old owner callback.
      owner.state.retire = retirementBridge(autosave.flush);
      if (owner.state.phase === "unavailable") retire(autosave.flush);
    }
    notify();
    return () => {
      lifetime.active = false;
      if (queue.owner === lifetime) queue.owner = undefined;
      if (currentOwner.current === lifetime) currentOwner.current = undefined;
    };
  }, [queue, owner?.query, pageId, workspaceId, userId, autosave.flush]);

  useEffect(() => {
    if (!owner || phase !== "checking") return;
    let active = true;
    const expected = owner.state.epoch;
    void (async () => {
      await client.cancelQueries({ queryKey: queryKeys.wikiPage(pageId), exact: true }, { revert: false });
      if (!active || owner.state.epoch !== expected || owner.state.phase !== "checking" ||
          client.getQueryCache().find({ queryKey: queryKeys.wikiPage(pageId), exact: true }) !== owner.query) return;
      await pageQuery.refetch({ cancelRefetch: true });
    })().catch(() => {});
    return () => { active = false; };
  }, [client, owner?.query, epoch, phase, pageId, pageQuery.refetch]);

  useLayoutEffect(() => {
    const lifetime = currentOwner.current;
    if (!lifetime?.active || queue.owner !== lifetime || useAuthStore.getState().user?.id !== userId) return;
    const barrier = queue.terminal;
    if (barrier) {
      if (!barrier.ready) return;
      // Still fenced, so these can only be the retiring remainder. A stale
      // completion never calls park on a newer lifetime's live changes.
      committed.current.park();
      if (queue.terminal !== barrier || queue.owner !== lifetime) return;
      queue.terminal = undefined;
      remount();
      notify();
      return;
    }
    if (!owner || owner.state.phase !== "available" || !owner.state.needsResume) return;
    let resume = queue.resume;
    if (!resume || resume.owner !== lifetime || resume.epoch !== owner.state.epoch) {
      resume = { owner: lifetime, epoch: owner.state.epoch, ready: false, consumed: false };
      queue.resume = resume;
      const operation = resume;
      // Joining while needsResume is still closed also handles a debounce
      // that already expired and published a blocked error.
      void committed.current.flush().catch(() => {}).then(() => {
        if (queue.resume !== operation) return;
        operation.ready = true;
        queue.owner?.notify();
      });
      return;
    }
    if (!resume.ready || resume.consumed || queue.resume !== resume || queue.owner !== lifetime ||
        client.getQueryCache().find({ queryKey: queryKeys.wikiPage(pageId), exact: true }) !== owner.query) return;
    const snapshot = committed.current;
    if (snapshot.hasUnsavedChanges && !isLocked()) return;
    resume.consumed = true;
    owner.state.needsResume = false;
    notify();
    if (snapshot.hasUnsavedChanges && !snapshot.conflict) void snapshot.flush().catch(() => {});
  });

  const canWrite = () => {
    // Available-page unmount flushes remain valid for their captured page.
    // Only continuation election needs a mounted owner; the shared fences
    // still stop a retired/checking queue after its component has closed.
    return useAuthStore.getState().user?.id === userId && isLocked() &&
      !!owner && client.getQueryCache().find({ queryKey: queryKeys.wikiPage(pageId), exact: true }) === owner.query &&
      owner.state.phase === "available" && !owner.state.needsResume && !queue.terminal;
  };
  return {
    canWrite,
    terminal: phase === "unavailable" || !!queue.terminal,
    readOnly: phase !== "available" || !!owner?.state.needsResume || !!queue.terminal,
    failed: phase === "failed",
    documentVersion,
    retryRead: () => markWikiPageAvailability(client, pageId, "checking"),
  };
}
