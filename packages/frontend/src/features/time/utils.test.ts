import { afterEach, describe, expect, it, vi } from "vitest";
import { TIME_ZONES, useTimeZone } from "@/test/time-zone";
import {
  formatDateISO,
  getMonday,
  getMonthEnd,
  getMonthStart,
  getSunday,
  getWeekDays,
  parseDateISO,
  parseWeekParam,
} from "./utils";

/** Calendar arithmetic on YYYY-MM-DD strings, done in UTC so no zone is involved. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Mondays of the weeks holding each 2026 DST change in the tested zones.
const DST_WEEKS = {
  "2026-03-02": "Los Angeles springs forward on Sunday 8 March",
  "2026-03-30": "Sydney falls back on Sunday 5 April",
  "2026-09-28": "Sydney springs forward on Sunday 4 October",
  "2026-10-26": "Los Angeles falls back on Sunday 1 November",
};

// The local Monday of the current week at two instants around the end of
// Sunday 1 November 2026 somewhere in the world.
const CURRENT_MONDAY: Record<string, Record<(typeof TIME_ZONES)[number], string>> = {
  "2026-11-01T20:00:00Z": {
    UTC: "2026-10-26",
    "Asia/Tokyo": "2026-11-02",
    "Australia/Sydney": "2026-11-02",
    "America/Los_Angeles": "2026-10-26",
  },
  "2026-11-02T05:00:00Z": {
    UTC: "2026-11-02",
    "Asia/Tokyo": "2026-11-02",
    "Australia/Sydney": "2026-11-02",
    "America/Los_Angeles": "2026-10-26",
  },
};

afterEach(() => vi.useRealTimers());

describe.each(TIME_ZONES)("time tracking dates in %s", (zone) => {
  useTimeZone(zone);

  it("formats every local day of 2026 and of leap year 2028 as that day, and parses it back", () => {
    for (const [year, days] of [
      [2026, 365],
      [2028, 366],
    ]) {
      for (let i = 0; i < days; i++) {
        const expected = addDays(`${year}-01-01`, i);
        expect(formatDateISO(new Date(year, 0, 1 + i))).toBe(expected);
        expect(formatDateISO(new Date(year, 0, 1 + i, 23, 59, 59))).toBe(expected);
        const parsed = parseDateISO(expected)!;
        expect(formatDateISO(parsed)).toBe(expected);
        expect([parsed.getHours(), parsed.getMinutes()]).toEqual([0, 0]);
      }
    }
  });

  it.each(Object.entries(DST_WEEKS))("keeps all seven days of the week of %s local (%s)", (monday) => {
    const week = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    const start = parseWeekParam(monday);
    expect(formatDateISO(start)).toBe(monday);
    expect(getWeekDays(start).map(formatDateISO)).toEqual(week);
    expect(formatDateISO(getSunday(start))).toBe(week[6]);
    for (const day of week) {
      expect(formatDateISO(parseWeekParam(day))).toBe(monday);
      expect(formatDateISO(getMonday(new Date(`${day}T23:30:00`)))).toBe(monday);
    }
  });

  it("steps week by week across every DST change of the year like the week navigator", () => {
    let week = "2026-02-23";
    while (week < "2026-12-01") {
      const next = new Date(parseWeekParam(week));
      next.setDate(next.getDate() + 7);
      expect(formatDateISO(next)).toBe(addDays(week, 7));
      const prev = new Date(parseWeekParam(addDays(week, 7)));
      prev.setDate(prev.getDate() - 7);
      expect(formatDateISO(prev)).toBe(week);
      week = addDays(week, 7);
    }
  });

  it("gives every month's first and last local day", () => {
    const months = [...Array.from({ length: 12 }, (_, m) => [2026, m]), [2028, 1]];
    for (const [year, month] of months) {
      const first = `${year}-${String(month + 1).padStart(2, "0")}-01`;
      const last = addDays(
        month === 11 ? `${year + 1}-01-01` : `${year}-${String(month + 2).padStart(2, "0")}-01`,
        -1,
      );
      for (const day of [new Date(year, month, 1), new Date(year, month, 15, 12), new Date(year, month + 1, 0, 23, 59)]) {
        expect(getMonthStart(day)).toBe(first);
        expect(getMonthEnd(day)).toBe(last);
      }
    }
  });

  it.each(Object.keys(CURRENT_MONDAY))("starts the current week on the local Monday at %s", (now) => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(now) });
    const expected = CURRENT_MONDAY[now][zone];
    expect(formatDateISO(parseWeekParam())).toBe(expected);
    // A week parameter that is not a real date falls back to the current week.
    expect(formatDateISO(parseWeekParam("2026-02-31"))).toBe(expected);
    expect(formatDateISO(parseWeekParam("not a date"))).toBe(expected);
  });
});
