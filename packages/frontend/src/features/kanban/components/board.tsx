import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  pointerWithin,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  type CollisionDetection,
  defaultDropAnimationSideEffects,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useMoveTask, type Task } from "@/features/tasks/api";
import { useStatuses } from "@/features/projects/api";
import { Column } from "./column";
import { DragOverlayCard } from "./drag-overlay-card";
import { useBoardColumns, type AssembledColumn } from "../lib/use-board-columns";
import {
  previewBoardMove,
  resolveBoardDrop,
  type BoardDropColumn,
} from "../lib/board-window";

interface BoardProps {
  projectId: string;
  filters?: Record<string, unknown>;
  onTaskClick: (taskId: string) => void;
  canCreate: boolean;
  canDrag: boolean;
}

function buildKanbanCollision(columnIds: Set<string>): CollisionDetection {
  return (args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length === 0) {
      return closestCenter(args);
    }
    const hitIds = new Set(pointerCollisions.map((collision) => collision.id));
    const taskHits = args.droppableContainers.filter(
      (container) => hitIds.has(container.id) && !columnIds.has(String(container.id)),
    );
    if (taskHits.length > 0) {
      return closestCenter({ ...args, droppableContainers: taskHits });
    }
    return pointerCollisions;
  };
}

const dropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: "0.5" } },
  }),
};

function dropColumns(statuses: { id: string }[], assembled: Map<string, AssembledColumn>): BoardDropColumn[] {
  return statuses.map((status) => {
    const column = assembled.get(status.id);
    return {
      statusId: status.id,
      size: column?.size ?? 0,
      order: column?.order ?? [],
      columnIndex: column?.columnIndex ?? new Map(),
      aligned: column?.aligned ?? true,
    };
  });
}

function pointerClientY(event: DragEndEvent): number | undefined {
  const activator = event.activatorEvent;
  if (!activator || !("clientY" in activator) || typeof activator.clientY !== "number") return undefined;
  // Keyboard drags report clientY 0. A pointer or mouse event is a real point.
  if (activator instanceof KeyboardEvent) return undefined;
  return activator.clientY + event.delta.y;
}

export function Board({
  projectId,
  filters,
  onTaskClick,
  canCreate,
  canDrag,
}: BoardProps) {
  const { data: statusesData } = useStatuses(projectId);
  const board = useBoardColumns(projectId, filters);
  const moveTask = useMoveTask(projectId);

  const statuses = useMemo(
    () => (statusesData?.data ?? []).sort((a, b) => a.position - b.position),
    [statusesData],
  );
  const columnIds = useMemo(() => new Set(statuses.map((status) => status.id)), [statuses]);
  const collisionDetection = useMemo(() => buildKanbanCollision(columnIds), [columnIds]);

  const [localOrders, setLocalOrders] = useState<Map<string, string[]> | null>(null);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [overIndex, setOverIndex] = useState<{ statusId: string; index: number } | null>(null);
  const [reveal, setReveal] = useState<Record<string, number>>({});
  const snapshot = useRef<BoardDropColumn[]>([]);
  const originOrders = useRef<Map<string, readonly string[]> | null>(null);
  const indexAt = useRef(new Map<string, (clientY: number) => number>());
  const dropMark = useRef<number | null>(null);

  useEffect(() => {
    // Wait until the pages that were invalidated have settled. Clearing the
    // preview on the first page alone puts the card back until later pages land.
    if (dropMark.current !== null && !board.isFetching && board.dataUpdatedAt !== dropMark.current) {
      setLocalOrders(null);
      dropMark.current = null;
    }
  }, [board.dataUpdatedAt, board.isFetching]);

  const registerIndexAt = useCallback((statusId: string, fn: ((clientY: number) => number) | null) => {
    if (fn) indexAt.current.set(statusId, fn);
    else indexAt.current.delete(statusId);
  }, []);

  const taskById = useCallback((id: string) => {
    for (const column of board.columns.values()) {
      const task = column.tasks.get(id);
      if (task) return task;
    }
    return undefined;
  }, [board.columns]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const task = taskById(String(event.active.id));
    if (!task) return;
    snapshot.current = dropColumns(statuses, board.columns);
    originOrders.current = new Map(snapshot.current.map((column) => [column.statusId, column.order]));
    setActiveTask(task);
    setLocalOrders(new Map(snapshot.current.map((column) => [column.statusId, [...column.order]])));
  }, [board.columns, statuses, taskById]);

  const localOrdersRef = useRef(localOrders);
  localOrdersRef.current = localOrders;
  const handleDragOver = useCallback((event: DragOverEvent) => {
    const overId = event.over ? String(event.over.id) : "";
    const activeId = String(event.active.id);
    const origin = originOrders.current;
    if (!overId || !origin) return;
    // Always from the order at drag start, so the same hover does not flip
    // the preview on the next event.
    const next = previewBoardMove(origin, activeId, overId, columnIds);
    const shown = next ?? localOrdersRef.current;
    if (next) {
      localOrdersRef.current = next;
      setLocalOrders(next);
    }
    if (columnIds.has(overId) || !shown) {
      setOverIndex(null);
      return;
    }
    for (const [statusId, order] of shown) {
      const index = order.indexOf(overId);
      if (index >= 0) {
        setOverIndex({ statusId, index });
        break;
      }
    }
  }, [columnIds]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveTask(null);
    setOverIndex(null);
    const overId = event.over ? String(event.over.id) : "";
    const activeId = String(event.active.id);
    if (!overId) {
      setLocalOrders(null);
      return;
    }
    const y = pointerClientY(event);
    const pointer = columnIds.has(overId) && y !== undefined
      ? { statusId: overId, slot: indexAt.current.get(overId)?.(y) ?? 0 }
      : undefined;
    // The pointer slot is an index in the order on screen, which the drag
    // preview may already have changed. Column indexes stay the ones from
    // drag start: that is the list the move API renumbers.
    const drop = resolveBoardDrop(snapshot.current, localOrdersRef.current, activeId, overId, pointer);
    if (!drop) {
      setLocalOrders(null);
      return;
    }
    dropMark.current = board.dataUpdatedAt;
    moveTask.mutate(
      { id: activeId, statusId: drop.statusId, position: drop.position },
      { onError: () => { setLocalOrders(null); dropMark.current = null; } },
    );
  }, [board.dataUpdatedAt, columnIds, moveTask]);

  const handleDragCancel = useCallback(() => {
    setActiveTask(null);
    setOverIndex(null);
    setLocalOrders(null);
    dropMark.current = null;
  }, []);

  if (board.isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex gap-4 overflow-x-auto p-4 h-full">
        {statuses.map((status) => {
          const column = board.columns.get(status.id);
          const order = localOrders?.get(status.id) ?? column?.order ?? [];
          const activeIndex = activeTask ? order.indexOf(activeTask.id) : -1;
          const pins = [
            activeIndex,
            overIndex?.statusId === status.id ? overIndex.index : -1,
          ].filter((index) => index >= 0);
          return (
            <Column
              key={status.id}
              status={status}
              column={column}
              order={order}
              projectId={projectId}
              onTaskClick={onTaskClick}
              canCreate={canCreate}
              canDrag={canDrag}
              pins={pins}
              followIndex={overIndex?.statusId === status.id ? overIndex.index : null}
              pauseAnchor={localOrders !== null}
              reveal={reveal[status.id] ?? 0}
              onRange={(start, end) => board.ensureRange(status.id, start, end)}
              registerIndexAt={registerIndexAt}
              onCreated={() => setReveal((current) => ({ ...current, [status.id]: (current[status.id] ?? 0) + 1 }))}
            />
          );
        })}
      </div>
      <DragOverlay dropAnimation={dropAnimation}>
        {activeTask ? <DragOverlayCard task={activeTask} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
