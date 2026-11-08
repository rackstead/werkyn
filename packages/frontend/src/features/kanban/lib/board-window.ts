import { steadyRows, type SeenRow } from "@/features/list-view/components/steady-row";

/** Task bodies requested for each column on the first board read, and for each later page. */
export const BOARD_PAGE_SIZE = 40;
/** Ids in board order, fetched after the first paint so a column can be anchored. */
export const BOARD_ID_PAGE = 500;
/** Cards mounted on either side of the visible range. */
export const BOARD_OVERSCAN = 4;
/** Height of a card plus the gap under it, until one is measured. */
export const BOARD_CARD_ESTIMATE = 92;

export interface BoardTaskRef {
  id: string;
  statusId: string;
  /** Index in the whole active column. This is what the move API stores. */
  columnIndex: number;
}

export interface BoardDropColumn {
  statusId: string;
  /** Active tasks in the column, ignoring filters. */
  size: number;
  /** Filtered display order. Empty strings are tasks whose ids are not loaded yet. */
  order: readonly string[];
  columnIndex: ReadonlyMap<string, number>;
  /** Display index equals columnIndex. False when a filter (or a non-board sort) hides tasks. */
  aligned: boolean;
}

/**
 * Move position for a drop on `slot` in the destination column's display
 * order. The result is a 0-based index into the whole active column with the
 * dragged task removed — never an index among the cards currently mounted.
 *
 * `slot` is the hovered card's columnIndex when the pointer is on a card,
 * or the display slot under the pointer when it is on the column itself.
 * `slot === order length` (passed as `finalIndex`) appends.
 */
export function movePosition(
  active: { statusId: string; columnIndex: number },
  destStatusId: string,
  finalIndex: number,
  destSize: number,
): number {
  const same = active.statusId === destStatusId;
  const max = same ? Math.max(0, destSize - 1) : destSize;
  if (finalIndex < 0) return 0;
  return Math.min(finalIndex, max);
}

/** Display slot under a pointer, from the top of the column's content. `count` appends. */
export function indexAtOffset(offset: number, count: number, stride: number): number {
  if (count <= 0 || stride <= 0) return 0;
  if (offset < 0) return 0;
  const slot = Math.floor(offset / stride);
  return slot > count ? count : slot;
}

/**
 * Where a drop lands. `overId` is a task id or a column id. A task that is
 * not mounted still resolves, as long as its columnIndex is known: the index
 * sent to the move API is that columnIndex, not the task's place among the
 * mounted cards.
 */
export function dropPositionFromOver(
  columns: readonly BoardDropColumn[],
  activeId: string,
  overId: string,
  pointer?: { statusId: string; slot: number },
): { statusId: string; position: number } | null {
  if (overId === activeId) return null;
  const active = findTask(columns, activeId);
  if (!active) return null;
  const overColumn = columns.find((column) => column.statusId === overId);
  if (overColumn) {
    const slot = pointer && pointer.statusId === overColumn.statusId ? pointer.slot : overColumn.order.length;
    const finalIndex = columnIndexAt(overColumn, slot, activeId);
    if (finalIndex === undefined) return null;
    return {
      statusId: overColumn.statusId,
      position: movePosition(active, overColumn.statusId, finalIndex, overColumn.size),
    };
  }
  const over = findTask(columns, overId);
  if (!over) return null;
  return {
    statusId: over.statusId,
    position: movePosition(active, over.statusId, over.columnIndex, columnSize(columns, over.statusId)),
  };
}

/**
 * Drop position after a drag preview. dnd-kit often reports the dragged card
 * as the target once the preview has moved it under the pointer. That is
 * still a move: the live order says where it landed. The index is the
 * following card's place in the whole column (the column size when the card
 * is last), not an index into the mounted window.
 */
export function resolveBoardDrop(
  snapshot: readonly BoardDropColumn[],
  liveOrders: ReadonlyMap<string, readonly string[]> | null,
  activeId: string,
  overId: string,
  pointer?: { statusId: string; slot: number },
): { statusId: string; position: number } | null {
  const columns = snapshot.map((column) => {
    const order = liveOrders?.get(column.statusId);
    return order ? { ...column, order } : column;
  });
  if (overId !== activeId) return dropPositionFromOver(columns, activeId, overId, pointer);
  if (!liveOrders) return null;
  let destStatus = "";
  let index = -1;
  for (const [statusId, order] of liveOrders) {
    const at = order.indexOf(activeId);
    if (at >= 0) {
      destStatus = statusId;
      index = at;
      break;
    }
  }
  if (index < 0) return null;
  const origin = snapshot.find((column) => column.columnIndex.has(activeId));
  const dest = snapshot.find((column) => column.statusId === destStatus);
  if (!origin || !dest) return null;
  const liveOrigin = liveOrders.get(origin.statusId);
  if (origin.statusId === destStatus && liveOrigin && sameIds(origin.order, liveOrigin)) return null;
  const active = { statusId: origin.statusId, columnIndex: origin.columnIndex.get(activeId) ?? 0 };
  const live = liveOrders.get(destStatus) ?? [];
  let following = "";
  for (let cursor = index + 1; cursor < live.length; cursor++) {
    if (live[cursor]) {
      following = live[cursor];
      break;
    }
  }
  let finalIndex = dest.size;
  if (following) {
    const nextIndex = dest.columnIndex.get(following);
    if (nextIndex === undefined) {
      if (!dest.aligned) return null;
      finalIndex = index;
    } else if (origin.statusId === destStatus && active.columnIndex < nextIndex) {
      finalIndex = nextIndex - 1;
    } else {
      finalIndex = nextIndex;
    }
  }
  return { statusId: destStatus, position: movePosition(active, destStatus, finalIndex, dest.size) };
}

function sameIds(a: readonly string[], b: readonly string[]) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function columnSize(columns: readonly BoardDropColumn[], statusId: string) {
  return columns.find((column) => column.statusId === statusId)?.size ?? 0;
}

function findTask(columns: readonly BoardDropColumn[], id: string): (BoardTaskRef & { statusId: string }) | undefined {
  for (const column of columns) {
    const columnIndex = column.columnIndex.get(id);
    if (columnIndex !== undefined) return { id, statusId: column.statusId, columnIndex };
  }
  return undefined;
}

/** columnIndex of the display slot, or the column size when the slot appends. */
export function columnIndexAt(column: BoardDropColumn, slot: number, activeId: string): number | undefined {
  if (slot >= column.order.length) return column.size;
  const id = column.order[slot];
  if (id && id !== activeId) {
    const index = column.columnIndex.get(id);
    if (index !== undefined) return index;
  }
  if (column.aligned) return Math.min(slot, column.size);
  for (let index = slot; index < column.order.length; index++) {
    const next = column.order[index];
    if (next && next !== activeId) {
      const columnIndex = column.columnIndex.get(next);
      if (columnIndex !== undefined) return columnIndex;
    }
  }
  return column.size;
}

/**
 * Cards that stayed on screen. `before` is the whole column order that was
 * loaded, not the mounted window: a block moved out of the view must not
 * outweigh the cards that kept their order (the same rule as the List).
 */
export function keptBoardCards(
  seen: readonly SeenRow[],
  before: readonly string[],
  indexOf: (key: string) => number | undefined,
) {
  if (before.length === 0 || seen.length === 0) return [];
  return steadyRows(seen, indexOf, { before });
}

/** Move `from` so it ends at display index `to` (the hovered card's index). */
export function moveDisplayId(order: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= order.length || to < 0 || to > order.length || from === to) return [...order];
  const next = [...order];
  const [id] = next.splice(from, 1);
  next.splice(Math.min(to, next.length), 0, id);
  return next;
}

/**
 * Live reorder while dragging. Same rules as the board had when every card
 * was mounted: dragging down inserts after the hovered card, dragging up
 * inserts before it, and a column drop appends. The move request does not
 * use this order; it uses column indexes from before the drag.
 */
export function previewBoardMove(
  orders: ReadonlyMap<string, readonly string[]>,
  activeId: string,
  overId: string,
  columnIds: ReadonlySet<string>,
): Map<string, string[]> | null {
  const cols = new Map([...orders].map(([statusId, order]) => [statusId, [...order]]));
  let fromStatus = "";
  let from = -1;
  for (const [statusId, order] of cols) {
    const index = order.indexOf(activeId);
    if (index >= 0) {
      fromStatus = statusId;
      from = index;
      break;
    }
  }
  if (from < 0) return null;
  const overColumn = columnIds.has(overId);
  let toStatus = overColumn ? overId : "";
  if (!overColumn) {
    for (const [statusId, order] of cols) {
      if (order.includes(overId)) {
        toStatus = statusId;
        break;
      }
    }
  }
  if (!toStatus || !cols.has(toStatus)) return null;
  if (fromStatus === toStatus && (overColumn || activeId === overId)) return null;
  const source = cols.get(fromStatus)!;
  const dest = cols.get(toStatus)!;
  const [removed] = source.splice(from, 1);
  if (!overColumn) {
    const overIndex = dest.indexOf(overId);
    if (overIndex < 0) dest.push(removed);
    else if (fromStatus === toStatus) dest.splice(from <= overIndex ? overIndex + 1 : overIndex, 0, removed);
    else dest.splice(overIndex, 0, removed);
  } else {
    dest.push(removed);
  }
  return cols;
}

export function moveIdAcross(
  source: readonly string[],
  from: number,
  dest: readonly string[],
  to: number,
): { source: string[]; dest: string[] } {
  if (from < 0 || from >= source.length) return { source: [...source], dest: [...dest] };
  const nextSource = [...source];
  const [id] = nextSource.splice(from, 1);
  const nextDest = [...dest];
  nextDest.splice(Math.max(0, Math.min(to, nextDest.length)), 0, id);
  return { source: nextSource, dest: nextDest };
}
