import {
  Fragment,
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
} from "@tanstack/react-virtual";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type Row,
  type RowSelectionState,
} from "@tanstack/react-table";
import { useProjectTasks, type Task } from "@/features/tasks/api";
import { useStatuses, useProjectMembers, useLabels, useCustomFields } from "@/features/projects/api";
import { getColumns } from "./columns";
import { ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// Heights assumed for rows not rendered yet; rendered rows are measured.
// The estimates stay fixed: changing them would move every row not yet
// measured, including those above the view.
const GROUP_ROW_ESTIMATE = 33;
const TASK_ROW_ESTIMATE = 41;
// Rows rendered beyond each edge of the visible area.
const OVERSCAN = 8;
// The title column takes the width the other columns leave, but no less.
const TITLE_MIN_WIDTH = 240;

interface TaskRowProps {
  row: Row<Task>;
  // Cells read these through the row; they are props so that a memoized row
  // renders again when its selection or the column definitions change.
  selected: boolean;
  columns: readonly unknown[];
  color: string;
  index: number;
  ariaRowIndex: number;
  rowKey: string;
  measureRow?: (element: HTMLTableRowElement | null) => void;
  onRowFocus?: (key: string) => void;
}

// Memoized: scrolling re-renders the table, and only rows coming into view
// need to render.
const TaskRow = memo(function TaskRow({
  row,
  selected,
  color,
  index,
  ariaRowIndex,
  rowKey,
  measureRow,
  onRowFocus,
}: TaskRowProps) {
  const cells = row.getVisibleCells();
  return (
    <tr
      ref={measureRow}
      data-index={index}
      data-task-id={row.id}
      aria-rowindex={ariaRowIndex}
      onFocus={onRowFocus && (() => onRowFocus(rowKey))}
      className={cn(
        "border-b hover:bg-accent/50 transition-colors",
        selected && "bg-primary/5",
      )}
      style={{ borderLeft: `4px solid ${color}` }}
    >
      {cells.map((cell, i) => (
        <td
          key={cell.id}
          className={cn(
            "px-3 py-1.5",
            i < cells.length - 1 && "border-r border-border",
          )}
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  );
});

interface TaskTableProps {
  projectId: string;
  filters?: Record<string, unknown>;
  onTaskClick: (taskId: string) => void;
  canEdit: boolean;
  rowSelection: RowSelectionState;
  onRowSelectionChange: (selection: RowSelectionState) => void;
  onUpdateTask: (id: string, data: Record<string, unknown>) => void;
}

export function TaskTable({
  projectId,
  filters,
  onTaskClick,
  canEdit,
  rowSelection,
  onRowSelectionChange,
  onUpdateTask,
}: TaskTableProps) {
  const { data, isLoading } = useProjectTasks(projectId, filters);
  const { data: statusData } = useStatuses(projectId);
  const { data: membersData } = useProjectMembers(projectId);
  const { data: labelsData } = useLabels(projectId);
  const { data: customFieldsData } = useCustomFields(projectId);

  const tasks = data?.data ?? [];
  const statuses = useMemo(
    () => [...(statusData?.data ?? [])].sort((a, b) => a.position - b.position),
    [statusData],
  );
  const members = useMemo(
    () => (membersData?.data ?? []).map((m) => m.user),
    [membersData],
  );
  const projectLabels = useMemo(
    () => (labelsData?.data ?? []).map((l) => ({ id: l.id, name: l.name, color: l.color })),
    [labelsData],
  );
  const customFields = useMemo(
    () => customFieldsData?.data ?? [],
    [customFieldsData],
  );

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );

  const columns = useMemo(
    () => getColumns({ canEdit, onTaskClick, onUpdateTask, statuses, members, projectLabels, customFields }),
    [canEdit, onTaskClick, onUpdateTask, statuses, members, projectLabels, customFields],
  );

  const table = useReactTable({
    data: tasks,
    columns,
    state: { rowSelection },
    onRowSelectionChange: (updater) => {
      const next =
        typeof updater === "function" ? updater(rowSelection) : updater;
      onRowSelectionChange(next);
    },
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    enableRowSelection: canEdit,
  });

  const tasksByStatus = useMemo(() => {
    const map = new Map<string, typeof tasks>();
    for (const status of statuses) {
      map.set(status.id, []);
    }
    for (const task of tasks) {
      const group = map.get(task.statusId);
      if (group) {
        group.push(task);
      } else {
        map.set(task.statusId, [task]);
      }
    }
    // Sort tasks within each group by position
    for (const group of map.values()) {
      group.sort((a, b) => a.position - b.position);
    }
    return map;
  }, [tasks, statuses]);

  const toggleCollapse = (statusId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(statusId)) {
        next.delete(statusId);
      } else {
        next.add(statusId);
      }
      return next;
    });
  };

  // Get row models for rendering cells via TanStack Table
  const rowModel = table.getRowModel();
  const rowById = useMemo(() => {
    const map = new Map<string, (typeof rowModel.rows)[number]>();
    for (const row of rowModel.rows) {
      map.set(row.id, row);
    }
    return map;
  }, [rowModel.rows]);

  // The List renders one row per status group header and, unless the group is
  // collapsed, one per task in it. Only rows in or near the visible part of
  // the workspace <main> scroller are in the DOM; spacer rows hold the height
  // of the rest. The task data, row model and selection still cover every
  // loaded task (select-all, group counts and bulk actions are unchanged).
  const listRows = useMemo(() => {
    const rows: Array<{
      key: string;
      status: (typeof statuses)[number];
      taskId?: string;
    }> = [];
    for (const status of statuses) {
      rows.push({ key: `status:${status.id}`, status });
      if (collapsedGroups.has(status.id)) continue;
      for (const task of tasksByStatus.get(status.id) ?? []) {
        rows.push({ key: `task:${task.id}`, status, taskId: task.id });
      }
    }
    return rows;
  }, [statuses, tasksByStatus, collapsedGroups]);

  const tableRef = useRef<HTMLTableElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  // undefined until the table is in the DOM; null when it has no <main>
  // ancestor to scroll it, in which case every row is rendered.
  const [scroller, setScroller] = useState<HTMLElement | null>();
  // Offset of the first body row from the top of the scroller's content.
  const [scrollMargin, setScrollMargin] = useState(0);

  // The row that last held focus, with its neighbours, stays rendered while
  // scrolled out of view: an open inline editor keeps its draft until it is
  // saved on blur, a popover keeps its trigger, focus can return to the task
  // title when the task panel closes, and Tab / Shift+Tab reach the next and
  // previous rows.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const onRowFocus = useCallback((key: string) => setFocusedKey(key), []);
  const focusedIndex = useMemo(
    () =>
      focusedKey === null
        ? -1
        : listRows.findIndex((row) => row.key === focusedKey),
    [listRows, focusedKey],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      // The first and last rows are always rendered too, so Tab into the
      // table from above (the header checkbox) reaches the first row and
      // Shift+Tab from below reaches the last, as with every row rendered.
      const keep = new Set(defaultRangeExtractor(range));
      if (range.count > 0) keep.add(0).add(range.count - 1);
      if (focusedIndex >= 0) {
        const last = Math.min(range.count - 1, focusedIndex + 1);
        for (let i = Math.max(0, focusedIndex - 1); i <= last; i++) keep.add(i);
      }
      return [...keep].sort((a, b) => a - b);
    },
    [focusedIndex],
  );

  // Stable unless the rows change: the virtualizer recomputes every row's
  // position when this function changes.
  const getItemKey = useCallback((index: number) => listRows[index].key, [listRows]);
  const virtualizer = useVirtualizer({
    count: listRows.length,
    enabled: !!scroller,
    getScrollElement: () => scroller ?? null,
    // Start from where <main> already is rather than scrolling it to the top.
    initialOffset: () => scroller?.scrollTop ?? 0,
    scrollMargin,
    estimateSize: (index) =>
      listRows[index].taskId === undefined
        ? GROUP_ROW_ESTIMATE
        : TASK_ROW_ESTIMATE,
    getItemKey,
    rangeExtractor,
    overscan: OVERSCAN,
    measureElement: (element) => element.getBoundingClientRect().height,
  });
  // Rows are laid out in normal table flow, so a row that turns out taller
  // or shorter than its estimate already moves the rows after it in the
  // DOM; keepRowsInView below corrects for that. The virtualizer's own
  // correction would move them a second time.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

  // The rows in view stay where they are when rows above them change: tasks
  // created, deleted or moved by others or by a bulk action, rows rendered
  // at a height other than their estimate, an editor above the view
  // closing. The first rows in view are remembered with their place and the
  // scroll position; after a change, <main> scrolls by however far they
  // moved other than by scrolling. The browser's scroll anchoring is off for
  // the table: it did not apply to these changes, and together they would
  // move the rows twice. Nothing is kept at the very top of the list.
  const inView = useRef<{
    scrollTop: number;
    rows: Array<{ row: HTMLTableRowElement; top: number }>;
  } | null>(null);
  const keepRowsInView = useCallback(() => {
    const body = bodyRef.current;
    if (!scroller || !body) return;
    const viewTop = scroller.getBoundingClientRect().top;
    const last = inView.current;
    // Scroll positions are whole pixels; what a correction could not make up
    // is carried over, so repeated changes do not add up to a visible drift.
    let remainder = 0;
    if (last && scroller.scrollTop > 0) {
      const kept = last.rows.find(({ row }) => row.parentNode === body);
      if (kept) {
        const scrolled = scroller.scrollTop - last.scrollTop;
        const want = kept.top - scrolled;
        const moved = kept.row.getBoundingClientRect().top - viewTop - want;
        if (Math.abs(moved) >= 0.5) scroller.scrollTop += moved;
        remainder = kept.row.getBoundingClientRect().top - viewTop - want;
      }
    }
    const rows: Array<{ row: HTMLTableRowElement; top: number }> = [];
    const viewBottom = viewTop + scroller.clientHeight;
    for (const row of body.rows) {
      if (row.hasAttribute("aria-hidden")) continue;
      const { top, bottom } = row.getBoundingClientRect();
      if (bottom <= viewTop) continue;
      if (top >= viewBottom || rows.length === 3) break;
      rows.push({ row, top: top - viewTop - remainder });
    }
    inView.current = { scrollTop: scroller.scrollTop, rows };
  }, [scroller]);
  // After every render of the table, before the browser paints.
  useLayoutEffect(keepRowsInView);

  const hasRows = !isLoading && tasks.length > 0;
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const main = table.closest("main");
    setScroller(main);
    if (!main) return;
    const measureMargin = () => {
      const body = bodyRef.current;
      const top =
        body && body.rows.length > 0
          ? body.getBoundingClientRect().top
          : (table.tHead ?? table).getBoundingClientRect().bottom;
      // Whole pixels: sub-pixel changes would only re-render the same rows.
      setScrollMargin(
        Math.round(
          top - main.getBoundingClientRect().top - main.clientTop + main.scrollTop,
        ),
      );
    };
    measureMargin();
    // Content above the table (such as the filter bar) can change height;
    // every ancestor up to <main> then changes size too.
    const observer = new ResizeObserver(measureMargin);
    for (let element: HTMLElement | null = table; element; element = element.parentElement) {
      observer.observe(element);
      if (element === main) break;
    }
    // Rows can change height without the table rendering (an inline editor
    // opening or closing); the body's size then changes.
    const body = bodyRef.current;
    const rowsObserver = new ResizeObserver(() => keepRowsInView());
    if (body) rowsObserver.observe(body);
    return () => {
      observer.disconnect();
      rowsObserver.disconnect();
    };
  }, [hasRows, keepRowsInView]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex items-center justify-center p-12 text-muted-foreground text-sm">
        No tasks found
      </div>
    );
  }

  const headerGroups = table.getHeaderGroups();
  const headerRows = headerGroups.length;
  const flexibleColumn = "title";
  const fixedColumnsWidth = (headerGroups[0]?.headers ?? []).reduce(
    (sum, header) =>
      header.column.id === flexibleColumn ? sum : sum + header.getSize(),
    0,
  );

  // Rows to render, each with the height of the spacer it needs before it.
  let rendered: Array<{ index: number; gapBefore: number }> = [];
  let gapAfter = 0;
  if (scroller === null) {
    rendered = listRows.map((_, index) => ({ index, gapBefore: 0 }));
  } else if (scroller) {
    let end = scrollMargin;
    for (const item of virtualizer.getVirtualItems()) {
      rendered.push({ index: item.index, gapBefore: Math.max(0, item.start - end) });
      end = item.end;
    }
    gapAfter = Math.max(0, virtualizer.getTotalSize() + scrollMargin - end);
  }
  const measureRow = scroller ? virtualizer.measureElement : undefined;
  const spacer = (height: number, key: string) => (
    // Spacers are not part of the table for assistive technology
    // (aria-rowcount and aria-rowindex describe the rows not rendered).
    <tr key={key} aria-hidden="true" style={{ height }}>
      <td colSpan={columns.length} style={{ height, padding: 0, border: 0 }} />
    </tr>
  );

  return (
    <div className="flex-1 overflow-auto">
      {/* Fixed layout: column widths come from the column sizes, not from
          the content of whichever rows happen to be rendered. The title
          column takes the rest of the width; with many columns the table
          is wider than the view and scrolls sideways. */}
      <table
        ref={tableRef}
        className="w-full table-fixed border-collapse text-sm"
        style={{
          minWidth: fixedColumnsWidth + TITLE_MIN_WIDTH,
          // See keepRowsInView.
          overflowAnchor: scroller ? "none" : undefined,
        }}
        aria-rowcount={headerRows + listRows.length}
      >
        <thead className="sticky top-0 z-10 bg-background border-b">
          {headerGroups.map((headerGroup, i) => (
            <tr key={headerGroup.id} aria-rowindex={i + 1}>
              {headerGroup.headers.map((header, i) => (
                <th
                  key={header.id}
                  className={cn(
                    "px-3 py-2 text-left text-xs font-medium text-muted-foreground",
                    i < headerGroup.headers.length - 1 &&
                      "border-r border-border",
                  )}
                  style={{
                    width:
                      header.column.id === flexibleColumn
                        ? undefined
                        : header.getSize(),
                  }}
                >
                  {flexRender(
                    header.column.columnDef.header,
                    header.getContext(),
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody ref={bodyRef}>
          {rendered.map(({ index, gapBefore }) => {
            const { key, status, taskId } = listRows[index];
            const color = status.color ?? "#94a3b8";
            const ariaRowIndex = headerRows + index + 1;

            if (taskId === undefined) {
              const isCollapsed = collapsedGroups.has(status.id);
              const groupSize = tasksByStatus.get(status.id)?.length ?? 0;
              return (
                <Fragment key={key}>
                  {gapBefore > 0 && spacer(gapBefore, `gap:${key}`)}
                  {/* Group header row */}
                  <tr
                    ref={measureRow}
                    data-index={index}
                    aria-rowindex={ariaRowIndex}
                    onFocus={scroller ? () => onRowFocus(key) : undefined}
                    className="bg-muted/30"
                  >
                    <td
                      colSpan={columns.length}
                      className="px-2 py-1.5"
                      style={{ borderLeft: `4px solid ${color}` }}
                    >
                      <button
                        onClick={() => toggleCollapse(status.id)}
                        className="flex items-center gap-2 w-full"
                      >
                        {isCollapsed ? (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span
                          className="font-semibold text-sm"
                          style={{ color }}
                        >
                          {status.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {groupSize} task
                          {groupSize !== 1 ? "s" : ""}
                        </span>
                      </button>
                    </td>
                  </tr>
                </Fragment>
              );
            }

            const row = rowById.get(taskId);
            if (!row) return null;
            return (
              <Fragment key={key}>
                {gapBefore > 0 && spacer(gapBefore, `gap:${key}`)}
                <TaskRow
                  row={row}
                  selected={row.getIsSelected()}
                  columns={columns}
                  color={color}
                  index={index}
                  ariaRowIndex={ariaRowIndex}
                  rowKey={key}
                  measureRow={measureRow}
                  onRowFocus={scroller ? onRowFocus : undefined}
                />
              </Fragment>
            );
          })}
          {gapAfter > 0 && spacer(gapAfter, "gap:end")}
        </tbody>
      </table>
    </div>
  );
}
