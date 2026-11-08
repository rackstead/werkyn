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
  const virtualizer = useVirtualizer({
    count,
    enabled: sized,
    getScrollElement: () => scroller,
    initialOffset: () => scroller?.scrollTop ?? 0,
    estimateSize: () => BOARD_CARD_ESTIMATE,
    overscan: BOARD_OVERSCAN,
    rangeExtractor,
    getItemKey,
  });
  // Cards sit in normal flow. A card that is taller than the estimate already
  // pushes the cards under it; correcting here as well would move them twice.
  if (sized) virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

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
  const keepInView = useCallback(() => {
    const node = scroller;
    if (!node) return;
    if (pauseAnchor) {
      seen.current = null;
      return;
    }
    const current = orderRef.current;
    const last = seen.current;
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
      if (smallScroll && last.complete && complete && !sameIds(last.order, current)) {
        kept = keptBoardCards(last.rows, last.order, indexOf)[0];
      } else if (smallScroll && !sameIds(last.order, current)) {
        const shifts = last.rows.flatMap((row) => {
          const now = indexOf(row.key);
          return now === undefined ? [] : [{ row, now, shift: now - row.index }];
        });
        if (shifts.length > 0 && shifts.every((item) => item.shift === shifts[0].shift)) {
          const first = shifts[0];
          kept = { key: first.row.key, top: first.row.top, index: first.now };
        }
      }
      if (kept) {
        let card: HTMLElement | undefined;
        for (const candidate of node.querySelectorAll<HTMLElement>("[data-task-id]")) {
          if (candidate.dataset.taskId === kept.key) {
            card = candidate;
            break;
          }
        }
        if (card) {
          const want = kept.top - scrolled;
          const moved = card.getBoundingClientRect().top - node.getBoundingClientRect().top - want;
          if (Math.abs(moved) >= 1) node.scrollTop += moved;
        } else {
          const item = virtualizer.measurementsCache[kept.index];
          if (item) node.scrollTop = Math.max(0, item.start - (kept.top - scrolled));
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

  return (
    <div className="flex w-72 flex-shrink-0 flex-col">
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
        className="flex flex-1 flex-col overflow-y-auto rounded-lg p-1 min-h-[120px]"
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
