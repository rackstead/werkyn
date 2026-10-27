import { useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import {
  useWikiPageLock,
  useAcquireWikiLock,
  useReleaseWikiLock,
  useHeartbeatWikiLock,
} from "../api";

// A rapid A→B→A can mount a new owner while A's old final save is still
// completing. Only the last mounted lifetime may release that user's lock.
interface LockLease {
  key: string;
  latest: symbol;
  active: Set<symbol>;
  acquisitions: Set<Promise<unknown>>;
  owned: boolean;
  releasing: Promise<void> | null;
}
const leases = new Map<string, LockLease>();

export function usePageLock(
  pageId: string,
  beforeRelease: () => Promise<void>,
) {
  const userId = useAuthStore((s) => s.user?.id);
  const { data: lockData, refetch } = useWikiPageLock(pageId);
  const { mutateAsync: acquireLock } = useAcquireWikiLock();
  const { mutateAsync: releaseLock } = useReleaseWikiLock();
  const { mutateAsync: heartbeat } = useHeartbeatWikiLock();
  const heartbeatInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(true);
  const owned = useRef(false);
  const currentLifetime = useRef<symbol | null>(null);
  const leaseRef = useRef<LockLease | null>(null);
  const leaseKey = `${userId ?? "anonymous"}:${pageId}`;

  const lock = lockData?.data ?? null;
  const isLockedByMe = lock !== null && lock.userId === userId;
  const isLockedByOther = lock !== null && lock.userId !== userId;
  useEffect(() => {
    owned.current = isLockedByMe;
    if (isLockedByMe && leaseRef.current?.key === leaseKey)
      leaseRef.current.owned = true;
  }, [isLockedByMe]);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);
    heartbeatInterval.current = null;
  }, []);

  const isCurrentUser = useCallback(
    () => !!userId && useAuthStore.getState().user?.id === userId,
    [userId],
  );
  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    const renew = () => {
      if (!isCurrentUser()) {
        stopHeartbeat();
        return;
      }
      void heartbeat({ pageId, expectedUserId: userId }).catch(() => {
        stopHeartbeat();
        toast.error(
          "The editing lock could not be renewed. Save your changes before continuing.",
        );
      });
    };
    renew();
    heartbeatInterval.current = setInterval(renew, 30_000);
  }, [heartbeat, isCurrentUser, pageId, stopHeartbeat]);

  // Reopening a page can recover an already-held lock; it needs the same
  // heartbeat as a freshly acquired lock, including an immediate renewal.
  useEffect(() => {
    if (isLockedByMe) startHeartbeat();
    else stopHeartbeat();
    return stopHeartbeat;
  }, [isLockedByMe, startHeartbeat, stopHeartbeat]);

  const performRelease = useCallback(
    async (lease: LockLease) => {
      // All retired lifetimes share one release, and only the latest cleanup can
      // elect it. This also coalesces overlapping Done/unmount cleanup.
      const operation =
        lease.releasing ?? releaseLock({ pageId, expectedUserId: userId });
      lease.releasing = operation;
      try {
        await operation;
        lease.owned = false;
      } finally {
        if (lease.releasing === operation) lease.releasing = null;
      }
    },
    [releaseLock, pageId, userId],
  );

  const acquire = useCallback(async () => {
    if (!isCurrentUser()) throw new Error("Sign in to edit this page");
    const lease = leaseRef.current;
    const lifetime = currentLifetime.current;
    if (!lease || lease.key !== leaseKey)
      throw new Error("Editor is not ready");
    const operation =
      lease.acquisitions.values().next().value ??
      acquireLock({ pageId, expectedUserId: userId });
    lease.acquisitions.add(operation);
    try {
      await operation;
      lease.owned = true;
      // The latest cleanup waits for pending acquisitions and owns any final
      // release. An old acquisition must not release a newly recovered lock.
      if (
        !isCurrentUser() ||
        !mounted.current ||
        currentLifetime.current !== lifetime
      )
        return;
      owned.current = true;
      startHeartbeat();
    } finally {
      lease.acquisitions.delete(operation);
    }
  }, [acquireLock, isCurrentUser, startHeartbeat, pageId, userId, leaseKey]);

  const release = useCallback(async () => {
    // Retain the lock and heartbeat until all queued saves are durable.
    const lease = leaseRef.current;
    if (lease) await Promise.allSettled([...lease.acquisitions]);
    await beforeRelease();
    if (!lease || (!owned.current && !lease.owned) || !isCurrentUser()) return;
    await performRelease(lease);
    owned.current = false;
    stopHeartbeat();
  }, [beforeRelease, performRelease, stopHeartbeat, isCurrentUser]);

  useEffect(() => {
    const lifetime = Symbol("wiki-lock-lifetime");
    const lease = leases.get(leaseKey) ?? {
      key: leaseKey,
      latest: lifetime,
      active: new Set<symbol>(),
      acquisitions: new Set<Promise<unknown>>(),
      owned: isLockedByMe,
      releasing: null,
    };
    lease.latest = lifetime;
    lease.active.add(lifetime);
    if (isLockedByMe) lease.owned = true;
    leases.set(leaseKey, lease);
    leaseRef.current = lease;
    currentLifetime.current = lifetime;
    mounted.current = true;
    return () => {
      mounted.current = false;
      lease.active.delete(lifetime);
      // Capture this lifetime's page ID and queue. Failed final saves retain the
      // draft, leave the lock to expire and offer retry instead of losing edits.
      void beforeRelease()
        .then(async () => {
          await Promise.allSettled([...lease.acquisitions]);
          if (lease.latest !== lifetime || lease.active.size) return;
          if (lease.owned && isCurrentUser()) await performRelease(lease);
          if (
            lease.latest === lifetime &&
            !lease.active.size &&
            leases.get(leaseKey) === lease
          ) {
            leases.delete(leaseKey);
          }
        })
        .catch(() => {})
        .finally(() => {
          // An effect replay can already have installed its next heartbeat.
          if (currentLifetime.current === lifetime) stopHeartbeat();
        });
    };
  }, [leaseKey, beforeRelease, performRelease, stopHeartbeat, isCurrentUser]);

  return {
    lock,
    isLockedByMe,
    isLockedByOther,
    acquire,
    release,
    refetch,
  };
}
