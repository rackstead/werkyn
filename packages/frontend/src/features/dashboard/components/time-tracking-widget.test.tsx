import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIME_ZONES, useTimeZone } from "@/test/time-zone";
import { TimeTrackingWidget } from "./time-tracking-widget";

const state = vi.hoisted(() => ({
  entries: [] as Array<{ id: string; date: string; hours: number; project: null }>,
  ranges: [] as unknown[][],
}));

vi.mock("@/features/time/api", () => ({
  useTimeEntries: (...args: unknown[]) => {
    state.ranges.push(args);
    return { data: state.entries, isLoading: false };
  },
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (select: (s: unknown) => unknown) => select({ user: { id: "user-1" } }),
}));

beforeEach(() => {
  state.ranges = [];
  state.entries = [
    { id: "sun", date: "2026-11-01", hours: 3, project: null },
    { id: "mon", date: "2026-11-02", hours: 2, project: null },
  ];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Local [today, Monday of this week] at two instants around the end of
// Sunday 1 November 2026, when Los Angeles has just left DST.
const LOCAL_DAY: Record<string, Record<(typeof TIME_ZONES)[number], [string, string]>> = {
  "2026-11-01T20:00:00Z": {
    UTC: ["2026-11-01", "2026-10-26"],
    "Asia/Tokyo": ["2026-11-02", "2026-11-02"],
    "Australia/Sydney": ["2026-11-02", "2026-11-02"],
    "America/Los_Angeles": ["2026-11-01", "2026-10-26"],
  },
  "2026-11-02T05:00:00Z": {
    UTC: ["2026-11-02", "2026-11-02"],
    "Asia/Tokyo": ["2026-11-02", "2026-11-02"],
    "Australia/Sydney": ["2026-11-02", "2026-11-02"],
    "America/Los_Angeles": ["2026-11-01", "2026-10-26"],
  },
};

describe.each(TIME_ZONES)("dashboard time tracking in %s", (zone) => {
  useTimeZone(zone);

  it.each(Object.keys(LOCAL_DAY))("counts today and this week by local date at %s", (now) => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(now) });
    const [today, monday] = LOCAL_DAY[now][zone];
    render(<TimeTrackingWidget workspaceId="w" />);
    expect(state.ranges.at(-1)).toEqual(["w", monday, today, "user-1"]);
    const todayHours = state.entries
      .filter((e) => e.date === today)
      .reduce((sum, e) => sum + e.hours, 0);
    expect(screen.getByText("Today").previousElementSibling?.textContent).toBe(
      `${todayHours.toFixed(1)}h`,
    );
  });
});
