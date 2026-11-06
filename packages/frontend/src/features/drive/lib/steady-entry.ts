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
 * The entries seen are grouped by how many places each moved (its index now
 * minus its index then):
 *
 * - Entries added or removed above the view move every seen entry by the
 *   same number of places: one group, kept wherever it went.
 * - An entry added or removed within the view moves the entries on one side
 *   of it by one place; an entry moved a few places (a swap, a rename that
 *   sorts it next door) moves itself and its neighbours a little. These
 *   groups all stay near the view. Of the groups that moved by no more
 *   places than there are entries in view, the largest is kept (the first
 *   on a tie): as many entries as possible stay where they were on screen.
 * - Entries renamed or edited so that they sort far away move by more
 *   places than the view holds. However many of them there are, the view
 *   does not follow them: the entries that stayed near are kept.
 * - Only when every group moved far (many entries added or removed above
 *   the view, with or without other changes) is the group that moved least
 *   kept.
 *
 * Within the group, the first entry still rendered after the change is
 * kept, when one is (`isRendered`), so its place is measured rather than
 * computed.
 */
export function steadyEntry(
  seen: readonly SeenEntry[],
  indexOf: (key: string) => number | undefined,
  isRendered: (key: string) => boolean = () => true,
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
  let best: { shift: number; members: typeof entries } | undefined;
  const near = [...groups].filter(([shift]) => Math.abs(shift) <= seen.length);
  if (near.length > 0) {
    for (const [shift, members] of near)
      if (!best || members.length > best.members.length) best = { shift, members };
  } else {
    for (const [shift, members] of groups)
      if (
        !best ||
        Math.abs(shift) < Math.abs(best.shift) ||
        (Math.abs(shift) === Math.abs(best.shift) && members.length > best.members.length)
      )
        best = { shift, members };
  }
  if (!best) return undefined;
  return best.members.find((entry) => isRendered(entry.key)) ?? best.members[0];
}
