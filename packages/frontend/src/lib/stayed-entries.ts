/** A list before a change, and where its entries are now. */
export interface ListChange {
  /** The keys listed before the change, in order: the whole list loaded. */
  before: readonly string[];
  /** A key's index now; undefined when it is no longer listed. */
  indexOf: (key: string) => number | undefined;
  /**
   * Whether an entry's active sort keys changed. Changes to fields that
   * cannot affect this ordering must not count: an entry whose sort keys
   * did not change kept its order relative to the other such entries.
   * Without it, any entry may have moved.
   */
  changed?: (key: string) => boolean;
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
 * 1. the most entries whose sort keys did not change (`changed`): a batch of
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

  // The best run ending at each entry: how many entries kept their sort
  // keys, how many there are, how many are preferred, and the entry
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

