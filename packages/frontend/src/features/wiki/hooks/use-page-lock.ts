import { useEffect, useReducer, useRef, useCallback } from "react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { isIdentityChangedError } from "@/lib/api-error";
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
  // Until when this user's lock is known to be held. The server lets a lock
  // lapse two minutes after its last acquisition or renewal.
  confirmedUntil: number;
}
const leases = new Map<string, LockLease>();

const LOCK_MS = 2 * 60 * 1000;
// A lock read from the lock query is trusted only briefly, until this
// session's own renewal (sent immediately) answers.
const OBSERVED_LOCK_GRACE_MS = 15_000;

function lockIsGone(error: unknown) {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return status === 403 || status === 404 || status === 409;
}

export function usePageLock(
  pageId: string,
  beforeRelease: () => Promise<void>,
) {
  const userId = useAuthStore((s) => s.user?.id);
  const { data: lockData, refetch } = useWikiPageLock(pageId);
  const refetchLock = useRef(refetch);
  refetchLock.current = refetch;
  const { mutateAsync: acquireLock } = useAcquireWikiLock();
  const { mutateAsync: releaseLock } = useReleaseWikiLock();
  const { mutateAsync: heartbeat } = useHeartbeatWikiLock();
  const heartbeatInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(true);
  const owned = useRef(false);
  const currentLifetime = useRef<symbol | null>(null);
  const leaseRef = useRef<LockLease | null>(null);
  const leaseKey = `${userId ?? "anonymous"}:${pageId}`;
  const [, rerender] = useReducer((count: number) => count + 1, 0);

  const lock = lockData?.data ?? null;
  // The cached lock row says this user holds the lock...
  const lockHeld = lock !== null && lock.userId === userId;
  // ...but editing (and saving) also needs that to be confirmed recently enough
  // that the server cannot have let it lapse and handed it to someone else.
  // A remount of the same page (A→B→A) shares the earlier lifetime's lease.
  const knownLease =
    leaseRef.current?.key === leaseKey
      ? leaseRef.current
      : leases.get(leaseKey);
  const isLockedByMe =
    lockHeld && (knownLease?.confirmedUntil ?? 0) > Date.now();
  const isLockedByOther = lock !== null && lock.userId !== userId;
  useEffect(() => {
    owned.current = lockHeld;
    if (lockHeld && leaseRef.current?.key === leaseKey)
      leaseRef.current.owned = true;
  }, [lockHeld]);

  const confirmOwnership = useCallback((until: number) => {
    const lease = leaseRef.current;
    if (!lease) return;
    lease.confirmedUntil = Math.max(lease.confirmedUntil, until);
    rerender();
  }, []);
  const loseOwnership = useCallback(() => {
    const lease = leaseRef.current;
    if (!lease) return;
    lease.confirmedUntil = 0;
    rerender();
  }, []);

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
      const notice = `wiki-lock-renewal:${pageId}`;
      const started = Date.now();
      void heartbeat({ pageId, expectedUserId: userId }).then(
        () => {
          confirmOwnership(started + LOCK_MS);
          toast.dismiss(notice);
        },
        (error) => {
          // The account changed while it was pending: nothing to report to the
          // next account, and the lock is not known to be gone.
          if (isIdentityChangedError(error) || !isCurrentUser()) return;
          // Keep renewing after a transient failure; ownership then lapses on
          // its own once the server's lock could have expired. A definite
          // answer that the lock is gone makes the editor read-only now.
          if (lockIsGone(error)) loseOwnership();
          toast.error(
            "The editing lock could not be renewed. Save your changes before continuing.",
            { id: notice },
          );
          void refetchLock.current();
        },
      );
    };
    renew();
    heartbeatInterval.current = setInterval(renew, 30_000);
  }, [
    heartbeat,
    isCurrentUser,
    pageId,
    stopHeartbeat,
    confirmOwnership,
    loseOwnership,
  ]);

  // Reopening a page can recover an already-held lock; it needs the same
  // heartbeat as a freshly acquired lock, including an immediate renewal.
  useEffect(() => {
    if (lockHeld) startHeartbeat();
    else stopHeartbeat();
    return stopHeartbeat;
  }, [lockHeld, startHeartbeat, stopHeartbeat]);

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
        lease.confirmedUntil = 0;
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
    const started = Date.now();
    // A release still in flight (for example from a just-closed lifetime of
    // this page) must settle first, or its DELETE could remove the new lock.
    const releasing = lease.releasing;
    const operation =
      lease.acquisitions.values().next().value ??
      (releasing
        ? releasing
            .catch(() => {})
            .then(() => acquireLock({ pageId, expectedUserId: userId }))
        : acquireLock({ pageId, expectedUserId: userId }));
    lease.acquisitions.add(operation);
    try {
      await operation;
      lease.owned = true;
      lease.confirmedUntil = Math.max(lease.confirmedUntil, started + LOCK_MS);
      // The latest cleanup waits for pending acquisitions and owns any final
      // release. An old acquisition must not release a newly recovered lock.
      if (
        !isCurrentUser() ||
        !mounted.current ||
        currentLifetime.current !== lifetime
      )
        return;
      owned.current = true;
      rerender();
      startHeartbeat();
    } finally {
      lease.acquisitions.delete(operation);
    }
  }, [acquireLock, isCurrentUser, startHeartbeat, pageId, userId, leaseKey]);

  const release = useCallback(async () => {
    // Retain the lock and heartbeat until all queued saves are durable.
    const lease = leaseRef.current;
    const lifetime = currentLifetime.current;
    if (lease) await Promise.allSettled([...lease.acquisitions]);
    await beforeRelease();
    if (!lease || (!owned.current && !lease.owned) || !isCurrentUser()) return;
    // If this editor closed (or a newer lifetime of the page replaced it) while
    // saving, the latest lifetime's cleanup owns the release.
    if (
      !mounted.current ||
      currentLifetime.current !== lifetime ||
      lease.latest !== lifetime
    )
      return;
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
      owned: lockHeld,
      releasing: null,
      confirmedUntil: 0,
    };
    lease.latest = lifetime;
    lease.active.add(lifetime);
    if (lockHeld) lease.owned = true;
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

  // Seeing this user's lock in the lock query (on open or after acquiring)
  // only allows editing until the immediate renewal confirms it.
  useEffect(() => {
    if (lockHeld) confirmOwnership(Date.now() + OBSERVED_LOCK_GRACE_MS);
  }, [lockHeld, leaseKey, confirmOwnership]);

  // Turn read-only as soon as ownership can no longer be confirmed.
  const confirmedUntil = knownLease?.confirmedUntil ?? 0;
  useEffect(() => {
    if (!lockHeld) return;
    const remaining = confirmedUntil - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(rerender, remaining + 1);
    return () => clearTimeout(timer);
  }, [lockHeld, confirmedUntil]);

  return {
    lock,
    isLockedByMe,
    isLockedByOther,
    acquire,
    release,
    refetch,
  };
}
