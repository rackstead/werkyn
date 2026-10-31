import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TIME_ZONES, useTimeZone } from "@/test/time-zone";
import type { Task } from "@/features/tasks/api";
import { TaskTable } from "./task-table";

const state = vi.hoisted(() => ({ tasks: [] as Task[] }));
vi.mock("@/features/tasks/api", () => ({
  useProjectTasks: () => ({ data: { data: state.tasks }, isLoading: false }),
  useAddAssignee: () => ({ mutate: vi.fn() }),
  useRemoveAssignee: () => ({ mutate: vi.fn() }),
  useAddTaskLabel: () => ({ mutate: vi.fn() }),
  useRemoveTaskLabel: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/projects/api", () => ({
  useStatuses: () => ({ data: { data: [
    { id: "open", name: "Open", position: 0, isCompletion: false },
    { id: "done", name: "Done", position: 1, isCompletion: true },
  ] } }),
  useProjectMembers: () => ({ data: { data: [] } }),
  useLabels: () => ({ data: { data: [] } }),
  useCustomFields: () => ({ data: { data: [] } }),
  useSetCustomFieldValue: () => ({ mutate: vi.fn() }),
}));

const LOCAL_TODAY = {
  "2026-11-01T20:00:00Z": {
    UTC: "2026-11-01", "Asia/Tokyo": "2026-11-02",
    "Australia/Sydney": "2026-11-02", "America/Los_Angeles": "2026-11-01",
  },
  "2026-11-02T05:00:00Z": {
    UTC: "2026-11-02", "Asia/Tokyo": "2026-11-02",
    "Australia/Sydney": "2026-11-02", "America/Los_Angeles": "2026-11-01",
  },
} as const;
function offset(date: string, days: number) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function task(id: string, dueDate: string | null, complete = false): Task {
  const statusId = complete ? "done" : "open";
  return { id, title: id, projectId: "p", statusId, dueDate, position: 0,
    priority: "NONE", assignees: [], labels: [], customFieldValues: [],
    status: { id: statusId, name: complete ? "Done" : "Open", color: null, isCompletion: complete },
  } as Task;
}
const rowFor = (title: string) => screen.getByRole("button", { name: title }).closest("tr")!;
const labelFor = (title: string, date: string) => within(rowFor(title)).getByText(date);
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe.each(TIME_ZONES)("actual TaskTable due dates in %s", (zone) => {
  useTimeZone(zone);
  for (const canEdit of [false, true]) {
    it.each(Object.keys(LOCAL_TODAY) as Array<keyof typeof LOCAL_TODAY>)(`${canEdit ? "editable" : "read-only"} keeps due-today neutral at %s`, (now) => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(now) });
      const today = LOCAL_TODAY[now][zone], yesterday = offset(today, -1);
      state.tasks = [task("Today task", today), task("Past task", yesterday), task("Completed task", yesterday, true), task("Undated task", null)];
      const update = vi.fn(), clicked = vi.fn();
      render(<TaskTable projectId="p" canEdit={canEdit} rowSelection={{}}
        onRowSelectionChange={vi.fn()} onUpdateTask={update} onTaskClick={clicked} />);

      // Check existing literal-date/completion/edit contracts before the
      // intended due-today assertion, so a failure still proves the controls.
      const todayLabel = labelFor("Today task", today);
      const todayWasRed = todayLabel.classList.contains("text-destructive");
      expect(todayLabel.textContent).toBe(today);
      expect(labelFor("Past task", yesterday).classList.contains("text-destructive")).toBe(true);
      expect(labelFor("Completed task", yesterday).classList.contains("text-destructive")).toBe(false);
      const undated = within(rowFor("Undated task")).getAllByRole("cell").at(-1)!;
      expect(undated.textContent).toBe("-");
      expect(undated.querySelector(".text-destructive")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Completed task" }));
      expect(clicked).toHaveBeenCalledWith("Completed task");
      if (canEdit) {
        fireEvent.click(todayLabel.closest("button")!);
        const input = rowFor("Today task").querySelector('input[type="date"]')!;
        expect(input).toBeTruthy();
        fireEvent.change(input, { target: { value: offset(today, 2) } });
        fireEvent.click(labelFor("Today task", today).closest("button")!);
        fireEvent.change(rowFor("Today task").querySelector('input[type="date"]')!, { target: { value: "" } });
        expect(update.mock.calls).toEqual([
          ["Today task", { dueDate: offset(today, 2) }], ["Today task", { dueDate: null }],
        ]);
      } else {
        fireEvent.click(todayLabel);
        expect(rowFor("Today task").querySelector('input[type="date"]')).toBeNull();
        expect(update).not.toHaveBeenCalled();
      }
      console.info(JSON.stringify({ probe: "list-due-today", zone, now, canEdit, today,
        literalLabelsPastCompletedClickAndMutationControlsPassed: true, todayWasRed }));
      expect(todayWasRed).toBe(false);
    });
  }
});
