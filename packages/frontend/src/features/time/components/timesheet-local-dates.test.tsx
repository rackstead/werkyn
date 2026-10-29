import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIME_ZONES, useTimeZone } from "@/test/time-zone";
import { TimesheetPage } from "./timesheet-page";

const state = vi.hoisted(() => ({
  entries: [] as unknown[],
  ranges: [] as unknown[][],
  create: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (select: (s: unknown) => unknown) => select({ user: { id: "user-1" } }),
}));
vi.mock("@/hooks/use-permissions", () => ({ usePermissions: () => ({ canEdit: true }) }));
vi.mock("../api", () => ({
  useTimeEntries: (...args: unknown[]) => {
    state.ranges.push(args);
    return { data: state.entries, isLoading: false };
  },
  useCreateTimeEntry: () => ({ mutate: state.create }),
  useUpdateTimeEntry: () => ({ mutate: vi.fn() }),
  useDeleteTimeEntry: () => ({ mutate: vi.fn() }),
}));
vi.mock("./task-project-selector", () => ({ TaskSelector: () => null }));
vi.mock("./all-members-view", () => ({ AllMembersView: () => null }));

const entry = (id: string, date: string, hours: number) => ({
  id,
  date,
  hours,
  taskId: null,
  description: "Standup",
  billable: true,
  task: null,
  project: null,
});

beforeEach(() => {
  state.entries = [];
  state.ranges = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const renderWeek = (week?: string) =>
  render(
    <TimesheetPage workspaceId="w" workspaceSlug="acme" membership={{ role: "MEMBER" }} week={week} />,
  );

describe.each(TIME_ZONES)("timesheet in %s", (zone) => {
  useTimeZone(zone);

  it("queries, shows and saves the local days of a week that ends on a DST change", () => {
    // Los Angeles falls back on Sunday 1 November 2026.
    state.entries = [entry("mon", "2026-10-26", 2), entry("sun", "2026-11-01", 3)];
    renderWeek("2026-10-26");

    expect(state.ranges.at(-1)).toEqual(["w", "2026-10-26", "2026-11-01", "user-1"]);
    expect(screen.getByText("Oct 26 – Nov 1, 2026")).toBeTruthy();
    const headers = screen.getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers.slice(2, 9)).toEqual(["Mon 26", "Tue 27", "Wed 28", "Thu 29", "Fri 30", "Sat 31", "Sun 1"]);

    const row = screen.getByText("Standup").closest("tr")!;
    const days = within(row)
      .getAllByRole("cell")
      .slice(2, 9)
      .map((cell) => cell.textContent);
    expect(days).toEqual(["2", "–", "–", "–", "–", "–", "3"]);

    // Hours typed under Tuesday are saved on Tuesday.
    fireEvent.click(within(within(row).getAllByRole("cell")[3]).getByRole("button"));
    const input = within(row).getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "1.5" } });
    fireEvent.blur(input);
    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2026-10-27", hours: 1.5, description: "Standup" }),
    );
  });

  it("opens on the local week of the moment it is shown", () => {
    // Already Monday 2 November east of UTC, still Sunday 1 November west of it.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T20:00:00Z") });
    renderWeek();
    const monday = zone === "Asia/Tokyo" || zone === "Australia/Sydney" ? "2026-11-02" : "2026-10-26";
    const sunday = monday === "2026-11-02" ? "2026-11-08" : "2026-11-01";
    expect(state.ranges.at(-1)).toEqual(["w", monday, sunday, "user-1"]);
  });
});
