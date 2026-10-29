import { IdentityChangedError } from "./api-error";

// The identity transition boundary. Every change of the signed-in account in
// this tab (sign-in, sign-out, an account switch, a failed refresh, or any of
// these arriving from another tab) runs `changeIdentity` exactly once. It:
//
// - advances the identity generation, so asynchronous work can tell that it
//   was started for an earlier identity and discard its result;
// - aborts every API request still in flight for the earlier identity;
// - runs the registered resets (query and mutation caches, router, realtime
//   connections, per-user stores and any other module that holds data for the
//   previous account).
//
// The auth store calls `changeIdentity` whenever its user id changes; nothing
// else should.

export interface IdentityChange {
  /** The generation that begins with this change. */
  generation: number;
  previousUserId: string | null;
  userId: string | null;
}

/**
 * Clears state that belongs to the previous identity. It runs synchronously
 * during the change; a returned promise delays `settled` until it finishes.
 */
export type IdentityResetListener = (
  change: IdentityChange,
) => void | PromiseLike<unknown>;

export interface IdentitySnapshot {
  generation: number;
  /**
   * How many changes left a signed-in account. The routed UI is remounted on
   * each, so no component state outlives the account it was created for.
   */
  departures: number;
  /** False while resets started by leaving an account are still running. */
  settled: boolean;
}

let generation = 0;
let controller = new AbortController();
let unsettledDepartures = 0;
let snapshot: IdentitySnapshot = { generation, departures: 0, settled: true };
const resetListeners = new Set<IdentityResetListener>();
const snapshotListeners = new Set<() => void>();

/** Counts identity changes in this tab. */
export function identityGeneration(): number {
  return generation;
}

/** Aborted, with an IdentityChangedError, when the identity next changes. */
export function identitySignal(): AbortSignal {
  return controller.signal;
}

/** Registers a reset to run on every identity change; returns its removal. */
export function onIdentityChange(listener: IdentityResetListener): () => void {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
}

function publish(next: IdentitySnapshot) {
  snapshot = next;
  for (const listener of [...snapshotListeners]) listener();
}

export function subscribeIdentity(listener: () => void): () => void {
  snapshotListeners.add(listener);
  return () => {
    snapshotListeners.delete(listener);
  };
}

export function getIdentitySnapshot(): IdentitySnapshot {
  return snapshot;
}

export function changeIdentity(
  previousUserId: string | null,
  userId: string | null,
): void {
  generation += 1;
  const change: IdentityChange = { generation, previousUserId, userId };

  const ended = controller;
  controller = new AbortController();
  ended.abort(new IdentityChangedError());

  const pending: PromiseLike<unknown>[] = [];
  for (const listener of [...resetListeners]) {
    try {
      const result = listener(change);
      if (result && typeof result.then === "function") pending.push(result);
    } catch (error) {
      // One failing reset must not leave the others undone.
      console.error("Identity reset failed", error);
    }
  }

  const departed = previousUserId !== null;
  const waits = departed && pending.length > 0;
  if (waits) unsettledDepartures += 1;
  publish({
    generation,
    departures: snapshot.departures + (departed ? 1 : 0),
    settled: unsettledDepartures === 0,
  });
  if (!waits) return;
  void Promise.allSettled(pending).then(() => {
    unsettledDepartures -= 1;
    if (unsettledDepartures === 0) publish({ ...snapshot, settled: true });
  });
}
