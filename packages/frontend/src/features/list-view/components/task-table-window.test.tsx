import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@/features/tasks/api";
import type { CustomField } from "@/features/projects/api";
import { TaskTable } from "./task-table";

const fixture = vi.hoisted(() => ({
  tasks: [] as Task[],
  fields: [] as CustomField[],
  fieldWrite: vi.fn(),
  // Stable, like the List route's callback (cells depend on it).
  update: vi.fn(),
  statuses: [
    { id: "open", name: "Open", position: 0, color: null, isCompletion: false },
    { id: "done", name: "Done", position: 1, color: null, isCompletion: true },
    { id: "empty", name: "Empty", position: 2, color: null, isCompletion: false },
  ],
}));

// Like React Query, hand out the same result until the data itself changes
// (the table's column definitions depend on it).
const results = new WeakMap<object, { data: { data: unknown }; isLoading: false }>();
function result(data: object) {
  let value = results.get(data);
  if (!value) {
    value = { data: { data }, isLoading: false };
    results.set(data, value);
  }
  return value;
}
const none: never[] = [];

vi.mock("@/features/tasks/api", () => ({
  useProjectTasks: () => result(fixture.tasks),
  useAddAssignee: () => ({ mutate: vi.fn() }),
  useRemoveAssignee: () => ({ mutate: vi.fn() }),
  useAddTaskLabel: () => ({ mutate: vi.fn() }),
  useRemoveTaskLabel: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/projects/api", () => ({
  useStatuses: () => result(fixture.statuses),
  useProjectMembers: () => result(none),
  useLabels: () => result(none),
  useCustomFields: () => result(fixture.fields),
  useSetCustomFieldValue: (taskId: string) => ({
    mutate: (data: unknown) => fixture.fieldWrite(taskId, data),
  }),
}));

const notes: CustomField = {
  id: "notes", projectId: "p", name: "Notes", type: "TEXT",
  options: null, required: false, position: 0,
};

function task(i: number, statusId = i < 600 ? "open" : "done"): Task {
  const status = fixture.statuses.find((s) => s.id === statusId)!;
  const id = `t${String(i).padStart(4, "0")}`;
  return {
    id, title: `Task ${String(i).padStart(4, "0")}`, projectId: "p",
    statusId, status, position: i, priority: "NONE", dueDate: null,
    startDate: null, description: null, archived: false,
    createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z",
    assignees: [], labels: [], _count: { subtasks: 0, blockedBy: 0 },
    customFieldValues: [{ fieldId: "notes", value: `Note ${i}`, field: notes }],
  } as Task;
}

// Layout: <main> shows 400px; every row is 41px; the table starts at the
// top of <main>'s content.
const VIEW = 400;
const ROW = 41; // the table's estimate for task rows
const TOTAL_ROWS = 1 + 3 + 1000; // header row, three group rows, 1000 tasks

function Harness({ canEdit = true, withMain = true, show = true }: {
  canEdit?: boolean; withMain?: boolean; show?: boolean;
}) {
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const [opened, setOpened] = useState<string | null>(null);
  const table = show && (
    <TaskTable projectId="p" canEdit={canEdit} rowSelection={selection}
      onRowSelectionChange={setSelection} onUpdateTask={fixture.update} onTaskClick={setOpened} />
  );
  return (
    <>
      <output data-testid="selection">
        {JSON.stringify(Object.keys(selection).filter((id) => selection[id]))}
      </output>
      <output data-testid="opened">{opened}</output>
      {withMain ? <main>{table}</main> : table}
    </>
  );
}

const main = () => document.querySelector("main")!;
const taskRows = () => [...document.querySelectorAll<HTMLTableRowElement>("tbody tr[data-task-id]")];
const rowOf = (id: string) => document.querySelector<HTMLTableRowElement>(`tbody tr[data-task-id="${id}"]`);
const selection = () => JSON.parse(screen.getByTestId("selection").textContent!) as string[];
async function settle() {
  await act(async () => { await Promise.resolve(); });
}
async function scrollTo(top: number) {
  await act(async () => {
    main().scrollTop = top;
    fireEvent.scroll(main());
  });
  await settle();
}
const scrollToEnd = () => scrollTo(TOTAL_ROWS * ROW - VIEW);

beforeEach(() => {
  fixture.tasks = Array.from({ length: 1000 }, (_, i) => task(i));
  fixture.fields = [];
  fixture.fieldWrite.mockClear();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.tagName === "MAIN" ? VIEW : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => 1200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const scroll = this.closest("main")?.scrollTop ?? 0;
    const top = this.tagName === "MAIN" ? 0 : -scroll;
    const height = this.tagName === "TR" ? ROW : 0;
    return { x: 0, y: top, top, left: 0, right: 1200, bottom: top + height, width: 1200, height, toJSON: () => ({}) };
  });
  // Browsers move scrollTop on scrollTo; jsdom has no scrollTo.
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      if (options.top !== undefined) this.scrollTop = options.top;
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
});

describe("TaskTable windowing", () => {
  it("renders only the rows around the view and describes the whole list with ARIA", async () => {
    render(<Harness />);
    await settle();
    const table = screen.getByRole("table");
    expect(table.getAttribute("aria-rowcount")).toBe(String(TOTAL_ROWS));
    expect(taskRows().length).toBeGreaterThan(5);
    expect(taskRows().length).toBeLessThan(30);
    const indexes = [...table.querySelectorAll("tbody tr:not([aria-hidden])")]
      .map((row) => Number(row.getAttribute("aria-rowindex")));
    // The rows near the view, then the last row of the list (kept rendered
    // so Shift+Tab from below the table reaches it).
    const rendered = indexes.slice(0, -1);
    expect(rendered).toEqual(rendered.map((_, i) => 2 + i));
    expect(indexes.at(-1)).toBe(TOTAL_ROWS);
    // Between them one spacer, hidden from assistive technology, holds the
    // height of the rows not rendered (estimated; group rows use a shorter
    // estimate).
    const spacer = table.querySelector<HTMLElement>("tbody tr[aria-hidden='true']")!;
    const expected = (TOTAL_ROWS - 2 - rendered.length) * ROW;
    expect(Math.abs(parseFloat(spacer.style.height) - expected)).toBeLessThan(2 * ROW);
    expect(screen.queryByRole("button", { name: "Task 0999" })).toBeNull();

    await scrollToEnd();
    expect(screen.getByRole("button", { name: "Task 0999" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Task 0000" })).toBeNull();
    // The first row stays rendered, so Tab from the header reaches it.
    expect(table.querySelector("tbody tr:not([aria-hidden])")!.getAttribute("aria-rowindex")).toBe("2");
    expect(taskRows().length).toBeLessThan(30);
    const last = table.querySelector("tbody tr:not([aria-hidden]):last-of-type")!;
    expect(last.getAttribute("aria-rowindex")).toBe(String(TOTAL_ROWS));
    expect(last.textContent).toContain("Empty");
  });

  it("starts at the scroll position <main> already has", async () => {
    const { rerender } = render(<Harness show={false} />);
    main().scrollTop = 200 * ROW;
    rerender(<Harness />);
    await settle();
    // Not reset to the top. (jsdom has no scroll anchoring, so the
    // virtualizer's own correction for rows measured above the view may
    // move it by a few pixels.)
    expect(Math.abs(main().scrollTop - 200 * ROW)).toBeLessThan(ROW);
    expect(rowOf("t0199")).toBeTruthy();
    expect(rowOf("t0000")).toBeNull();
  });

  it("renders every row when the table has no <main> scroller", async () => {
    render(<Harness withMain={false} />);
    await settle();
    expect(taskRows()).toHaveLength(1000);
  });

  it("keeps select-all, group counts and selected rows that are out of view", async () => {
    render(<Harness />);
    await settle();
    expect(screen.getByRole("button", { name: "Open 600 tasks" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all tasks" }));
    expect(selection()).toEqual(fixture.tasks.map((t) => t.id));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all tasks" }));
    expect(selection()).toEqual([]);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Task 0001" }));
    await scrollToEnd();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Task 0998" }));
    expect(rowOf("t0001")).toBeNull();
    expect(selection()).toEqual(["t0001", "t0998"]);
    await scrollTo(0);
    const first = screen.getByRole("checkbox", { name: "Select Task 0001" }) as HTMLInputElement;
    expect(first.checked).toBe(true);
    expect(rowOf("t0001")!.className).toContain("bg-primary/5");
  });

  it("keeps the focused row and its neighbours rendered so focus and Tab order survive scrolling", async () => {
    render(<Harness />);
    await settle();
    const title = screen.getByRole("button", { name: "Task 0005" });
    act(() => title.focus());
    await scrollToEnd();
    expect(title.isConnected).toBe(true);
    expect(document.activeElement).toBe(title);
    // The previous and next rows stay for Shift+Tab and Tab.
    expect(rowOf("t0004")).toBeTruthy();
    expect(rowOf("t0006")).toBeTruthy();
    expect(rowOf("t0003")).toBeNull();
    expect(rowOf("t0007")).toBeNull();
    // DOM order matches list order across the gap.
    const indexes = [...document.querySelectorAll("tbody tr:not([aria-hidden])")]
      .map((row) => Number(row.getAttribute("aria-rowindex")));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));

    // Focus moving on (as Tab does) moves the retained neighbours with it.
    act(() => screen.getByRole("checkbox", { name: "Select Task 0006" }).focus());
    await settle();
    expect(rowOf("t0007")).toBeTruthy();
    expect(rowOf("t0004")).toBeNull();

    // Enter on the focused title is a click: it opens that task.
    const next = screen.getByRole("button", { name: "Task 0006" });
    act(() => next.focus());
    fireEvent.click(next);
    expect(screen.getByTestId("opened").textContent).toBe("t0006");
  });

  it("keeps an inline editor's draft while scrolled away and saves it for its own task", async () => {
    fixture.fields = [notes];
    render(<Harness />);
    await settle();
    const row = rowOf("t0002")!;
    fireEvent.click(within(row).getByRole("button", { name: "Note 2" }));
    const input = within(row).getByRole("textbox") as HTMLInputElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "Unsaved draft" } });
    await scrollToEnd();
    expect(input.isConnected).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Unsaved draft");
    expect(fixture.fieldWrite).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(fixture.fieldWrite.mock.calls).toEqual([
      ["t0002", { fieldId: "notes", value: "Unsaved draft" }],
    ]);
  });

  it("inserts and removes rows from realtime refreshes, keeping ARIA and the focused row", async () => {
    const { rerender } = render(<Harness />);
    await settle();
    const title = screen.getByRole("button", { name: "Task 0010" });
    act(() => title.focus());
    const focusedRow = rowOf("t0010")!;

    // A colleague adds a task near the top and deletes another one.
    const added = { ...task(5000, "open"), id: "t-new", title: "Added by a colleague", position: 2 };
    fixture.tasks = [
      ...fixture.tasks.slice(0, 2), added, ...fixture.tasks.slice(3),
    ];
    rerender(<Harness />);
    await settle();
    expect(screen.getByRole("table").getAttribute("aria-rowcount")).toBe(String(TOTAL_ROWS));
    expect(rowOf("t0002")).toBeNull();
    expect(rowOf("t-new")!.getAttribute("aria-rowindex")).toBe("5");
    expect(rowOf("t0003")!.getAttribute("aria-rowindex")).toBe("6");
    // The focused row was not re-created.
    expect(rowOf("t0010")).toBe(focusedRow);
    expect(document.activeElement).toBe(title);

    // Another task arrives while the list is scrolled to the end; the
    // focused row, out of view, is still kept.
    await scrollToEnd();
    fixture.tasks = [...fixture.tasks, { ...task(5001, "done"), id: "t-late", title: "Late task", position: 5001 }];
    rerender(<Harness />);
    await settle();
    expect(screen.getByRole("table").getAttribute("aria-rowcount")).toBe(String(TOTAL_ROWS + 1));
    expect(rowOf("t-late")).toBeTruthy();
    expect(rowOf("t0010")).toBe(focusedRow);

    // The focused task is deleted: its row goes.
    fixture.tasks = fixture.tasks.filter((t) => t.id !== "t0010");
    rerender(<Harness />);
    await settle();
    expect(rowOf("t0010")).toBeNull();
    expect(screen.getByRole("table").getAttribute("aria-rowcount")).toBe(String(TOTAL_ROWS));
  });

  it("moving focus does not move the rows in view", async () => {
    // Rows of different heights; spacers have their own height.
    const height = (row: HTMLTableRowElement) =>
      row.hasAttribute("aria-hidden") ? parseFloat(row.style.height)
        : row.dataset.taskId?.endsWith("7") ? 2 * ROW : ROW;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      const h = this instanceof HTMLTableRowElement ? height(this) : 0;
      const top = this.tagName === "MAIN" ? 0 : -(this.closest("main")?.scrollTop ?? 0);
      return { x: 0, y: top, top, left: 0, right: 1200, bottom: top + h, width: 1200, height: h, toJSON: () => ({}) };
    });
    // Offset of each rendered row from the top of the table body.
    const offsets = () => {
      const result = new Map<string, number>();
      let y = 0;
      for (const row of document.querySelectorAll<HTMLTableRowElement>("tbody tr")) {
        if (row.dataset.taskId) result.set(row.dataset.taskId, y);
        y += height(row);
      }
      return result;
    };
    render(<Harness />);
    await settle();
    act(() => screen.getByRole("button", { name: "Task 0001" }).focus());
    // Rows rendered again after scrolling away and back are measured again.
    for (const top of [3000, 0, 6000, 3000]) await scrollTo(top);
    const before = offsets();
    act(() => screen.getByRole("button", { name: "Task 0080" }).focus());
    await settle();
    expect(rowOf("t0001")).toBeNull();
    const after = offsets();
    for (const id of ["t0075", "t0080", "t0085"]) {
      expect(after.get(id)).toBe(before.get(id));
    }
  });

  it("collapsing a group removes its rows from the list and the row count", async () => {
    render(<Harness />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Open 600 tasks" }));
    await settle();
    expect(screen.getByRole("table").getAttribute("aria-rowcount")).toBe(String(TOTAL_ROWS - 600));
    expect(rowOf("t0000")).toBeNull();
    const rows = [...document.querySelectorAll("tbody tr:not([aria-hidden])")];
    expect(rows[1].textContent).toContain("Done");
    expect(rows[2].getAttribute("data-task-id")).toBe("t0600");
  });
});
