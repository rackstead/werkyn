import { identityGeneration } from "./identity";
import { UploadedMediaOwner } from "./uploaded-media";

interface AvatarEntry {
  users: number;
  promise: Promise<string>;
  idle?: ReturnType<typeof setTimeout>;
}
interface AvatarPool {
  generation: number;
  owner: UploadedMediaOwner;
  entries: Map<string, AvatarEntry>;
  pending: number;
  retired: boolean;
}
let current: AvatarPool | undefined;

function retire(pool: AvatarPool) {
  pool.retired = true;
  for (const entry of pool.entries.values()) clearTimeout(entry.idle);
  pool.entries.clear();
  pool.owner.dispose();
  if (current === pool) current = undefined;
}
function reconcile(pool: AvatarPool) {
  pool.owner.reconcile(new Set(pool.entries.keys()));
}
function drop(pool: AvatarPool, url: string, entry: AvatarEntry) {
  if (pool.entries.get(url) !== entry || entry.users !== 0) return;
  clearTimeout(entry.idle);
  pool.entries.delete(url);
  reconcile(pool);
  if (pool.entries.size === 0 && pool.pending === 0) retire(pool);
}

/** Acquire only from a committed effect. No credentials or durable cache are kept.
 * One identity-scoped owner bounds all avatars to two active loads and 64 MiB.
 */
export function acquireAvatarMedia(url: string): { promise: Promise<string>; release: () => void } {
  const generation = identityGeneration();
  if (current && current.generation !== generation) retire(current);
  if (!current) {
    const entries = new Map<string, AvatarEntry>();
    const pool: AvatarPool = { generation, entries, pending: 0, retired: false, owner: undefined! };
    pool.owner = new UploadedMediaOwner(() => {}, undefined, () => retire(pool), 5 * 1024 * 1024);
    current = pool;
    pool.owner.activate();
  }
  const pool = current;
  let entry = pool.entries.get(url);
  if (!entry) {
    // A different reference can reclaim idle virtualization entries, never a
    // live consumer's URL. Owner byte reservations remain the final cap.
    for (const [oldUrl, old] of pool.entries) if (old.users === 0) drop(pool, oldUrl, old);
    if (pool.retired) return acquireAvatarMedia(url);
    if (pool.entries.size >= 256) return { promise: Promise.reject(new Error("Too many avatar references")), release: () => {} };
    entry = { users: 0, promise: undefined! };
    pool.entries.set(url, entry);
    reconcile(pool);
    pool.pending++;
    entry.promise = pool.owner.resolve(url);
    const settled = () => {
      pool.pending--;
      // An aborted reader can still be cancelling. Reuse its owner's slot
      // accounting until the actual operation settles, even with no leases.
      if (!pool.retired && pool.pending === 0 && pool.entries.size === 0) retire(pool);
    };
    void entry.promise.then(settled, settled);
  }
  clearTimeout(entry.idle);
  entry.idle = undefined;
  entry.users++;
  let released = false;
  return {
    promise: entry.promise,
    release() {
      if (released) return;
      released = true;
      if (pool.retired || pool.entries.get(url) !== entry) return;
      entry.users--;
      if (entry.users === 0) entry.idle = setTimeout(() => drop(pool, url, entry), 30000);
    },
  };
}
