import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Task } from "@/features/tasks/api";
import type { AssembledColumn } from "../lib/use-board-columns";
import { Board } from "./board";

const open = vi.hoisted(() => vi.fn());
const move = vi.hoisted(() => vi.fn());

const task: Task = {
  id: "card-1",
  projectId: "p",
  statusId: "open",
  title: "Write the spec",
  description: null,
  priority: "NONE",
  dueDate: null,
  startDate: null,
  position: 0,
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  assignees: [],
  labels: [],
  customFieldValues: [],
  _count: { subtasks: 0, blockedBy: 0 },
  columnIndex: 0,
};

const column: AssembledColumn = {
  statusId: "open",
  total: 1,
  size: 1,
  aligned: true,
  order: [task.id],
  tasks: new Map([[task.id, { ...task, columnIndex: 0 }]]),
  columnIndex: new Map([[task.id, 0]]),
  complete: true,
};

vi.mock("../lib/use-board-columns", () => ({
  useBoardColumns: () => ({
    columns: new Map([["open", column]]),
    aligned: true,
    isLoading: false,
    dataUpdatedAt: 1,
    isFetching: false,
    ensureRange: vi.fn(),
  }),
}));
vi.mock("@/features/projects/api", () => ({
  useStatuses: () => ({
    data: {
      data: [
        {
          id: "open",
          name: "Open",
          color: "#888",
          position: 0,
          isCompletion: false,
        },
      ],
    },
  }),
}));
vi.mock("@/features/tasks/api", () => ({
  useMoveTask: () => ({ mutate: move }),
  useCreateTask: () => ({ mutate: vi.fn(), isPending: false }),
}));

function card() {
  const node = document.querySelector<HTMLElement>("[data-task-id='card-1']");
  if (!node) throw new Error("card was not rendered");
  return node;
}

function dragging() {
  return document.querySelector(".cursor-grabbing") !== null;
}

afterEach(async () => {
  cleanup();
  open.mockClear();
  move.mockClear();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
});

it("opens a focused board card on Enter and leaves keyboard drag on Space", async () => {
  render(<Board projectId="p" onTaskClick={open} canCreate={false} canDrag />);
  const node = card();
  node.focus();

  fireEvent.keyDown(node, { key: "Enter", code: "Enter" });
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith("card-1");
  expect(dragging()).toBe(false);
  expect(move).not.toHaveBeenCalled();

  fireEvent.keyDown(node, { key: "Enter", code: "Enter" });
  expect(open).toHaveBeenCalledTimes(2);
  expect(dragging()).toBe(false);

  fireEvent.keyDown(node, { key: " ", code: "Space" });
  expect(dragging()).toBe(true);
  expect(open).toHaveBeenCalledTimes(2);
  // The keyboard sensor attaches its drop listener on the next turn.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  fireEvent.keyDown(node, { key: " ", code: "Space" });
  await act(async () => {
    await Promise.resolve();
  });
  expect(dragging()).toBe(false);
  expect(node.getAttribute("aria-pressed")).not.toBe("true");
  expect(move).not.toHaveBeenCalled();
});

class TestPointerEvent extends MouseEvent {
  pointerId: number;
  isPrimary: boolean;
  constructor(type: string, init: MouseEventInit & { pointerId?: number; isPrimary?: boolean }) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.isPrimary = init.isPrimary ?? true;
  }
}

function pointer(type: string, target: EventTarget, clientX: number) {
  const init = {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY: 20,
    button: 0,
    buttons: 1,
    pointerId: 1,
    isPrimary: true,
  };
  const event = typeof PointerEvent === "function"
    ? new PointerEvent(type, init)
    : new TestPointerEvent(type, init);
  act(() => {
    target.dispatchEvent(event);
  });
}

it("still opens on click and starts a pointer drag only after 8px", () => {
  render(<Board projectId="p" onTaskClick={open} canCreate={false} canDrag />);
  const node = card();
  fireEvent.click(node);
  expect(open).toHaveBeenCalledWith("card-1");

  open.mockClear();
  pointer("pointerdown", node, 20);
  pointer("pointermove", document, 28);
  expect(dragging()).toBe(false);
  pointer("pointermove", document, 29);
  expect(dragging()).toBe(true);
  expect(open).not.toHaveBeenCalled();
  expect(node.getAttribute("aria-pressed")).toBe("true");
});
