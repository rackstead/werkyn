import { useCallback, useEffect, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { taskListSearchParams, type Task } from "@/features/tasks/api";
import { BOARD_ID_PAGE, BOARD_PAGE_SIZE } from "./board-window";

export interface BoardColumnPage {
  statusId: string;
  total: number;
  size: number;
  offset: number;
  ids?: string[];
}

export interface BoardWindowResponse {
  data: Array<Task & { columnIndex?: number }>;
  columns: BoardColumnPage[];
  aligned: boolean;
}

export interface AssembledColumn {
  statusId: string;
  total: number;
  size: number;
  aligned: boolean;
  /** Display order. "" is a task whose id has not been loaded. Length is `total`. */
  order: string[];
  tasks: Map<string, Task & { columnIndex: number }>;
  columnIndex: Map<string, number>;
  complete: boolean;
}

interface PageRequest {
  statusId: string;
  offset: number;
  ids: boolean;
}

export function assembleBoardColumns(pages: readonly BoardWindowResponse[]): Map<string, AssembledColumn> {
  const columns = new Map<string, AssembledColumn>();
  for (const response of pages) {
    const byStatus = new Map<string, BoardWindowResponse["data"]>();
    for (const task of response.data) {
      const list = byStatus.get(task.statusId);
      if (list) list.push(task);
      else byStatus.set(task.statusId, [task]);
    }
    for (const page of response.columns) {
      let column = columns.get(page.statusId);
      if (!column || column.order.length !== page.total) {
        const order = new Array<string>(page.total).fill("");
        if (column) {
          for (let index = 0; index < Math.min(column.order.length, order.length); index++) {
            order[index] = column.order[index];
          }
        }
        column = {
          statusId: page.statusId,
          total: page.total,
          size: page.size,
          aligned: response.aligned,
          order,
          tasks: column?.tasks ?? new Map(),
          columnIndex: column?.columnIndex ?? new Map(),
          complete: false,
        };
        columns.set(page.statusId, column);
      }
      column.total = page.total;
      column.size = page.size;
      column.aligned = response.aligned;
      const ids = page.ids ?? (byStatus.get(page.statusId) ?? []).map((task) => task.id);
      ids.forEach((id, index) => {
        if (!id || !column) return;
        const at = page.offset + index;
        // A task that moved between pages must not stay in its old slot.
        for (let slot = 0; slot < column.order.length; slot++) {
          if (slot !== at && column.order[slot] === id) column.order[slot] = "";
        }
        if (at >= 0 && at < column.order.length) column.order[at] = id;
      });
      for (const task of byStatus.get(page.statusId) ?? []) {
        const columnIndex = task.columnIndex ?? (response.aligned ? page.offset : 0);
        const stored = { ...task, columnIndex };
        column.tasks.set(task.id, stored);
        column.columnIndex.set(task.id, columnIndex);
      }
    }
  }
  for (const column of columns.values()) {
    column.complete = column.order.length === 0 || column.order.every((id) => id !== "");
  }
  return columns;
}

function fetchBoard(
  projectId: string,
  filters: Record<string, unknown> | undefined,
  window: { perColumn: number; status?: string; columnOffset?: number; columnIds?: boolean },
) {
  return api
    .get(`projects/${projectId}/tasks`, {
      searchParams: taskListSearchParams(filters, {
        view: "board",
        perColumn: window.perColumn,
        status: window.status,
        columnOffset: window.columnOffset,
        columnIds: window.columnIds ? true : undefined,
      }),
    })
    .json<BoardWindowResponse>();
}

export function useBoardColumns(projectId: string, filters?: Record<string, unknown>) {
  const filterKey = JSON.stringify(filters ?? {});
  const [requests, setRequests] = useState<{ filterKey: string; pages: PageRequest[] }>({
    filterKey,
    pages: [],
  });
  if (requests.filterKey !== filterKey) {
    setRequests({ filterKey, pages: [] });
  }
  const pages = requests.filterKey === filterKey ? requests.pages : [];

  const first = useQuery({
    queryKey: queryKeys.tasks(projectId, { ...filters, board: "window", perColumn: BOARD_PAGE_SIZE }),
    queryFn: () => fetchBoard(projectId, filters, { perColumn: BOARD_PAGE_SIZE }),
    enabled: !!projectId,
  });

  const extras = useQueries({
    queries: pages.map((page) => ({
      queryKey: queryKeys.tasks(projectId, {
        ...filters,
        board: "window",
        status: page.statusId,
        offset: page.offset,
        ids: page.ids,
      }),
      queryFn: () =>
        fetchBoard(projectId, filters, {
          perColumn: page.ids ? BOARD_ID_PAGE : BOARD_PAGE_SIZE,
          status: page.statusId,
          columnOffset: page.offset,
          columnIds: page.ids,
        }),
      enabled: !!projectId,
    })),
  });

  const freshAt = first.dataUpdatedAt;
  const responses: BoardWindowResponse[] = [];
  if (first.data) responses.push(first.data);
  // A page fetched before the latest first page still has the previous
  // totals and ids. Using it beside the new first page duplicates cards.
  for (const query of extras) {
    if (query.data && query.dataUpdatedAt >= freshAt) responses.push(query.data);
  }
  // dataUpdatedAt changes when a refetch replaces the response, including a
  // label change that does not touch the task row's own timestamp. It does
  // not walk the id list, so a drag's renders do not stringify every id.
  const signature = [freshAt, ...extras.map((query) => query.dataUpdatedAt)].join(",");
  const assembled = useRef<{ signature: string; columns: Map<string, AssembledColumn> }>({
    signature: "",
    columns: new Map(),
  });
  if (assembled.current.signature !== signature) {
    assembled.current = { signature, columns: assembleBoardColumns(responses) };
  }
  const columns = assembled.current.columns;

  const ensureRange = useCallback((statusId: string, start: number, end: number) => {
    if (end < start) return;
    setRequests((current) => {
      const have = new Set(
        (current.filterKey === filterKey ? current.pages : [])
          .filter((page) => page.statusId === statusId && !page.ids)
          .map((page) => page.offset),
      );
      const pages = current.filterKey === filterKey ? [...current.pages] : [];
      let changed = current.filterKey !== filterKey;
      for (let offset = Math.floor(start / BOARD_PAGE_SIZE) * BOARD_PAGE_SIZE; offset <= end; offset += BOARD_PAGE_SIZE) {
        if (offset === 0 || have.has(offset)) continue;
        have.add(offset);
        pages.push({ statusId, offset, ids: false });
        changed = true;
      }
      return changed ? { filterKey, pages } : current;
    });
  }, [filterKey]);

  // Ids for the rest of each column. Task bodies stay paged; this list is the
  // whole column order anchoring uses. One missing page per column is enough:
  // the next hole is asked for once that page is part of the order.
  useEffect(() => {
    if (!first.data) return;
    setRequests((current) => {
      if (current.filterKey !== filterKey) return current;
      const pages = [...current.pages];
      let changed = false;
      for (const assembled of columns.values()) {
        if (assembled.complete) continue;
        const hole = assembled.order.findIndex((id) => id === "");
        if (hole < 0) continue;
        const offset = Math.floor(hole / BOARD_ID_PAGE) * BOARD_ID_PAGE;
        if (pages.some((page) => page.ids && page.statusId === assembled.statusId && page.offset === offset)) continue;
        pages.push({ statusId: assembled.statusId, offset, ids: true });
        changed = true;
      }
      return changed ? { filterKey, pages } : current;
    });
  }, [columns, first.data, filterKey]);

  return {
    columns,
    aligned: first.data?.aligned ?? true,
    isLoading: first.isLoading,
    isFetching: first.isFetching || extras.some((query) => query.isFetching),
    dataUpdatedAt: first.dataUpdatedAt,
    ensureRange,
  };
}
