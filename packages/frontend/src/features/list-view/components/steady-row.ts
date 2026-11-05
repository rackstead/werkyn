/** A row seen in view: its key and its top relative to the view. */
export interface SeenRow {
  key: string;
  top: number;
}

/**
 * Of the rows seen in view (top to bottom), the first that kept its order
 * among them after the List changed, with its new index; undefined when none
 * of them is in the List any more.
 *
 * Rows added or removed above the view shift every seen row's index alike.
 * A row moved within the view (by a colleague, say) breaks the order instead:
 * it is not the one to keep in place, or every other row would move with it.
 * The kept order is a longest increasing run of new indexes (not necessarily
 * contiguous). Two rows that swapped places each fit one such run, so the row
 * returned is the first that is in every longest run; if there is none, the
 * first in any.
 */
export function steadyRow(
  seen: readonly SeenRow[],
  indexOf: (key: string) => number | undefined,
): (SeenRow & { index: number }) | undefined {
  const rows = seen.flatMap((row) => {
    const index = indexOf(row.key);
    return index === undefined ? [] : [{ ...row, index }];
  });
  const n = rows.length;
  // Longest increasing run ending at and starting from each row.
  const ending = rows.map(() => 1);
  const starting = rows.map(() => 1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (rows[j].index < rows[i].index) ending[i] = Math.max(ending[i], ending[j] + 1);
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i + 1; j < n; j++) {
      if (rows[j].index > rows[i].index) starting[i] = Math.max(starting[i], starting[j] + 1);
    }
  }
  const longest = Math.max(0, ...ending);
  const onRun = rows.map((_, i) => ending[i] + starting[i] - 1 === longest);
  // A row is in every longest run when no other row on one shares its place
  // (its run length so far) in it.
  const atPlace = new Map<number, number>();
  rows.forEach((_, i) => {
    if (onRun[i]) atPlace.set(ending[i], (atPlace.get(ending[i]) ?? 0) + 1);
  });
  return (
    rows.find((_, i) => onRun[i] && atPlace.get(ending[i]) === 1) ??
    rows.find((_, i) => onRun[i])
  );
}
