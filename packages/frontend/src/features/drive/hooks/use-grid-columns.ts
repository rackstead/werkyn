import { useSyncExternalStore } from "react";

// The grid's columns at Tailwind's sm, md and lg breakpoints, widest first
// (`grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5`).
const BREAKPOINTS: ReadonlyArray<readonly [query: string, columns: number]> = [
  ["(min-width: 64rem)", 5],
  ["(min-width: 48rem)", 4],
  ["(min-width: 40rem)", 3],
];
export const GRID_CLASS = "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5";

const canMatch = () => typeof window !== "undefined" && typeof window.matchMedia === "function";

function columns(): number {
  if (!canMatch()) return 5;
  for (const [query, count] of BREAKPOINTS) if (window.matchMedia(query).matches) return count;
  return 2;
}

function subscribe(onChange: () => void) {
  if (!canMatch()) return () => {};
  const lists = BREAKPOINTS.map(([query]) => window.matchMedia(query));
  for (const list of lists) list.addEventListener("change", onChange);
  return () => {
    for (const list of lists) list.removeEventListener("change", onChange);
  };
}

/** How many columns of cards GRID_CLASS lays out at the current window width. */
export function useGridColumns(): number {
  return useSyncExternalStore(subscribe, columns, () => 5);
}
