import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { TaskCard } from "./task-card";
import { QuickAdd } from "./quick-add";
import type { AssembledColumn } from "../lib/use-board-columns";
import {
  BOARD_CARD_ESTIMATE,
  BOARD_OVERSCAN,
  BOARD_PAGE_SIZE,
  indexAtOffset,
  keptBoardCards,
} from "../lib/board-window";
import type { SeenRow } from "@/features/list-view/components/steady-row";

interface StatusColumn {
  id: string;
  name: string;
  color: string | null;
  position: number;
  isCompletion: boolean;
}

interface ColumnProps {
  status: StatusColumn;
  column: AssembledColumn | undefined;
  /** Display order while a drag is in progress; the server order otherwise. */
  order: readonly string[];
  projectId: string;
  onTaskClick: (taskId: string) => void;
  canCreate: boolean;
  canDrag: boolean;
  /** Display indexes that stay mounted: the dragged card and the card under the pointer. */
  pins: readonly number[];
  /** While dragging, scroll this display index into view when it sits outside the window. */
  followIndex: number | null;
  /** Skip scroll anchoring while the user is dragging; the drop will move cards on purpose. */
  pauseAnchor: boolean;
  /** Bumped after a card is created so the column scrolls to the new card. */
  reveal: number;
  onRange: (start: number, end: number) => void;
  registerIndexAt: (statusId: string, indexAt: ((clientY: number) => number) | null) => void;
  onCreated: () => void;
}

function sameIds(a: readonly string[], b: readonly string[]) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function findCard(node: HTMLElement, key: string) {
  for (const candidate of node.querySelectorAll<HTMLElement>("[data-task-id]")) {
    if (candidate.dataset.taskId === key) return candidate;
  }
  return undefined;
}

function placeCard(node: HTMLElement, card: HTMLElement, want: number) {
  const moved = card.getBoundingClientRect().top - node.getBoundingClientRect().top - want;
  if (Math.abs(moved) >= 1) node.scrollTop += moved;
}

function rememberSize(sizes: Map<string, number>, id: string | null | undefined, height: number) {
  if (!id || !(height > 0)) return;
  const prev = sizes.get(id) ?? 0;
  // A later pass can read a card while it is collapsing. Keep the height it had on screen.
  if (height > prev) sizes.set(id, height);
}

type MeasuredVirtualizer = {
  itemSizeCache: Map<string | number, number>;
  measurementsCache: Array<{ start: number; size: number; end: number; key: string | number }>;
  pendingMeasuredCacheIndexes: number[];
  getMeasurements: () => Array<{ start: number }>;
};

/** Index offsets from the tallest height measured for each card. */
function measurementsFromSizes(
  virtualizer: { measurementsCache: Array<{ start: number }> },
  sizes: Map<string, number>,
) {
  const raw = virtualizer as unknown as MeasuredVirtualizer;
  for (const [key, size] of raw.itemSizeCache) {
    if (typeof key === "string") rememberSize(sizes, key, size);
  }
  let changed = false;
  const cache = new Map(raw.itemSizeCache);
  for (const [id, size] of sizes) {
    if (cache.get(id) !== size) {
      cache.set(id, size);
      changed = true;
    }
  }
  if (!changed) return raw.getMeasurements();
  raw.itemSizeCache = cache;
  // An index rebuild keeps the prefix below the first pending index, which is
  // still the previous order after cards move. Drop it and measure every index.
  raw.measurementsCache = [];
  if (raw.pendingMeasuredCacheIndexes) raw.pendingMeasuredCacheIndexes.length = 0;
  return raw.getMeasurements();
}

/** The offset cache already puts this card on the saved row. A transformed rect must not scroll it away. */
function layoutAlreadyAt(
  virtualizer: { measurementsCache: Array<{ start: number }> },
  index: number,
  scrollTop: number,
  want: number,
) {
  const start = virtualizer.measurementsCache[index]?.start;
  return start !== undefined && Math.abs(start - scrollTop - want) < 8;
}

export function Column({
  status,
  column,
  order,
  projectId,
  onTaskClick,
  canCreate,
  canDrag,
  pins,
  followIndex,
  pauseAnchor,
  reveal,
  onRange,
  registerIndexAt,
  onCreated,
}: ColumnProps) {
  const { setNodeRef } = useDroppable({ id: status.id });
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const count = order.length;
  const sized = !!scroller && scroller.offsetHeight > 0;
  const pinKey = pins.join(",");
  const rangeExtractor = useCallback((range: Range) => {
    const keep = new Set(defaultRangeExtractor(range));
    for (const raw of pinKey ? pinKey.split(",") : []) {
      const index = Number(raw);
      if (index < 0 || index >= range.count) continue;
      // The card and its neighbours, so a keyboard drag has a drop target past the window.
      for (let near = index - 1; near <= index + 1; near++) {
        if (near >= 0 && near < range.count) keep.add(near);
      }
    }
    return [...keep].sort((a, b) => a - b);
  }, [pinKey]);
  const getItemKey = useCallback((index: number) => order[index] || `empty:${index}`, [order]);
  const sizesRef = useRef(new Map<string, number>());
  const virtualizer = useVirtualizer({
    count,
    enabled: sized,
    getScrollElement: () => scroller,
    initialOffset: () => scroller?.scrollTop ?? 0,
    estimateSize: () => BOARD_CARD_ESTIMATE,
    overscan: BOARD_OVERSCAN,
    rangeExtractor,
    getItemKey,
    measureElement: (element, entry) => {
      const node = element as HTMLElement;
      const block = entry?.borderBoxSize?.[0]?.blockSize;
      const height = Math.max(node.offsetHeight, typeof block === "number" ? Math.round(block) : 0);
      const id = node.querySelector("[data-task-id]")?.getAttribute("data-task-id");
      rememberSize(sizesRef.current, id, height);
      return id ? Math.max(height, sizesRef.current.get(id) ?? 0) : height;
    },
  });
  // The list below is positioned from these offsets. Apply them before paint,
  // or a scroll correction lands on the previous order's spacers.
  if (sized) measurementsFromSizes(virtualizer, sizesRef.current);
  // A card taller than the estimate already pushes the cards under it.
  // Adjusting the scroll here as well would move them twice.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

  const setRef = useCallback((node: HTMLDivElement | null) => {
    setNodeRef(node);
    setScroller((current) => (current === node ? current : node));
  }, [setNodeRef]);

  const start = sized ? (virtualizer.range?.startIndex ?? 0) : 0;
  const end = sized
    ? (virtualizer.range?.endIndex ?? 0)
    : Math.min(count, BOARD_PAGE_SIZE) - 1;
  const onRangeRef = useRef(onRange);
  onRangeRef.current = onRange;
  useLayoutEffect(() => {
    if (count > 0) onRangeRef.current(Math.max(0, start), Math.max(0, end));
  }, [count, start, end]);

  const revealHandled = useRef(0);
  const revealFollow = useRef(false);
  useLayoutEffect(() => {
    if (!scroller) return;
    const scrollToEnd = () => {
      if (count <= 0) return;
      onRangeRef.current(Math.max(0, count - BOARD_PAGE_SIZE), count - 1);
      const placed = virtualizer.getOffsetForIndex(Math.max(0, count - 1), "end");
      scroller.scrollTop = placed?.[0] ?? scroller.scrollHeight;
    };
    // Only the quick-add that just succeeded scrolls here, plus one follow
    // when the new card's page increases the count. Later count changes
    // (someone else's insert) must leave the reader where they were.
    if (reveal !== 0 && reveal !== revealHandled.current) {
      revealHandled.current = reveal;
      revealFollow.current = true;
      scrollToEnd();
      return;
    }
    if (revealFollow.current) {
      revealFollow.current = false;
      scrollToEnd();
    }
  }, [count, reveal, scroller, virtualizer]);

  useLayoutEffect(() => {
    if (!pauseAnchor || followIndex === null || !sized) return;
    const range = virtualizer.range;
    if (!range || (followIndex >= range.startIndex && followIndex <= range.endIndex)) return;
    virtualizer.scrollToIndex(followIndex, { align: "auto" });
  }, [followIndex, pauseAnchor, sized, virtualizer]);

  useLayoutEffect(() => {
    registerIndexAt(status.id, (clientY) => {
      if (!scroller || count === 0) return 0;
      const offset = clientY - scroller.getBoundingClientRect().top + scroller.scrollTop;
      if (!sized) return indexAtOffset(offset, count, BOARD_CARD_ESTIMATE);
      if (offset >= virtualizer.getTotalSize()) return count;
      return virtualizer.getVirtualItemForOffset(Math.max(0, offset))?.index ?? count;
    });
    return () => registerIndexAt(status.id, null);
  }, [count, registerIndexAt, scroller, sized, status.id, virtualizer]);

  const orderRef = useRef(order);
  orderRef.current = order;
  const complete = column?.complete ?? false;
  const seen = useRef<{ scrollTop: number; rows: SeenRow[]; order: readonly string[]; complete: boolean } | null>(null);
  // The card we just chose to keep, until a later measurement lands it there.
  const hold = useRef<{ key: string; top: number; scrollTop: number } | null>(null);
  // True while this pass is the one moving scrollTop. The scroll event it
  // fires must not be read as the reader dragging the column.
  const correcting = useRef(false);
  const keepInView = useCallback(() => {
    const node = scroller;
    if (!node) return;
    if (pauseAnchor) {
      seen.current = null;
      hold.current = null;
      correcting.current = false;
      return;
    }
    for (const wrap of node.querySelectorAll<HTMLElement>("[data-index]")) {
      const id = wrap.querySelector("[data-task-id]")?.getAttribute("data-task-id");
      rememberSize(sizesRef.current, id, Math.max(wrap.offsetHeight, Math.round(wrap.getBoundingClientRect().height)));
    }
    const current = orderRef.current;
    const last = seen.current;
    let armed = false;
    if (last && node.scrollTop > 0) {
      let scrolled = node.scrollTop - last.scrollTop;
      const endOffset = node.scrollHeight - node.clientHeight;
      // The column got shorter while pinned to its end. The browser clamps
      // scrollTop; that is not the user scrolling.
      if (last.scrollTop > endOffset && node.scrollTop >= endOffset - 1) scrolled = 0;
      const indexOf = (key: string) => {
        const index = current.indexOf(key);
        return index < 0 ? undefined : index;
      };
      const smallScroll = Math.abs(scrolled) < node.clientHeight / 2;
      let kept: { key: string; top: number; index: number } | undefined;
      const heldNow = hold.current;
      const heldIndex = heldNow ? indexOf(heldNow.key) : undefined;
      const orderChanged = !sameIds(last.order, current);
      const shifts = orderChanged ? last.rows.flatMap((row) => {
        const now = indexOf(row.key);
        return now === undefined ? [] : [{ row, now, shift: now - row.index }];
      }) : [];
      const unanimous = shifts.length > 0 && shifts.every((item) => item.shift === shifts[0].shift);
      const missing = orderChanged && last.rows.some((row) => indexOf(row.key) === undefined);
      // A refetch lands in more than one page. A page that drops a card which
      // was on screen is not the order to follow; the next page brings it back.
      if (smallScroll && missing && !(heldNow && heldIndex !== undefined)) return;
      // Keep the card already chosen until that page, instead of whichever
      // card the partial page still has mounted.
      if (smallScroll && heldNow && heldIndex !== undefined && orderChanged) {
        kept = { key: heldNow.key, top: heldNow.top, index: heldIndex };
      } else if (smallScroll && unanimous) {
        kept = (last.complete && complete ? keptBoardCards(last.rows, last.order, indexOf)[0] : undefined)
          ?? { key: shifts[0].row.key, top: shifts[0].row.top, index: shifts[0].now };
      } else if (smallScroll && orderChanged && shifts.length > 0) {
        // Visible cards disagree, so this page is only part of the refetch.
        // Keep the pre-change view until a later page moves them together.
        return;
      } else if (smallScroll && sameIds(last.order, current)) {
        // Measuring a card removes the estimate gap under it. The order did
        // not change; put the card that was on screen back where it was.
        const still = last.rows.find((row) => indexOf(row.key) === row.index);
        const card = still ? findCard(node, still.key) : undefined;
        if (still && card && !layoutAlreadyAt(virtualizer, still.index, node.scrollTop, still.top - scrolled)) {
          placeCard(node, card, still.top - scrolled);
        }
      }
      if (kept) {
        const want = kept.top - scrolled;
        armed = true;
        correcting.current = true;
        hold.current = { key: kept.key, top: want, scrollTop: node.scrollTop };
        const card = findCard(node, kept.key);
        const item = measurementsFromSizes(virtualizer, sizesRef.current)[kept.index];
        if (card) {
          placeCard(node, card, want);
        } else if (item) {
          // The card is outside the mounted window. Its offset is the sum of
          // the measured heights above it, including cards that are not mounted.
          node.scrollTop = Math.max(0, item.start - want);
        }
        if (hold.current) hold.current.scrollTop = node.scrollTop;
      }
    }
    if (hold.current && !armed) {
      const held = hold.current;
      const card = findCard(node, held.key);
      const index = current.indexOf(held.key);
      if (card && !layoutAlreadyAt(virtualizer, index, node.scrollTop, held.top)) {
        const top = card.getBoundingClientRect().top - node.getBoundingClientRect().top;
        const drift = node.scrollTop - held.scrollTop;
        // A scroll that carries the card with it is the reader, not a measurement.
        if (!correcting.current && Math.abs(drift) > 1 && Math.abs(top - (held.top - drift)) < 2) {
          hold.current = null;
        } else {
          placeCard(node, card, held.top);
          hold.current = { ...held, scrollTop: node.scrollTop };
        }
      } else if (!card && index >= 0) {
        const item = measurementsFromSizes(virtualizer, sizesRef.current)[index];
        if (item) {
          const next = Math.max(0, item.start - held.top);
          if (Math.abs(node.scrollTop - next) >= 1) {
            node.scrollTop = next;
            hold.current = { ...held, scrollTop: node.scrollTop };
          }
        }
      }
    }
    const viewTop = node.getBoundingClientRect().top;
    const viewBottom = viewTop + node.clientHeight;
    const rows: SeenRow[] = [];
    const partly: SeenRow[] = [];
    for (const card of node.querySelectorAll<HTMLElement>("[data-task-id]")) {
      const key = card.dataset.taskId;
      if (!key) continue;
      const index = current.indexOf(key);
      if (index < 0) continue;
      const rect = card.getBoundingClientRect();
      if (rect.bottom <= viewTop || rect.top >= viewBottom) continue;
      const shown = Math.min(rect.bottom, viewBottom) - Math.max(rect.top, viewTop);
      const entry = { key, top: rect.top - viewTop, index };
      (shown * 2 >= rect.height ? rows : partly).push(entry);
    }
    seen.current = {
      scrollTop: node.scrollTop,
      rows: rows.length > 0 ? rows : partly,
      order: current,
      complete,
    };
    correcting.current = false;
  }, [complete, pauseAnchor, scroller, virtualizer]);
  useLayoutEffect(keepInView);
  useLayoutEffect(() => {
    if (!scroller || typeof ResizeObserver !== "function") return;
    const previous = scroller.style.overflowAnchor;
    scroller.style.overflowAnchor = "none";
    const observer = new ResizeObserver(() => keepInView());
    observer.observe(scroller);
    return () => {
      observer.disconnect();
      scroller.style.overflowAnchor = previous;
    };
  }, [keepInView, scroller]);

  const rendered: Array<{ index: number; gapBefore: number }> = [];
  if (!sized) {
    for (let index = 0; index < Math.min(count, BOARD_PAGE_SIZE); index++) {
      rendered.push({ index, gapBefore: 0 });
    }
  } else {
    let cursor = 0;
    for (const item of virtualizer.getVirtualItems()) {
      rendered.push({ index: item.index, gapBefore: Math.max(0, item.start - cursor) });
      cursor = item.end;
    }
  }
  const lastItem = sized ? virtualizer.getVirtualItems().at(-1) : undefined;
  const tail = lastItem ? Math.max(0, virtualizer.getTotalSize() - lastItem.end) : 0;

  const ids = rendered.flatMap(({ index }) => {
    const id = order[index];
    return id ? [id] : [];
  });
  const tasks = column?.tasks;

  // Fills the board height, so this scroller is the one that moves.
  return (
    <div className="flex h-full min-h-0 w-72 flex-shrink-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-2 pb-3">
        <div
          className="h-3 w-3 rounded-full shrink-0"
          style={{ backgroundColor: status.color ?? "#6b7280" }}
        />
        <h3 className="text-sm font-semibold truncate">{status.name}</h3>
        <span className="ml-auto text-xs text-muted-foreground" data-column-count={status.id}>
          {count}
        </span>
      </div>
      <div
        ref={setRef}
        data-scroller={status.id}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain rounded-lg p-1"
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {rendered.map(({ index, gapBefore }) => {
            const id = order[index];
            const task = id ? tasks?.get(id) : undefined;
            return (
              <div key={id || `empty:${index}`}>
                {gapBefore > 0 && <div aria-hidden="true" style={{ height: gapBefore }} />}
                {task ? (
                  <div
                    ref={sized ? virtualizer.measureElement : undefined}
                    data-index={index}
                    data-column-index={task.columnIndex}
                    className="pb-2"
                  >
                    <TaskCard
                      task={task}
                      onClick={() => onTaskClick(task.id)}
                      isDragDisabled={!canDrag}
                    />
                  </div>
                ) : (
                  <div
                    ref={sized ? virtualizer.measureElement : undefined}
                    data-index={index}
                    aria-hidden="true"
                    style={{ height: BOARD_CARD_ESTIMATE }}
                  />
                )}
              </div>
            );
          })}
          {tail > 0 && <div aria-hidden="true" style={{ height: tail }} />}
        </SortableContext>
        {canCreate && (
          <QuickAdd projectId={projectId} statusId={status.id} onCreated={onCreated} />
        )}
      </div>
    </div>
  );
}
