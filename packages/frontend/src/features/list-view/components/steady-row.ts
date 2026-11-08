import { stayedEntries, type ListChange } from "@/lib/stayed-entries";

/** A row seen in view: its key, its top relative to the view, and its index in the List then. */
export interface SeenRow {
  key: string;
  top: number;
  index: number;
}

/**
 * Of the rows seen in view (top to bottom), the ones that stayed when the List
 * changed, the one to keep in place first, with their indexes now; empty when
 * none of them is in the List any more. The caller keeps the first of them
 * that is still rendered.
 * When the whole-list change is known, first exclude entries that crossed
 * other entries using the same order check as Drive. The visible-row weighting
 * below then retains the List's existing choice among the entries that stayed.
 *
 * Rows added or removed above the view change every seen row's index alike. A
 * row moved by someone (a colleague, a bulk action) changes order with the
 * others, or jumps far away (to another group), while the rows around it are
 * only pushed along by one index per row moved past them. The row kept is one
 * that stayed:
 *
 * - Among the seen rows still in the List, take the set that kept its order
 *   (increasing new indexes) and moved least in total: each row counts
 *   1 / (1 + |change of index|), so a block moved far away counts for almost
 *   nothing however large it is, and rows that were only pushed along count
 *   nearly fully.
 * - Of that set, skip rows that moved much further than the least-moved ones
 *   (counting less than half as much): a block moved far up can still be in
 *   order with the rows below it.
 * - Rows that every such best set includes come first (for two rows that
 *   swapped places, the rows after the pair), in order, then the others.
 */
export function steadyRows(
  seen: readonly SeenRow[],
  indexOf: (key: string) => number | undefined,
  change?: Omit<ListChange, "indexOf">,
): Array<{ key: string; top: number; index: number }> {
  const inView = new Set(seen.map((row) => row.key));
  const stayed = change && stayedEntries({ ...change, indexOf }, (key) => inView.has(key));
  const rows = seen.flatMap((row) => {
    const now = indexOf(row.key);
    return now === undefined || (stayed && (change!.before[row.index] !== row.key || !stayed[row.index]))
      ? [] : [{ key: row.key, top: row.top, was: row.index, index: now }];
  });
  const n = rows.length;
  if (n === 0) return [];
  // Nothing moved, or rows were only added or removed above: every row, in
  // order (what the rest below gives too, without its cost on each scroll).
  const shift = rows[0].index - rows[0].was;
  if (rows.every((row) => row.index - row.was === shift)) {
    return rows.map(({ key, top, index }) => ({ key, top, index }));
  }
  const weight = rows.map((row) => 1 / (1 + Math.abs(row.index - row.was)));
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));

  // Largest total weight of an increasing run ending at / starting from each
  // row, leaving out one row (`without`) or none (-1).
  const runs = (without: number) => {
    const ending = rows.map(() => -Infinity);
    const starting = rows.map(() => -Infinity);
    for (let i = 0; i < n; i++) {
      if (i === without) continue;
      let before = 0;
      for (let j = 0; j < i; j++) {
        if (j !== without && rows[j].index < rows[i].index) before = Math.max(before, ending[j]);
      }
      ending[i] = before + weight[i];
    }
    for (let i = n - 1; i >= 0; i--) {
      if (i === without) continue;
      let after = 0;
      for (let j = i + 1; j < n; j++) {
        if (j !== without && rows[j].index > rows[i].index) after = Math.max(after, starting[j]);
      }
      starting[i] = after + weight[i];
    }
    return { ending, starting, best: Math.max(0, ...ending) };
  };

  const { ending, starting, best } = runs(-1);
  const inBest = rows.map((_, i) => close(ending[i] + starting[i] - weight[i], best));
  const heaviest = Math.max(...weight.filter((_, i) => inBest[i]));
  const candidates = rows
    .map((row, i) => ({ row, i }))
    .filter(({ i }) => inBest[i] && weight[i] >= heaviest / 2);
  // Rows every best set includes first, in order; then the others.
  const inEvery = new Set(
    candidates
      .filter(({ i }) => {
        const without = runs(i).best;
        return without < best && !close(without, best);
      })
      .map(({ i }) => i),
  );
  const ordered = [
    ...candidates.filter(({ i }) => inEvery.has(i)),
    ...candidates.filter(({ i }) => !inEvery.has(i)),
  ];
  return ordered.map(({ row: { key, top, index } }) => ({ key, top, index }));
}
