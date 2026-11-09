import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@/features/tasks/api";
import type { AssembledColumn } from "../lib/use-board-columns";
import { TaskCard } from "./task-card";
import { Board } from "./board";

const VIEW = 400;
const CARD = 92;
const TALL = 240;
const OPEN = 200;
const tallIds = new Set<string>();

const fixture = vi.hoisted(() => ({
  move: vi.fn(),
  create: vi.fn(),
  open: vi.fn(),
  ensureRange: vi.fn(),
  isLoading: false,
  dataUpdatedAt: 1,
  statuses: [
    { id: "open", name: "Open", color: "#888", position: 0, isCompletion: false },
    { id: "done", name: "Done", color: "#0a0", position: 1, isCompletion: true },
  ],
  columns: new Map<string, AssembledColumn>(),
}));

vi.mock("../lib/use-board-columns", () => ({
  useBoardColumns: () => ({
    columns: fixture.columns,
    aligned: true,
    isLoading: fixture.isLoading,
    dataUpdatedAt: fixture.dataUpdatedAt,
    isFetching: false,
    ensureRange: fixture.ensureRange,
  }),
}));
vi.mock("@/features/projects/api", () => ({
  useStatuses: () => ({ data: { data: fixture.statuses } }),
}));
vi.mock("@/features/tasks/api", () => ({
  useMoveTask: () => ({ mutate: fixture.move }),
  useCreateTask: () => ({
    mutate: (data: unknown, options?: { onSuccess?: () => void }) => {
      fixture.create(data);
      options?.onSuccess?.();
    },
    isPending: false,
  }),
}));

function task(id: string, statusId: string, columnIndex: number): Task & { columnIndex: number } {
  const status = fixture.statuses.find((item) => item.id === statusId)!;
  return {
    id,
    title: `${status.name} ${columnIndex}`,
    projectId: "p",
    statusId,
    status,
    position: columnIndex,
    priority: "NONE",
    dueDate: null,
    startDate: null,
    description: null,
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    assignees: [],
    labels: [],
    customFieldValues: [],
    _count: { subtasks: 0, blockedBy: 0 },
    columnIndex,
  };
}

function columnOf(statusId: string, count: number): AssembledColumn {
  const order = Array.from({ length: count }, (_, index) => `${statusId}-${index}`);
  const tasks = new Map<string, Task & { columnIndex: number }>();
  const columnIndex = new Map<string, number>();
  order.forEach((id, index) => {
    columnIndex.set(id, index);
    tasks.set(id, task(id, statusId, index));
  });
  return {
    statusId,
    total: count,
    size: count,
    aligned: true,
    order,
    tasks,
    columnIndex,
    complete: true,
  };
}

function heightFor(id: string | undefined) {
  return id && tallIds.has(id) ? TALL : CARD;
}

function startFor(index: number) {
  const order = fixture.columns.get("open")?.order ?? [];
  let start = 0;
  for (let i = 0; i < index && i < order.length; i++) start += heightFor(order[i]);
  return start;
}

function box(top: number, height: number) {
  return {
    x: 0, y: top, top, left: 0, right: 288, bottom: top + height, width: 288, height, toJSON() { return {}; },
  };
}

const openScroller = () => document.querySelector<HTMLElement>("[data-scroller='open']")!;
const openCards = () => [...openScroller().querySelectorAll<HTMLElement>("[data-task-id]")];

async function settle() {
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  fixture.move.mockReset();
  fixture.create.mockReset();
  fixture.open.mockReset();
  fixture.ensureRange.mockReset();
  fixture.isLoading = false;
  fixture.dataUpdatedAt = 1;
  tallIds.clear();
  fixture.columns = new Map([
    ["open", columnOf("open", OPEN)],
    ["done", columnOf("done", 2)],
  ]);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const height = function (this: HTMLElement) {
    if (this.dataset.scroller) return this.dataset.scroller === "open" ? VIEW : 300;
    if (this.dataset.index !== undefined) {
      const order = fixture.columns.get("open")?.order;
      return heightFor(order?.[Number(this.dataset.index)]);
    }
    return 0;
  };
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(height);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(height);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.scroller ? 100000 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.scroller) return box(0, this.dataset.scroller === "open" ? VIEW : 300);
    if (this.dataset.index !== undefined) {
      const scroller = this.closest<HTMLElement>("[data-scroller]");
      const index = Number(this.dataset.index);
      const order = fixture.columns.get("open")?.order;
      const top = startFor(index) - (scroller?.scrollTop ?? 0);
      return box(top, heightFor(order?.[index]));
    }
    if (this.dataset.taskId) {
      const indexed = this.closest<HTMLElement>("[data-index]");
      if (indexed) return indexed.getBoundingClientRect();
    }
    return box(0, 0);
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      if (options?.top !== undefined) this.scrollTop = options.top;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
});

describe("board window", () => {
  it("mounts every card when the column is not windowed, and a bounded count when it is", async () => {
    const tasks = [...fixture.columns.get("open")!.tasks.values()];
    const { unmount } = render(
      <DndContext>
        <SortableContext items={tasks.map((item) => item.id)}>
          {tasks.map((item) => <TaskCard key={item.id} task={item} onClick={() => {}} />)}
        </SortableContext>
      </DndContext>,
    );
    expect(document.querySelectorAll("[data-task-id]")).toHaveLength(OPEN);
    unmount();

    render(<Board projectId="p" onTaskClick={fixture.open} canCreate canDrag />);
    await settle();
    const mounted = openCards();
    expect(mounted.length).toBeGreaterThan(3);
    expect(mounted.length).toBeLessThan(30);
    expect(screen.getByText("200", { selector: "[data-column-count='open']" }).textContent).toBe("200");
    // The two-card column still mounts both.
    expect(document.querySelector("[data-scroller='done']")!.querySelectorAll("[data-task-id]")).toHaveLength(2);
  });

  it("scrolls to cards that were not mounted and keeps their column index", async () => {
    render(<Board projectId="p" onTaskClick={fixture.open} canCreate canDrag />);
    await settle();
    expect(openScroller().querySelector("[data-task-id='open-0']")).toBeTruthy();
    expect(openScroller().querySelector("[data-task-id='open-80']")).toBeNull();

    await act(async () => {
      openScroller().scrollTop = 80 * CARD;
      openScroller().dispatchEvent(new Event("scroll"));
    });
    await settle();
    const cards = openCards();
    expect(cards.length).toBeLessThan(30);
    expect(openScroller().querySelector("[data-task-id='open-0']")).toBeNull();
    const indexes = cards.map((card) => Number(card.closest("[data-index]")!.getAttribute("data-column-index")));
    expect(Math.min(...indexes)).toBeGreaterThan(cards.length);
    expect(indexes).toContain(80);
    const card = openScroller().querySelector<HTMLElement>("[data-task-id='open-80']")!;
    fireEvent.click(card);
    expect(fixture.open).toHaveBeenCalledWith("open-80");
  });

  it("keeps the same card on screen when tasks are inserted above it", async () => {
    const { rerender } = render(<Board projectId="p" onTaskClick={fixture.open} canCreate canDrag />);
    await settle();
    await act(async () => {
      openScroller().scrollTop = 40 * CARD;
      openScroller().dispatchEvent(new Event("scroll"));
    });
    await settle();
    const before = openScroller().querySelector("[data-task-id='open-40']");
    expect(before).toBeTruthy();
    const topBefore = [...openCards()].map((card) => ({
      id: card.dataset.taskId!,
      top: card.getBoundingClientRect().top,
    })).find((card) => card.top >= 0 && card.top < CARD);

    const current = fixture.columns.get("open")!;
    const added = ["new-0", "new-1", "new-2"];
    const order = [...added, ...current.order];
    const tasks = new Map(current.tasks);
    const columnIndex = new Map<string, number>();
    for (const [index, id] of order.entries()) {
      columnIndex.set(id, index);
      const existing = tasks.get(id);
      tasks.set(id, existing ? { ...existing, columnIndex: index, position: index } : task(id, "open", index));
    }
    const next = new Map(fixture.columns);
    next.set("open", {
      ...current,
      total: order.length,
      size: order.length,
      order,
      tasks,
      columnIndex,
      complete: true,
    });
    fixture.columns = next;
    rerender(<Board projectId="p" onTaskClick={fixture.open} canCreate canDrag />);
    await settle();

    expect(openScroller().scrollTop).toBeGreaterThan(40 * CARD);
    const topAfter = [...openCards()].map((card) => ({
      id: card.dataset.taskId!,
      top: card.getBoundingClientRect().top,
    })).find((card) => card.top >= 0 && card.top < CARD);
    expect(topAfter?.id).toBe(topBefore?.id);
    expect(topAfter?.id).toBe("open-40");
  });

  it("keeps an unmounted anchor when taller cards move above it", async () => {
    const moved = Array.from({ length: 12 }, (_, index) => `open-${120 + index}`);
    for (const id of moved) tallIds.add(id);
    const { rerender } = render(<Board projectId="p" onTaskClick={fixture.open} canCreate canDrag />);
    await settle();
    await act(async () => {
      openScroller().scrollTop = 120 * CARD;
      openScroller().dispatchEvent(new Event("scroll"));
    });
    await settle();
    expect(openScroller().querySelector("[data-task-id='open-120']")).toBeTruthy();

    await act(async () => {
      openScroller().scrollTop = 40 * CARD;
      openScroller().dispatchEvent(new Event("scroll"));
    });
    await settle();
    const before = openScroller().scrollTop;
    expect(openScroller().querySelector("[data-task-id='open-40']")).toBeTruthy();
    expect(openScroller().querySelector("[data-task-id='open-120']")).toBeNull();

    const current = fixture.columns.get("open")!;
    const order = [...moved, ...current.order.filter((id) => !moved.includes(id))];
    const tasks = new Map(current.tasks);
    const columnIndex = new Map<string, number>();
    for (const [index, id] of order.entries()) {
      columnIndex.set(id, index);
      const existing = tasks.get(id)!;
      tasks.set(id, { ...existing, columnIndex: index, position: index });
    }
    const next = new Map(fixture.columns);
    next.set("open", { ...current, order, tasks, columnIndex, total: order.length, size: order.length, complete: true });
    fixture.columns = next;
    rerender(<Board projectId="p" onTaskClick={fixture.open} canCreate canDrag />);
    await settle();
    // jsdom does not emit scroll when the column corrects itself. The browser does.
    await act(async () => {
      openScroller().dispatchEvent(new Event("scroll"));
    });
    await settle();

    const delta = openScroller().scrollTop - before;
    // One mounted card's height per index stops 12 * (240 - 92) px short, more than the viewport.
    expect(delta).toBeGreaterThan(moved.length * CARD + VIEW);
    const anchor = openScroller().querySelector<HTMLElement>("[data-task-id='open-40']");
    expect(anchor).toBeTruthy();
    const top = anchor!.getBoundingClientRect().top - openScroller().getBoundingClientRect().top;
    expect(top).toBeGreaterThanOrEqual(-1);
    expect(top).toBeLessThan(VIEW);
  });

  it("still opens the quick-add editor", async () => {
    render(<Board projectId="p" onTaskClick={fixture.open} canCreate canDrag />);
    await settle();
    fireEvent.click(screen.getAllByRole("button", { name: "Add task" })[0]);
    const input = screen.getByPlaceholderText("Task title...");
    fireEvent.change(input, { target: { value: "Follow up" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fixture.create).toHaveBeenCalledWith({ title: "Follow up", statusId: "open", priority: "NONE" });
  });
});
