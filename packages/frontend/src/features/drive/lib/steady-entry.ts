/** An entry seen in view: its key, its top in the scroller's content and its index then. */
export interface SeenEntry {
  key: string;
  top: number;
  index: number;
}

/** A list before a change, and where its entries are now. */
export interface ListChange {
  /** The keys listed before the change, in order: the whole list loaded. */
  before: readonly string[];
  /** A key's index now; undefined when it is no longer listed. */
  indexOf: (key: string) => number | undefined;
  /**
   * Whether an entry's own data changed with the change (renamed, edited).
   * The list is sorted by the entries' data, so only such an entry can
   * have moved past the others: the entries not changed keep their order.
   * Without it, any entry may have moved.
   */
  changed?: (key: string) => boolean;
}

/** The entry to keep in place: its index then and now; `top` when it was seen in view. */
export interface KeptEntry {
  key: string;
  index: number;
  now: number;
  top?: number;
}

/**
 * Which entries of the list before a change stayed in it, in their order
 * relative to each other, by their index then (1: stayed). The others
 * moved past them (renamed to sort elsewhere, for example) or are no longer
 * listed.
 *
 * Entries added or removed leave the others in order; when nothing else
 * changed, every entry still listed stayed, found in one pass. Otherwise
 * the entries that stayed are a longest run of entries whose indexes now
 * increase in their order then (a longest increasing subsequence, in
 * O(n log n)), taking in preference, in this order:
 *
 * 1. the most entries whose data did not change (`changed`): a batch of
 *    renamed entries never outweighs the entries left as they were, even
 *    when it is the larger group or moved fewer places;
 * 2. the most entries;
 * 3. the most entries `preferred` (those in view).
 */
export function stayedEntries(
  { before, indexOf, changed }: ListChange,
  preferred: (key: string) => boolean = () => false,
): Uint8Array {
  const count = before.length;
  const now = new Int32Array(count);
  const stayed = new Uint8Array(count);
  let ordered = true;
  let last = -1;
  let size = 0;
  for (let i = 0; i < count; i++) {
    const index = indexOf(before[i]);
    now[i] = index ?? -1;
    if (index === undefined) continue;
    stayed[i] = 1;
    if (index <= last) ordered = false;
    last = Math.max(last, index);
    size = Math.max(size, index + 1);
  }
  if (ordered) return stayed;

  // The best run ending at each entry: how many entries in it did not
  // change, how many there are, how many are preferred, and the entry
  // before it.
  const kept = new Int32Array(count);
  const length = new Int32Array(count);
  const liked = new Int32Array(count);
  const previous = new Int32Array(count).fill(-1);
  const better = (a: number, b: number) =>
    b < 0 ||
    (a >= 0 &&
      (kept[a] !== kept[b]
        ? kept[a] > kept[b]
        : length[a] !== length[b]
          ? length[a] > length[b]
          : liked[a] > liked[b]));
  // A Fenwick tree over the indexes now: the entry ending the best run
  // among the entries placed at or before each index.
  const tree = new Int32Array(size + 1).fill(-1);
  const bestUpTo = (index: number) => {
    let best = -1;
    for (let at = index; at > 0; at -= at & -at) if (!better(best, tree[at])) best = tree[at];
    return best;
  };
  for (let i = 0; i < count; i++) {
    if (now[i] < 0) continue;
    const key = before[i];
    const from = bestUpTo(now[i]);
    previous[i] = from;
    kept[i] = (from < 0 ? 0 : kept[from]) + (changed?.(key) ? 0 : 1);
    length[i] = (from < 0 ? 0 : length[from]) + 1;
    liked[i] = (from < 0 ? 0 : liked[from]) + (preferred(key) ? 1 : 0);
    for (let at = now[i] + 1; at <= size; at += at & -at) if (better(i, tree[at])) tree[at] = i;
  }
  stayed.fill(0);
  for (let i = bestUpTo(size); i >= 0; i = previous[i]) stayed[i] = 1;
  return stayed;
}

/**
 * Of the entries seen in view (in list order), the one to keep in place
 * after the list changed, with its index now; or, when none of them stayed
 * listed, the entry nearest to the view that did (without `top`: its place
 * then follows from its index). Undefined when no entry stayed.
 *
 * Only an entry that kept its order relative to the rest of the list
 * (`stayedEntries`) is kept. So:
 *
 * - entries added or removed above the view move the entries seen by any
 *   number of places, all alike: the first entry seen is kept;
 * - entries renamed so that they now sort elsewhere (a colleague's batch
 *   rename, an edit under the Modified sort) did not stay, however many
 *   there are and wherever they land: the view does not follow them, but
 *   keeps the entries left in view;
 * - an entry added or removed within the view leaves the entries seen on
 *   each side moved by different numbers of places: the larger side is
 *   kept, as many entries as possible staying put (the first on a tie).
 *
 * Within the side kept, the first entry still rendered after the change is
 * kept, when one is (`isRendered`), so its place is measured rather than
 * computed.
 */
export function steadyEntry(
  seen: readonly SeenEntry[],
  change: ListChange,
  isRendered: (key: string) => boolean = () => true,
): KeptEntry | undefined {
  if (seen.length === 0) return undefined;
  const inView = new Set(seen.map((entry) => entry.key));
  const stayed = stayedEntries(change, (key) => inView.has(key));
  const { before, indexOf } = change;

  // The entries seen that stayed, grouped by how many places they moved.
  const groups = new Map<number, Array<SeenEntry & { now: number }>>();
  for (const entry of seen) {
    const now = indexOf(entry.key);
    if (now === undefined || before[entry.index] !== entry.key || !stayed[entry.index]) continue;
    const group = groups.get(now - entry.index);
    if (group) group.push({ ...entry, now });
    else groups.set(now - entry.index, [{ ...entry, now }]);
  }
  let best: Array<SeenEntry & { now: number }> | undefined;
  for (const group of groups.values()) if (!best || group.length > best.length) best = group;
  if (best) return best.find((entry) => isRendered(entry.key)) ?? best[0];

  // None of them: the nearest entry that stayed, above the view first.
  const first = Math.min(...seen.map((entry) => entry.index));
  const last = Math.max(...seen.map((entry) => entry.index));
  for (let distance = 1; first - distance >= 0 || last + distance < before.length; distance++) {
    for (const index of [first - distance, last + distance]) {
      if (index < 0 || index >= before.length || !stayed[index]) continue;
      const now = indexOf(before[index]);
      if (now !== undefined) return { key: before[index], index, now };
    }
  }
  return undefined;
}
