import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIME_ZONES, useTimeZone } from "@/test/time-zone";
import type { MyTask } from "@/features/my-tasks/api";
import { MyTasksWidget } from "./my-tasks-widget";
import { UpcomingDatesWidget } from "./upcoming-dates-widget";

const state = vi.hoisted(() => ({ tasks: [] as MyTask[] }));
vi.mock("@/features/my-tasks/api", () => ({
  useMyTasks: () => ({ data: { data: state.tasks }, isLoading: false }),
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

// Independent civil-date fixture arithmetic: these strings have no time zone.
function offset(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
function task(id: string, dueDate: string, complete = false): MyTask {
  return {
    id, title: id, dueDate, priority: "NONE",
    project: { id: "project-1", name: "Project", color: null },
    status: { id: "status-1", name: complete ? "Done" : "Open", isCompletion: complete },
  } as MyTask;
}
function upcoming(today: string) {
  state.tasks = [
    task("Due today", today), task("Due tomorrow", offset(today, 1)),
    task("Day seven", offset(today, 7)), task("Day eight", offset(today, 8)),
    task("Yesterday", offset(today, -1)), task("Completed", today, true),
  ];
}
beforeEach(() => { state.tasks = []; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe.each(TIME_ZONES)("dashboard calendar dates in %s", (zone) => {
  useTimeZone(zone);

  it.each(Object.keys(LOCAL_TODAY) as Array<keyof typeof LOCAL_TODAY>)("includes the local upcoming endpoints at %s", (now) => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(now) });
    const today = LOCAL_TODAY[now][zone], clicked = vi.fn();
    upcoming(today);
    render(<UpcomingDatesWidget workspaceId="w" onTaskClick={clicked} />);
    expect(screen.getByRole("button", { name: /Due today/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Due tomorrow/ })).toBeTruthy();
    const last = screen.getByRole("button", { name: /Day seven/ });
    expect(last).toBeTruthy();
    for (const name of ["Day eight", "Yesterday", "Completed"]) {
      expect(screen.queryByRole("button", { name: new RegExp(name) })).toBeNull();
    }
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Tomorrow")).toBeTruthy();
    fireEvent.click(last);
    expect(clicked).toHaveBeenCalledWith("Day seven", "project-1");
  });

  it.each(Object.keys(LOCAL_TODAY) as Array<keyof typeof LOCAL_TODAY>)("agrees on due-today and overdue styling at %s", (now) => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(now) });
    const today = LOCAL_TODAY[now][zone];
    state.tasks = [task("Due today", today), task("Yesterday", offset(today, -1)), task("Completed", offset(today, -1), true)];
    render(<MyTasksWidget workspaceId="w" onTaskClick={vi.fn()} />);
    expect(screen.getByText("Overdue (1)")).toBeTruthy();
    for (const name of ["Due today", "Completed"]) {
      const row = screen.getByRole("button", { name: new RegExp(name) });
      const label = row.querySelector("span.text-xs.shrink-0")!;
      expect(label.classList.contains("text-destructive")).toBe(false);
    }
    const yesterdayRows = screen.getAllByRole("button", { name: /Yesterday/ });
    expect(yesterdayRows).toHaveLength(2);
    expect(yesterdayRows[1].querySelector("span.text-xs.shrink-0")!.classList.contains("text-destructive")).toBe(true);
  });

  it("shows the supplied civil day instead of the preceding UTC date", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-02T05:00:00Z") });
    state.tasks = [task("Civil date", "2026-11-01")];
    render(<MyTasksWidget workspaceId="w" onTaskClick={vi.fn()} />);
    const expected = new Date(2026, 10, 1).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    for (const row of screen.getAllByRole("button", { name: /Civil date/ })) {
      expect(within(row).getByText(expected)).toBeTruthy();
    }
  });

  it("keeps completed tasks visible and clickable in their project group", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-02T05:00:00Z") });
    state.tasks = [task("Completed control", "2026-10-30", true), task("Legacy date control", "not-a-date")];
    const clicked = vi.fn();
    render(<MyTasksWidget workspaceId="w" onTaskClick={clicked} />);
    expect(screen.queryByText(/Overdue/)).toBeNull();
    expect(screen.getByRole("button", { name: /Legacy date control/ })).toBeTruthy();
    const row = screen.getByRole("button", { name: /Completed control/ });
    expect(within(row).getByText("Done")).toBeTruthy();
    fireEvent.click(row);
    expect(clicked).toHaveBeenCalledWith("Completed control", "project-1");
  });
});

const DST_CASES = [
  { zone: "America/Los_Angeles", now: "2026-03-05T20:00:00Z", today: "2026-03-05", last: "2026-03-12" },
  { zone: "America/Los_Angeles", now: "2026-10-28T19:00:00Z", today: "2026-10-28", last: "2026-11-04" },
  { zone: "Australia/Sydney", now: "2026-04-02T01:00:00Z", today: "2026-04-02", last: "2026-04-09" },
  { zone: "Australia/Sydney", now: "2026-10-01T02:00:00Z", today: "2026-10-01", last: "2026-10-08" },
] as const;
describe.each(DST_CASES)("upcoming across $zone DST from $today", ({ zone, now, today, last }) => {
  useTimeZone(zone);
  it("includes the seventh civil day and excludes the eighth", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(now) });
    upcoming(today);
    expect(state.tasks[2].dueDate).toBe(last);
    render(<UpcomingDatesWidget workspaceId="w" onTaskClick={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Day seven/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Day eight/ })).toBeNull();
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Tomorrow")).toBeTruthy();
  });
});
