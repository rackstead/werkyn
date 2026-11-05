/** An entry seen in view: its key, its top in the scroller's content and its index then. */
export interface SeenEntry {
  key: string;
  top: number;
  index: number;
}

/**
 * Of the entries seen in view (in list order), the one to keep in place
 * after the list changed, with its index now; undefined when none of them
 * is listed any more.
 *
 * Entries added or removed above the view move every seen entry by the same
 * number of places. An entry that moved on its own (renamed, so that it
 * sorts elsewhere) moves by another number; so do the entries on one side
 * of an entry added or removed within the view. The entry kept is the first
 * of those that moved by the number of places most of them moved by (the
 * first such number on a tie): as many entries as possible stay where they
 * were on screen.
 */
export function steadyEntry(
  seen: readonly SeenEntry[],
  indexOf: (key: string) => number | undefined,
): (SeenEntry & { now: number }) | undefined {
  const entries = seen.flatMap((entry) => {
    const now = indexOf(entry.key);
    return now === undefined ? [] : [{ ...entry, now }];
  });
  // Insertion order of the map is the order in which each shift first
  // appears, so a tie goes to the shift of the topmost entry.
  const counts = new Map<number, number>();
  for (const entry of entries) {
    const shift = entry.now - entry.index;
    counts.set(shift, (counts.get(shift) ?? 0) + 1);
  }
  let best: number | undefined;
  for (const [shift, count] of counts) if (best === undefined || count > counts.get(best)!) best = shift;
  return entries.find((entry) => entry.now - entry.index === best);
}
