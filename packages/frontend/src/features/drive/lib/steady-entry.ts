import { stayedEntries, type ListChange } from "../../../lib/stayed-entries";

export { stayedEntries, type ListChange };

/** An entry seen in view: its key, its top in the scroller's content and its index then. */
export interface SeenEntry {
  key: string;
  top: number;
  index: number;
}

/** The entry to keep in place: its index then and now; `top` when it was seen in view. */
export interface KeptEntry {
  key: string;
  index: number;
  now: number;
  top?: number;
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
