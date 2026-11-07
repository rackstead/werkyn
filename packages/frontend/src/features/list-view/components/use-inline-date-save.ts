import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { identityGeneration, subscribeIdentity } from "@/lib/identity";

type DateValue = string | null;
type Send = (date: DateValue) => Promise<boolean>;
interface Request {
  value: DateValue;
  send: Send;
}
interface SaveQueue {
  key: string;
  generation: number;
  value: DateValue;
  confirmed: DateValue;
  latest: Request | null;
  requests: Request[];
  running: boolean;
  listeners: Set<() => void>;
}

// Live cells for one identity/task/field share an order, including across a
// windowed row or route unmounting and remounting while requests are pending.
const queues = new Map<string, SaveQueue>();

function release(queue: SaveQueue) {
  if (!queue.running && queue.listeners.size === 0 && queues.get(queue.key) === queue) {
    queues.delete(queue.key);
  }
}

function show(queue: SaveQueue, value: DateValue) {
  if (queue.value === value) return;
  queue.value = value;
  for (const listener of queue.listeners) listener();
}

async function drain(queue: SaveQueue) {
  queue.running = true;
  while (queue.requests.length) {
    const request = queue.requests.shift()!;
    let succeeded = false;
    try {
      // The mutation must belong to the identity that committed this edit,
      // even when it is not created until an earlier request finishes.
      if (identityGeneration() === queue.generation) {
        succeeded = await request.send(request.value);
      }
    } catch {
      // Mutation handlers already report the error. Keep retries possible.
    }
    if (succeeded) queue.confirmed = request.value;
    if (queue.latest === request) {
      queue.latest = null;
      show(queue, queue.confirmed);
    }
  }
  queue.running = false;
  release(queue);
}

/** Keep the latest requested date and save committed edits in order. */
export function useInlineDateSave(
  fieldKey: string,
  saved: DateValue,
  send: Send,
  required = false,
) {
  const generation = useSyncExternalStore(subscribeIdentity, identityGeneration);
  const key = `${generation}:${fieldKey}`;
  const queue = useMemo(() => {
    let current = queues.get(key);
    if (!current) {
      current = {
        key, generation, value: saved, confirmed: saved, latest: null,
        requests: [], running: false, listeners: new Set(),
      };
      queues.set(key, current);
    }
    return current;
    // A subsequent saved value is reconciled below, never over pending edits.
  }, [key, generation]);

  const subscribe = useCallback((listener: () => void) => {
    queues.set(key, queue);
    queue.listeners.add(listener);
    return () => {
      queue.listeners.delete(listener);
      release(queue);
    };
  }, [key, queue]);
  const value = useSyncExternalStore(subscribe, () => queue.value);

  useEffect(() => {
    if (queue.running) return;
    // Once local writes have settled, later server updates are authoritative.
    queue.confirmed = saved;
    show(queue, saved);
  }, [queue, saved]);

  const save = (next: DateValue) => {
    if (next === queue.value || (required && next === null)) return;
    const request = { value: next, send };
    queue.latest = request;
    queue.requests.push(request);
    show(queue, next);
    if (!queue.running) void drain(queue);
  };

  return { value, save };
}
