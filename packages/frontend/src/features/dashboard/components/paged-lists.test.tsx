// Load-more and paging UI for lists the server now returns a page at a time
// (P02b): my tasks (dashboard widgets and the timesheet task picker), time
// report group entries and channel members.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, renderHook, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MyTask } from "@/features/my-tasks/api";
import type { TimeReportGroup } from "@/features/time/api";

const transport = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; searchParams: Record<string, string> }>,
  respond: (() => ({})) as (path: string, searchParams: Record<string, string>) => unknown,
}));
vi.mock("@/lib/api-client", async (original) => {
  const real = await original<typeof import("@/lib/api-client")>();
  return {
    ...real,
    api: {
      get: (path: string, options: { searchParams?: Record<string, string> } = {}) => ({
        json: async () => {
          const searchParams = { ...(options.searchParams ?? {}) };
          transport.calls.push({ path, searchParams });
          return transport.respond(path, searchParams);
        },
      }),
    },
  };
});
// The timesheet picker's Radix select is replaced by plain markup.
vi.mock("@/components/ui/select", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Select: Pass, SelectContent: Pass, SelectGroup: Pass, SelectLabel: Pass, SelectTrigger: Pass,
    SelectValue: () => null,
    SelectItem: ({ children }: { children?: React.ReactNode }) => <div role="option">{children}</div>,
  };
});

import { MyTasksWidget } from "./my-tasks-widget";
import { UpcomingDatesWidget } from "./upcoming-dates-widget";
import { TaskSelector } from "@/features/time/components/task-project-selector";
import { ReportTable } from "@/features/time/components/report-table";
import { useChannelMembers } from "@/features/chat/api";
import { formatDateISO, addDaysISO } from "@/features/time/utils";

let client: QueryClient;
function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const renderWithClient = (ui: React.ReactElement) => render(ui, { wrapper });

function task(id: string, project: string, extra: Partial<MyTask> = {}): MyTask {
  return {
    id, title: id, priority: "NONE", dueDate: null, position: 0,
    project: { id: project, name: project, color: null },
    status: { id: "open", name: "Open", color: null, isCompletion: false },
    ...extra,
  } as MyTask;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  transport.calls = [];
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe("my tasks widget", () => {
  it("shows the first page, loads the next one on request and stops at the last", async () => {
    const yesterday = addDaysISO(formatDateISO(new Date()), -1);
    transport.respond = (path, params) => {
      expect(path).toBe("workspaces/w/my-tasks");
      if (params.dueBefore) {
        // The overdue box has its own filtered query.
        expect(params).toEqual({ dueBefore: yesterday, completed: "false" });
        return { data: [task("late on a later page", "zeta", { dueDate: yesterday })], nextCursor: null };
      }
      if (!params.cursor) return { data: [task("first", "alpha"), task("second", "alpha")], nextCursor: "page-2" };
      expect(params.cursor).toBe("page-2");
      return { data: [task("third", "beta")], nextCursor: null };
    };
    renderWithClient(<MyTasksWidget workspaceId="w" onTaskClick={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /^first/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^third/ })).toBeNull();
    // Overdue tasks are shown even when their page of the list is not loaded.
    expect(screen.getByText("Overdue (1)")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /late on a later page/ })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
    expect(await screen.findByRole("button", { name: /^third/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more tasks" })).toBeNull();
    expect(transport.calls.filter((c) => !c.searchParams.dueBefore).map((c) => c.searchParams.cursor)).toEqual([undefined, "page-2"]);
  });

  it("marks a partial overdue list and loads its next page", async () => {
    const yesterday = addDaysISO(formatDateISO(new Date()), -1);
    transport.respond = (_path, params) => {
      if (!params.dueBefore) return { data: [task("current", "alpha")], nextCursor: null };
      if (!params.cursor) return { data: [task("late one", "alpha", { dueDate: yesterday })], nextCursor: "late-2" };
      return { data: [task("late two", "beta", { dueDate: yesterday })], nextCursor: null };
    };
    renderWithClient(<MyTasksWidget workspaceId="w" onTaskClick={vi.fn()} />);
    expect(await screen.findByText("Overdue (1+)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more overdue tasks" }));
    expect(await screen.findByText("Overdue (2)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more overdue tasks" })).toBeNull();
  });
});

describe("upcoming dates widget", () => {
  it("asks the server for open tasks due this week and pages them", async () => {
    const today = formatDateISO(new Date());
    transport.respond = (_path, params) => {
      expect(params.dueAfter).toBe(today);
      expect(params.dueBefore).toBe(addDaysISO(today, 7));
      expect(params.completed).toBe("false");
      return params.cursor
        ? { data: [task("due later page", "beta", { dueDate: addDaysISO(today, 2) })], nextCursor: null }
        : { data: [task("due today", "alpha", { dueDate: today })], nextCursor: "next" };
    };
    renderWithClient(<UpcomingDatesWidget workspaceId="w" onTaskClick={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /due today/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("button", { name: /due later page/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});

describe("timesheet task picker", () => {
  it("offers the next page of assigned tasks", async () => {
    transport.respond = (_path, params) => params.cursor
      ? { data: [task("from page two", "beta")], nextCursor: null }
      : { data: [task("from page one", "alpha")], nextCursor: "two" };
    renderWithClient(<TaskSelector workspaceId="w" taskId={null} onChange={vi.fn()} />);
    expect(await screen.findByText("from page one")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more tasks" }));
    expect(await screen.findByText("from page two")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more tasks" })).toBeNull();
  });
});

describe("time report table", () => {
  const filters = { startDate: "2026-01-01", endDate: "2026-01-31", groupBy: "user", billable: "all", userIds: undefined };
  const entry = (id: string) => ({
    id, date: "2026-01-02", hours: 1, billable: true, description: `entry ${id}`,
    userName: "Ann", projectName: null, taskTitle: null, rate: null, currency: null, cost: null, costFractionDigits: null,
  });
  const group = (extra: Partial<TimeReportGroup>): TimeReportGroup => ({
    key: "ann", label: "Ann", totalHours: 5, billableHours: 5, nonBillableHours: 0,
    totalCost: 0, currency: null, costByCurrency: [], unratedBillableHours: 5,
    entries: [], entryCount: 5, hasMoreEntries: false, nextEntryCursor: null, ...extra,
  });

  it("loads the rest of an expanded group page by page from its cursor", async () => {
    transport.respond = (path, params) => {
      expect(path).toBe("workspaces/w/time/reports/entries");
      expect(params).toMatchObject({ startDate: "2026-01-01", endDate: "2026-01-31", groupBy: "user", billable: "all", groupKey: "ann" });
      expect("userIds" in params).toBe(false);
      return params.cursor === "e2"
        ? { data: [entry("e3"), entry("e4")], nextCursor: "e4" }
        : { data: [entry("e5")], nextCursor: null };
    };
    renderWithClient(
      <ReportTable
        groups={[group({ entries: [entry("e1"), entry("e2")], hasMoreEntries: true, nextEntryCursor: "e2" })]}
        groupBy="user" workspaceId="w" filters={filters}
      />,
    );
    fireEvent.click(screen.getByText("Ann"));
    expect(screen.getByText("entry e2")).toBeTruthy();
    expect(transport.calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Load more entries (3 more)" }));
    expect(await screen.findByText("entry e4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more entries (1 more)" }));
    expect(await screen.findByText("entry e5")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Load more entries/ })).toBeNull();
    expect(transport.calls.map((c) => c.searchParams.cursor)).toEqual(["e2", "e4"]);
  });

  it("starts from the first entry when the report listed none of the group", async () => {
    transport.respond = () => ({ data: [entry("e1")], nextCursor: null });
    renderWithClient(
      <ReportTable groups={[group({ entryCount: 1, hasMoreEntries: true })]} groupBy="user" workspaceId="w" filters={filters} />,
    );
    fireEvent.click(screen.getByText("Ann"));
    fireEvent.click(screen.getByRole("button", { name: "Load more entries (1 more)" }));
    expect(await screen.findByText("entry e1")).toBeTruthy();
    expect(transport.calls[0].searchParams.cursor).toBeUndefined();
  });

  it("requests nothing for complete groups", () => {
    renderWithClient(
      <ReportTable groups={[group({ entries: [entry("e1")], entryCount: 1 })]} groupBy="user" workspaceId="w" filters={filters} />,
    );
    fireEvent.click(screen.getByText("Ann"));
    expect(screen.getByText("entry e1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Load more entries/ })).toBeNull();
    expect(transport.calls).toHaveLength(0);
  });
});

describe("channel members", () => {
  it("collects member pages in order", async () => {
    const member = (id: string) => ({ id, channelId: "c", userId: `u-${id}`, lastReadAt: "", joinedAt: "", user: { id: `u-${id}`, displayName: id, avatarUrl: null, email: `${id}@x.test` } });
    transport.respond = (path, params) => {
      expect(path).toBe("chat/w/channels/c/members");
      return params.cursor ? { data: [member("m3")], nextCursor: null } : { data: [member("m1"), member("m2")], nextCursor: "m2" };
    };
    const { result } = renderHook(() => useChannelMembers("w", "c"), { wrapper });
    await waitFor(() => expect(result.current.members).toHaveLength(2));
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => { await result.current.fetchNextPage(); });
    await waitFor(() => expect(result.current.members.map((m) => m.id)).toEqual(["m1", "m2", "m3"]));
    expect(result.current.hasNextPage).toBe(false);
    expect(transport.calls.map((c) => c.searchParams.cursor)).toEqual([undefined, "m2"]);
  });
});
