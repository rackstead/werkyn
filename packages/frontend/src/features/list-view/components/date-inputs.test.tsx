import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Task } from "@/features/tasks/api";
import type { CustomField } from "@/features/projects/api";
import { leave, setHalfTyped, type, TYPING_OVER_2026_11_20 } from "@/test/date-typing";
import { changeIdentity } from "@/lib/identity";

const { mutate, fieldMutate } = vi.hoisted(() => ({ mutate: vi.fn(), fieldMutate: vi.fn() }));
vi.mock("@/features/tasks/api", () => ({
  useBulkUpdateTasks: () => ({ mutate, isPending: false }),
  useBulkDeleteTasks: () => ({ mutate: vi.fn(), isPending: false }),
}));
// jsdom has no HTMLDialogElement.close; the confirm dialogs are not under test.
vi.mock("@/components/shared/confirm-dialog", () => ({ ConfirmDialog: () => null }));
vi.mock("@/features/projects/api", () => ({
  useStatuses: () => ({ data: { data: [] } }),
  useProjectMembers: () => ({ data: { data: [] } }),
  useLabels: () => ({ data: { data: [] } }),
  useSetCustomFieldValue: () => ({ mutate: fieldMutate, mutateAsync: fieldMutate }),
}));

const { InlineDueDateCell, getColumns } = await import("./columns");
const { BulkActions } = await import("./bulk-actions");

afterEach(cleanup);
beforeEach(() => {
  mutate.mockReset();
  fieldMutate.mockReset().mockResolvedValue(undefined);
});

// Values Chromium reports while "2027" is typed into a date input.
const TYPING_2027 = ["0002-03-15", "0020-03-15", "0202-03-15", "2027-03-15"];

function editCell(kind: "due" | "custom", required = false, send?: (value: string | null) => Promise<void>) {
  const onUpdateTask = vi.fn((_id: string, data: Record<string, unknown>, onComplete?: (saved: boolean) => void) => {
    if (send) void send(data.dueDate as string | null).then(() => onComplete?.(true), () => onComplete?.(false));
    else onComplete?.(true);
  });
  if (send && kind === "custom") fieldMutate.mockImplementation(({ value }) => send(value));
  const field: CustomField = {
    id: "target", projectId: "p", name: "Target", type: "DATE",
    options: null, required, position: 0,
  };
  const task = {
    id: "t", projectId: "p", dueDate: "2026-11-20", status: { isCompletion: false },
    customFieldValues: [{ fieldId: field.id, value: "2026-11-20", field }],
  } as unknown as Task;
  let content = (current: Task): ReactNode => <InlineDueDateCell task={current} onUpdateTask={onUpdateTask} />;
  if (kind === "custom") {
    const column = getColumns({
      canEdit: true, onTaskClick: vi.fn(), onUpdateTask,
      statuses: [], members: [], projectLabels: [], customFields: [field],
    }).find((entry) => entry.id === "cf_target")!;
    const Cell = column.cell as (props: { row: { original: Task } }) => ReactNode;
    content = (current) => <Cell row={{ original: current }} />;
  }
  const { container, rerender, unmount } = render(content(task));
  fireEvent.click(screen.getByRole("button"));
  const input = container.querySelector('input[type="date"]') as HTMLInputElement;
  const writes = () => kind === "due"
    ? onUpdateTask.mock.calls.map((call) => call[1].dueDate)
    : fieldMutate.mock.calls.map((call) => call[0].value);
  const refetch = (value: string | null) => rerender(content({
    ...task, dueDate: value,
    customFieldValues: [{ ...task.customFieldValues[0], value }],
  }));
  return { input, container, writes, refetch, unmount };
}

for (const kind of ["due", "custom"] as const) {
  for (const [order, steps] of Object.entries(TYPING_OVER_2026_11_20)) {
    for (const finish of ["Enter", "blur"]) {
      it(`inline ${kind} saves only the final typed date, on ${finish} (${order})`, () => {
        const { input, container, writes } = editCell(kind);
        type(input, steps);
        expect(writes()).toEqual([]);
        expect(container.querySelector('input[type="date"]')).toBe(input);
        if (finish === "Enter") fireEvent.keyDown(input, { key: "Enter" });
        else leave(input);
        expect(writes()).toEqual(["2027-03-15"]);
        expect(container.querySelector('input[type="date"]')).toBeNull();
      });
    }
  }

  it(`inline ${kind} discards an unfinished part even when Chromium completes it on blur`, () => {
    const { input, writes } = editCell(kind);
    type(input, [["0", "", true]]);
    leave(input, "2026-01-20");
    expect(writes()).toEqual([]);
  });

  it(`inline ${kind} discards a pending date on the first Escape and exits on the second`, () => {
    const { input, container, writes } = editCell(kind);
    type(input, TYPING_OVER_2026_11_20["month/day/year"]);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(writes()).toEqual([]);
    expect(input.value).toBe("2026-11-20");
    expect(container.querySelector('input[type="date"]')).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(container.querySelector('input[type="date"]')).toBeNull();
    expect(writes()).toEqual([]);
  });

  it(`inline ${kind} preserves a date with only one part deleted, then allows deliberate clearing`, () => {
    const { input, container, writes } = editCell(kind);
    type(input, [["Backspace", "", true]]);
    leave(input);
    expect(writes()).toEqual([]);
    fireEvent.click(screen.getByRole("button"));
    const reopened = container.querySelector('input[type="date"]') as HTMLInputElement;
    type(reopened, [["Backspace", "", true]]);
    // All parts, rather than only one, have now been emptied.
    setHalfTyped(reopened, false);
    leave(reopened);
    expect(writes()).toEqual([null]);
  });

  it(`inline ${kind} still commits picker selections and picker Clear immediately`, async () => {
    const { input, container, writes } = editCell(kind);
    fireEvent.change(input, { target: { value: "2027-05-06" } });
    expect(writes()).toEqual(["2027-05-06"]);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: "" } });
    expect(writes()).toEqual(["2027-05-06", null]);
  });

  function delayedWrites() {
    let stored: string | null = "2026-11-20";
    const requests: Array<{ value: string | null; finish: (succeeded?: boolean) => void }> = [];
    const send = (value: string | null) => new Promise<void>((resolve, reject) => {
      requests.push({ value, finish: (succeeded = true) => {
        if (succeeded) { stored = value; resolve(); }
        else reject(new Error("Write refused"));
      } });
    });
    const complete = async (index: number, succeeded = true) => {
      await act(async () => requests[index].finish(succeeded));
    };
    return { send, requests, complete, stored: () => stored };
  }

  it(`inline ${kind} serializes A → B → A before the first response arrives`, async () => {
    const pending = delayedWrites();
    const { input, container, writes } = editCell(kind, false, pending.send);
    fireEvent.change(input, { target: { value: "2027-05-06" } });
    fireEvent.click(screen.getByRole("button"));
    const correction = container.querySelector('input[type="date"]') as HTMLInputElement;
    expect(correction.value).toBe("2027-05-06");
    fireEvent.change(correction, { target: { value: "2026-11-20" } });
    expect(writes()).toEqual(["2027-05-06"]);
    await pending.complete(0);
    expect(writes()).toEqual(["2027-05-06", "2026-11-20"]);
    await pending.complete(1);
    expect(pending.stored()).toBe("2026-11-20");
  });

  it(`inline ${kind} keeps the latest queued edit through stale refetches`, async () => {
    const pending = delayedWrites();
    const { input, container, writes, refetch } = editCell(kind, false, pending.send);
    fireEvent.change(input, { target: { value: "2027-05-06" } });
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: "2026-11-20" } });
    // A response for the first save, then an even older fetch, while the
    // correction is still queued. Neither may acknowledge that correction.
    refetch("2027-05-06");
    refetch("2026-11-20");
    await pending.complete(0);
    refetch("2027-05-06");
    fireEvent.click(screen.getByRole("button"));
    expect((container.querySelector('input[type="date"]') as HTMLInputElement).value).toBe("2026-11-20");
    await pending.complete(1);
    expect(writes()).toEqual(["2027-05-06", "2026-11-20"]);
    expect(pending.stored()).toBe("2026-11-20");
  });

  it(`inline ${kind} allows the same edit to be retried after a failed request`, async () => {
    const pending = delayedWrites();
    const { input, container, writes } = editCell(kind, false, pending.send);
    fireEvent.change(input, { target: { value: "2027-05-06" } });
    await pending.complete(0, false);
    expect(pending.stored()).toBe("2026-11-20");
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: "2027-05-06" } });
    expect(writes()).toEqual(["2027-05-06", "2027-05-06"]);
    await pending.complete(1);
    expect(pending.stored()).toBe("2027-05-06");
  });

  it(`inline ${kind} retries a failed correction after the earlier save succeeded`, async () => {
    const pending = delayedWrites();
    const { input, container, writes, refetch } = editCell(kind, false, pending.send);
    fireEvent.change(input, { target: { value: "2027-05-06" } });
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: "2026-11-20" } });
    await pending.complete(0);
    refetch("2027-05-06");
    await pending.complete(1, false);
    expect(pending.stored()).toBe("2027-05-06");
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: "2026-11-20" } });
    await pending.complete(2);
    expect(writes()).toEqual(["2027-05-06", "2026-11-20", "2026-11-20"]);
    expect(pending.stored()).toBe("2026-11-20");
  });

  it(`inline ${kind} completes both committed edits after the cell unmounts`, async () => {
    const pending = delayedWrites();
    const { input, container, writes, unmount } = editCell(kind, false, pending.send);
    fireEvent.change(input, { target: { value: "2027-05-06" } });
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: "2026-11-20" } });
    unmount();
    await pending.complete(0);
    expect(writes()).toEqual(["2027-05-06", "2026-11-20"]);
    await pending.complete(1);
    expect(pending.stored()).toBe("2026-11-20");
  });

  it(`inline ${kind} preserves commit order across cell remounts`, async () => {
    const pending = delayedWrites();
    const first = editCell(kind, false, pending.send);
    fireEvent.change(first.input, { target: { value: "2027-05-06" } });
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(first.container.querySelector('input[type="date"]')!, { target: { value: "2026-11-20" } });
    first.unmount();
    const second = editCell(kind, false, pending.send);
    fireEvent.change(second.input, { target: { value: "2029-07-04" } });
    expect(pending.requests.map((request) => request.value)).toEqual(["2027-05-06"]);
    await pending.complete(0);
    expect(pending.requests.map((request) => request.value)).toEqual(["2027-05-06", "2026-11-20"]);
    await pending.complete(1);
    expect(pending.requests.map((request) => request.value)).toEqual(["2027-05-06", "2026-11-20", "2029-07-04"]);
    await pending.complete(2);
    expect(pending.stored()).toBe("2029-07-04");
  });

  it(`inline ${kind} never dispatches an old queued edit under a later identity`, async () => {
    const pending = delayedWrites();
    const { input, container, unmount } = editCell(kind, false, pending.send);
    fireEvent.change(input, { target: { value: "2027-05-06" } });
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: "2026-11-20" } });
    unmount();
    act(() => changeIdentity(null, "other-account"));
    await pending.complete(0);
    expect(pending.requests.map((request) => request.value)).toEqual(["2027-05-06"]);
    act(() => changeIdentity("other-account", null));
  });
}

it("inline required custom dates keep their saved value when deliberately emptied", () => {
  const { input, writes } = editCell("custom", true);
  type(input, [["Backspace", "", true]]);
  setHalfTyped(input, false);
  leave(input);
  expect(writes()).toEqual([]);
});

it("the inline due date keeps editing until the year is complete, then saves once", () => {
  const onUpdateTask = vi.fn();
  const task = { id: "t1", dueDate: null, status: { isCompletion: false } } as unknown as Task;
  const { container } = render(<InlineDueDateCell task={task} onUpdateTask={onUpdateTask} />);
  fireEvent.click(screen.getByRole("button"));
  const input = container.querySelector('input[type="date"]')!;
  for (const value of TYPING_2027.slice(0, 3)) {
    fireEvent.change(input, { target: { value } });
    expect(container.querySelector('input[type="date"]')).toBe(input);
  }
  expect(onUpdateTask).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: TYPING_2027[3] } });
  expect(onUpdateTask.mock.calls.map(([id, data]) => [id, data])).toEqual([["t1", { dueDate: "2027-03-15" }]]);
  expect(container.querySelector('input[type="date"]')).toBeNull();
});

it("the inline due date still clears the date", () => {
  const onUpdateTask = vi.fn();
  const task = { id: "t2", dueDate: "2026-03-15", status: { isCompletion: false } } as unknown as Task;
  const { container } = render(<InlineDueDateCell task={task} onUpdateTask={onUpdateTask} />);
  fireEvent.click(screen.getByRole("button"));
  fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: "" } });
  expect(onUpdateTask.mock.calls.map(([id, data]) => [id, data])).toEqual([["t2", { dueDate: null }]]);
});

it("the inline due date does not clear the date when a part is half typed", () => {
  // Typing over a date: the first digit of the month leaves the input "" with
  // bad input, which is not a cleared date.
  const onUpdateTask = vi.fn();
  const task = { id: "t3", dueDate: "2026-11-20", status: { isCompletion: false } } as unknown as Task;
  const { container } = render(<InlineDueDateCell task={task} onUpdateTask={onUpdateTask} />);
  fireEvent.click(screen.getByRole("button"));
  const input = container.querySelector('input[type="date"]') as HTMLInputElement;
  expect(document.activeElement).toBe(input);
  Object.defineProperty(input, "validity", { configurable: true, get: () => ({ badInput: true }) });
  fireEvent.change(input, { target: { value: "" } });
  expect(onUpdateTask).not.toHaveBeenCalled();
  expect(container.querySelector('input[type="date"]')).toBe(input);
});

it("the bulk due date applies only a complete date", () => {
  const { container } = render(
    <BulkActions projectId="p" selectedTaskIds={["a", "b"]} onClear={() => {}} />,
  );
  const input = container.querySelector('input[type="date"]')!;
  for (const value of TYPING_2027) fireEvent.change(input, { target: { value } });
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(mutate.mock.calls[0][0]).toEqual({ taskIds: ["a", "b"], dueDate: "2027-03-15" });
});

it("the bulk due date applies a typed date once, on Enter, not the dates on the way", () => {
  const { container } = render(
    <BulkActions projectId="p" selectedTaskIds={["a", "b"]} onClear={() => {}} />,
  );
  const input = container.querySelector('input[type="date"]') as HTMLInputElement;
  input.focus();
  // Year first: the day's first digit already makes a complete date.
  for (const [key, value] of [["2", ""], ["0", ""], ["2", ""], ["7", ""], ["ArrowRight", ""], ["0", ""], ["3", ""], ["1", "2027-03-01"], ["5", "2027-03-15"]]) {
    fireEvent.keyDown(input, { key });
    fireEvent.change(input, { target: { value } });
    fireEvent.keyUp(input, { key });
  }
  expect(mutate).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(mutate.mock.calls.map((call) => call[0])).toEqual([{ taskIds: ["a", "b"], dueDate: "2027-03-15" }]);
});

it("the bulk Clear discards a typed date: Tab to Clear, then Clear, applies only null", () => {
  const { container } = render(
    <BulkActions projectId="p" selectedTaskIds={["a", "b"]} onClear={() => {}} />,
  );
  const input = container.querySelector('input[type="date"]') as HTMLInputElement;
  input.focus();
  for (const [key, value] of [["0", ""], ["3", ""], ["1", ""], ["5", ""], ["2", "0002-03-15"], ["0", "0020-03-15"], ["2", "0202-03-15"], ["7", "2027-03-15"]]) {
    fireEvent.keyDown(input, { key });
    fireEvent.change(input, { target: { value } });
    fireEvent.keyUp(input, { key });
  }
  const clear = screen.getByRole("button", { name: "Clear" });
  fireEvent.blur(input, { relatedTarget: clear });
  expect(fireEvent.mouseDown(clear)).toBe(false);
  fireEvent.click(clear);
  expect(mutate.mock.calls.map((call) => call[0])).toEqual([{ taskIds: ["a", "b"], dueDate: null }]);
  expect(input.value).toBe("");
});
