/** An entry seen in view: its key, its top in the scroller's content and its index then. */
export interface SeenEntry {
  key: string;
  top: number;
  index: number;
}

/** An entry listed just above or below the view (not seen): its key and its index then. */
export interface AroundEntry {
  key: string;
  index: number;
}

/**
 * Of the entries seen in view (in list order), the one to keep in place
 * after the list changed, with its index now; undefined when none of them
 * is listed any more.
 *
 * The entries seen are grouped by how many places each moved (its index now
 * minus its index then). The group kept is the one that moved with the list
 * around the view: `around` holds a few entries listed just above and just
 * below the view, and the group whose shift most of them share kept its
 * place in the list. So:
 *
 * - entries added or removed above the view move the entries seen and those
 *   around them alike, by any number of places: that group is kept;
 * - entries renamed so that they now sort far away (a colleague's batch
 *   rename, an edit under the Modified sort) move away from their
 *   neighbours: however many of them there are, the view does not follow
 *   them, but keeps the entries that stayed among their neighbours;
 * - one entry renamed to land near its old index while entries were added
 *   above does not take the view with it either;
 * - an entry added or removed within the view leaves the entries on each
 *   side with their neighbours above or below: the larger side is kept, as
 *   many entries as possible staying put (the first on a tie).
 *
 * Without entries around the view (all of them changed too, or the list is
 * that short), the largest of the groups that moved by no more places than
 * there are entries in view is kept, or, when every group moved further,
 * the one that moved least. Within the group, the first entry still
 * rendered after the change is kept, when one is (`isRendered`), so its
 * place is measured rather than computed.
 */
export function steadyEntry(
  seen: readonly SeenEntry[],
  indexOf: (key: string) => number | undefined,
  isRendered: (key: string) => boolean = () => true,
  around: readonly AroundEntry[] = [],
): (SeenEntry & { now: number }) | undefined {
  const entries = seen.flatMap((entry) => {
    const now = indexOf(entry.key);
    return now === undefined ? [] : [{ ...entry, now }];
  });
  // Groups by shift, in the order in which each shift first appears.
  const groups = new Map<number, typeof entries>();
  for (const entry of entries) {
    const shift = entry.now - entry.index;
    const group = groups.get(shift);
    if (group) group.push(entry);
    else groups.set(shift, [entry]);
  }
  // How many entries around the view moved by each shift.
  const neighbours = new Map<number, number>();
  for (const entry of around) {
    const now = indexOf(entry.key);
    if (now === undefined) continue;
    const shift = now - entry.index;
    neighbours.set(shift, (neighbours.get(shift) ?? 0) + 1);
  }
  const shared = (shift: number) => neighbours.get(shift) ?? 0;

  type Group = { shift: number; members: typeof entries };
  let best: Group | undefined;
  const all = [...groups].map(([shift, members]): Group => ({ shift, members }));
  if (all.some((group) => shared(group.shift) > 0)) {
    for (const group of all)
      if (
        !best ||
        shared(group.shift) > shared(best.shift) ||
        (shared(group.shift) === shared(best.shift) && group.members.length > best.members.length)
      )
        best = group;
  } else {
    const near = all.filter((group) => Math.abs(group.shift) <= seen.length);
    for (const group of near.length > 0 ? near : all)
      if (
        !best ||
        (near.length > 0
          ? group.members.length > best.members.length
          : Math.abs(group.shift) < Math.abs(best.shift) ||
            (Math.abs(group.shift) === Math.abs(best.shift) &&
              group.members.length > best.members.length))
      )
        best = group;
  }
  if (!best) return undefined;
  return best.members.find((entry) => isRendered(entry.key)) ?? best.members[0];
}
