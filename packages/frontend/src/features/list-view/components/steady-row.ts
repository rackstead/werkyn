/** A row seen in view: its key, its top relative to the view, and its index in the List then. */
export interface SeenRow {
  key: string;
  top: number;
  index: number;
}

/**
 * Of the rows seen in view (top to bottom), the one to keep in place after the
 * List changed, with its index now; undefined when none of them is in the List
 * any more.
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
 * - Return the first remaining row that every such best set includes (for two
 *   rows that swapped places, the row after the pair), else the first.
 */
export function steadyRow(
  seen: readonly SeenRow[],
  indexOf: (key: string) => number | undefined,
): { key: string; top: number; index: number } | undefined {
  const rows = seen.flatMap((row) => {
    const now = indexOf(row.key);
    return now === undefined ? [] : [{ key: row.key, top: row.top, was: row.index, index: now }];
  });
  const n = rows.length;
  if (n === 0) return undefined;
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
  const kept =
    candidates.find(({ i }) => {
      const without = runs(i).best;
      return without < best && !close(without, best);
    }) ?? candidates[0];
  const { key, top, index } = kept.row;
  return { key, top, index };
}
