import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Task } from "@/features/tasks/api";

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
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
}));

const { InlineDueDateCell } = await import("./columns");
const { BulkActions } = await import("./bulk-actions");

afterEach(cleanup);
beforeEach(() => mutate.mockReset());

// Values Chromium reports while "2027" is typed into a date input.
const TYPING_2027 = ["0002-03-15", "0020-03-15", "0202-03-15", "2027-03-15"];

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
  expect(onUpdateTask.mock.calls).toEqual([["t1", { dueDate: "2027-03-15" }]]);
  expect(container.querySelector('input[type="date"]')).toBeNull();
});

it("the inline due date still clears the date", () => {
  const onUpdateTask = vi.fn();
  const task = { id: "t2", dueDate: "2026-03-15", status: { isCompletion: false } } as unknown as Task;
  const { container } = render(<InlineDueDateCell task={task} onUpdateTask={onUpdateTask} />);
  fireEvent.click(screen.getByRole("button"));
  fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: "" } });
  expect(onUpdateTask.mock.calls).toEqual([["t2", { dueDate: null }]]);
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
