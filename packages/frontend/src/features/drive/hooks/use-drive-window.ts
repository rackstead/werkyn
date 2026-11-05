import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";

/** A rendered row, or the space of rows that are not rendered. */
export type WindowSegment =
  | { kind: "row"; index: number }
  | { kind: "gap"; key: string; height: number };

// Rows rendered beyond each edge of the view.
const OVERSCAN = 6;
// Rows rendered while the view has no size (not laid out yet, or hidden).
const UNSIZED_ROWS = 60;

interface DriveWindowOptions {
  /** Rows in the list (entries in the list view, lines of cards in the grid). */
  count: number;
  /** The element that scrolls the rows; null until it is mounted. */
  scroller: HTMLElement | null;
  /** The element the rows are rendered in; its top is the top of the first row. */
  container: RefObject<HTMLElement | null>;
  /** Height of a row (including the space below it) until one is measured. */
  estimate: number;
  /** Rows that stay rendered wherever the view is: the focused and the dragged entry's. */
  keep: readonly number[];
}

/**
 * Renders only the rows of a long Drive folder in or near the view. Every
 * row of a folder view has the same height (one line per entry in the list,
 * cards of one size in the grid), so a row's place follows from its index:
 * the height is measured once from two rendered rows and the virtualizer
 * never measures rows one by one. Gaps hold the height of the rows not
 * rendered.
 *
 * The first and last rows are always rendered too, so Tab into the list
 * from above reaches its first entry and Shift+Tab from below its last, as
 * with every row rendered.
 */
export function useDriveWindow({ count, scroller, container, estimate, keep }: DriveWindowOptions) {
  const [rowHeight, setRowHeight] = useState(estimate);
  // Offset of the first row from the top of the scroller's content.
  const [scrollMargin, setScrollMargin] = useState(0);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const keepKey = keep.join(",");
  const rangeExtractor = useCallback(
    (range: Range) => {
      const rows = new Set(defaultRangeExtractor(range));
      if (range.count > 0) rows.add(0).add(range.count - 1);
      for (const row of keepKey ? keepKey.split(",").map(Number) : []) {
        // The row before and after too: arrow keys move focus there.
        for (let i = Math.max(0, row - 1); i <= Math.min(range.count - 1, row + 1); i++) rows.add(i);
      }
      return [...rows].sort((a, b) => a - b);
    },
    [keepKey],
  );

  const virtualizer = useVirtualizer({
    count,
    enabled: !!scroller,
    getScrollElement: () => scroller,
    // Start from where the scroller already is rather than scrolling it to
    // the top.
    initialOffset: () => scroller?.scrollTop ?? 0,
    scrollMargin,
    estimateSize: () => rowHeight,
    rangeExtractor,
    overscan: OVERSCAN,
  });

  // The estimate is only read for rows not measured, and no row is: forget
  // the computed places when the row height changes.
  const measuredHeight = useRef(rowHeight);
  useLayoutEffect(() => {
    if (measuredHeight.current === rowHeight) return;
    measuredHeight.current = rowHeight;
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

  const items = virtualizer.getVirtualItems();
  const segments = useMemo(() => {
    const indexes =
      items.length > 0
        ? items.map((item) => item.index)
        : Array.from({ length: Math.min(count, UNSIZED_ROWS) }, (_, i) => i);
    const result: WindowSegment[] = [];
    let next = 0;
    for (const index of indexes) {
      if (index > next) result.push({ kind: "gap", key: `gap:${next}`, height: (index - next) * rowHeight });
      result.push({ kind: "row", index });
      next = index + 1;
    }
    if (count > next) result.push({ kind: "gap", key: `gap:${next}`, height: (count - next) * rowHeight });
    return result;
  }, [items, count, rowHeight]);

  // Where the first row starts in the scroller's content, and the row
  // height (from two adjacent rendered rows), after every render. Content
  // above the rows (other sections, the header) can change height without
  // this view rendering; the scroller's children change size then.
  const measure = useCallback(() => {
    const body = container.current;
    if (!body || !scroller) return;
    const top =
      body.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      scroller.clientTop +
      scroller.scrollTop;
    // Whole pixels: sub-pixel changes would only render the same rows.
    setScrollMargin(Math.round(top));
    const rows = body.querySelectorAll<HTMLElement>(":scope > [data-index]");
    for (let i = 0; i + 1 < rows.length; i++) {
      if (Number(rows[i + 1].dataset.index) !== Number(rows[i].dataset.index) + 1) continue;
      const height = rows[i + 1].getBoundingClientRect().top - rows[i].getBoundingClientRect().top;
      // Layout rounds positions to fractions of a pixel, so two pairs of
      // rows can differ by a hair; that is not a new height.
      if (height > 0) setRowHeight((current) => (Math.abs(height - current) > 0.05 ? height : current));
      break;
    }
  }, [scroller, container]);
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    if (!scroller || typeof ResizeObserver !== "function") return;
    const sizes = new ResizeObserver(measure);
    const observeChildren = () => {
      sizes.disconnect();
      for (const child of scroller.children) sizes.observe(child);
    };
    observeChildren();
    const children = new MutationObserver(() => {
      observeChildren();
      measure();
    });
    children.observe(scroller, { childList: true });
    return () => {
      sizes.disconnect();
      children.disconnect();
    };
  }, [scroller, measure]);

  /**
   * After KeepInView scrolled the view to keep the entries in place: the
   * virtualizer learns the new position from the scroll event only after
   * the next paint, so it is told now, and the rows at the new position are
   * rendered before that paint.
   */
  const onCorrected = useCallback(
    (scrollTop: number) => {
      virtualizer.scrollOffset = scrollTop;
      rerender();
    },
    [virtualizer],
  );

  return { virtualizer, segments, rowHeight, onCorrected };
}
