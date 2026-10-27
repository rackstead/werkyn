import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import {
  advanceNextRunDate,
  calculateNextRunDate,
} from "../src/modules/recurring/recurring.service.ts";

// Recurrence dates are calendar dates. "Today" is the current UTC date, so the
// clock is mocked at noon UTC unless a test is checking the UTC boundary.
mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T12:00:00Z") });
const originalTZ = process.env.TZ;
after(() => {
  mock.timers.reset();
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

const DAY_MS = 86_400_000;

function setToday(date, time = "12:00:00") {
  mock.timers.setTime(Date.parse(`${date}T${time}Z`));
}

// Independent oracle: walks one calendar day at a time with millisecond
// arithmetic, never by setting months, and tests each day against the schedule.
function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
function weekday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
function lastDayOfMonth(date) {
  const [y, m] = date.split("-").map(Number);
  let day = 28;
  while (addDays(`${y}-${String(m).padStart(2, "0")}-${day}`, 1).slice(5, 7) === String(m).padStart(2, "0")) day++;
  return day;
}
function isOccurrence(schedule, date) {
  if (date < schedule.startDate) return false;
  switch (schedule.frequency) {
    case "DAILY":
      return true;
    case "WEEKLY":
      return weekday(date) === schedule.dayOfWeek;
    case "BIWEEKLY": {
      // The first week of every 14-day cycle that begins on startDate.
      const offset = Math.round(
        (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${schedule.startDate}T00:00:00Z`)) / DAY_MS,
      );
      return weekday(date) === schedule.dayOfWeek && offset % 14 < 7;
    }
    case "MONTHLY":
      return Number(date.slice(8)) === Math.min(schedule.dayOfMonth, lastDayOfMonth(date));
  }
  throw new Error(`unknown frequency ${schedule.frequency}`);
}
function occurrences(schedule, until) {
  const result = [];
  for (let date = schedule.startDate; date <= until; date = addDays(date, 1)) {
    if (isOccurrence(schedule, date)) result.push(date);
  }
  return result;
}
function calculate(schedule) {
  return calculateNextRunDate(
    schedule.frequency,
    schedule.startDate,
    schedule.dayOfWeek,
    schedule.dayOfMonth,
  );
}
function advance(schedule, date) {
  return advanceNextRunDate(schedule.frequency, date, schedule.dayOfWeek, schedule.dayOfMonth);
}

test("MONTHLY advance clamps to the target month and never skips a short month", () => {
  for (const [from, dayOfMonth, expected] of [
    ["2026-01-31", 31, "2026-02-28"],
    ["2026-01-30", 30, "2026-02-28"],
    ["2026-01-29", 29, "2026-02-28"],
    ["2028-01-31", 31, "2028-02-29"],
    ["2028-01-30", 30, "2028-02-29"],
    ["2028-01-29", 29, "2028-02-29"],
    ["2026-03-31", 31, "2026-04-30"],
    ["2026-05-31", 31, "2026-06-30"],
    ["2026-08-31", 31, "2026-09-30"],
    ["2026-10-31", 31, "2026-11-30"],
    ["2026-12-31", 31, "2027-01-31"],
    ["2026-12-15", 15, "2027-01-15"],
    ["2026-01-15", 15, "2026-02-15"],
    ["2026-01-01", 1, "2026-02-01"],
  ]) {
    assert.equal(advanceNextRunDate("MONTHLY", from, null, dayOfMonth), expected, `${from} day ${dayOfMonth}`);
  }
});

test("MONTHLY advance returns to the configured day after a clamped short month", () => {
  for (const [from, dayOfMonth, expected] of [
    ["2026-02-28", 31, "2026-03-31"],
    ["2026-02-28", 30, "2026-03-30"],
    ["2026-02-28", 29, "2026-03-29"],
    ["2028-02-29", 31, "2028-03-31"],
    ["2026-04-30", 31, "2026-05-31"],
    ["2026-06-30", 31, "2026-07-31"],
  ]) {
    assert.equal(advanceNextRunDate("MONTHLY", from, null, dayOfMonth), expected, `${from} day ${dayOfMonth}`);
  }
});

test("MONTHLY advance chains hit every month exactly once for every configured day", () => {
  for (let dayOfMonth = 1; dayOfMonth <= 31; dayOfMonth++) {
    const schedule = { frequency: "MONTHLY", startDate: "2026-01-01", dayOfMonth };
    const expected = occurrences(schedule, "2029-12-31");
    assert.equal(expected.length, 48);
    const actual = [expected[0]];
    while (actual.length < expected.length) actual.push(advance(schedule, actual.at(-1)));
    assert.deepEqual(actual, expected, `day ${dayOfMonth}`);
  }
  // Day 31 keeps returning to the last day, never drifting to the 28th.
  const schedule = { frequency: "MONTHLY", startDate: "2026-01-31", dayOfMonth: 31 };
  const chain = ["2026-01-31"];
  for (let i = 0; i < 12; i++) chain.push(advance(schedule, chain.at(-1)));
  assert.deepEqual(chain, [
    "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31",
    "2026-08-31", "2026-09-30", "2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31",
  ]);
});

test("MONTHLY initialization from a month-end today or start date does not skip the next month", () => {
  for (const [today, startDate, dayOfMonth, expected] of [
    ["2026-01-31", "2026-01-31", 31, "2026-01-31"],
    ["2026-01-31", "2026-01-31", 30, "2026-02-28"],
    ["2026-01-31", "2026-01-31", 28, "2026-02-28"],
    ["2026-01-31", "2026-01-31", 15, "2026-02-15"],
    ["2026-01-31", "2025-11-30", 15, "2026-02-15"],
    ["2026-02-01", "2026-01-31", 31, "2026-02-28"],
    ["2028-01-31", "2028-01-31", 30, "2028-02-29"],
    ["2028-02-01", "2028-01-01", 31, "2028-02-29"],
    ["2026-03-31", "2026-03-31", 15, "2026-04-15"],
    ["2026-03-31", "2026-03-31", 30, "2026-04-30"],
    ["2026-04-30", "2026-04-30", 31, "2026-04-30"],
    ["2026-05-31", "2026-05-31", 1, "2026-06-01"],
    ["2026-12-31", "2026-12-31", 15, "2027-01-15"],
    ["2026-12-31", "2026-12-31", 31, "2026-12-31"],
    // Future start dates are anchored the same way as "today".
    ["2026-01-10", "2026-03-31", 15, "2026-04-15"],
    ["2026-01-10", "2026-08-31", 1, "2026-09-01"],
    ["2026-01-10", "2027-12-31", 30, "2028-01-30"],
  ]) {
    setToday(today);
    assert.equal(
      calculateNextRunDate("MONTHLY", startDate, null, dayOfMonth),
      expected,
      `today ${today} start ${startDate} day ${dayOfMonth}`,
    );
  }
});

test("MONTHLY initialization matches the calendar oracle for every day of month and every today", () => {
  for (let dayOfMonth = 1; dayOfMonth <= 31; dayOfMonth++) {
    const schedule = { frequency: "MONTHLY", startDate: "2026-01-01", dayOfMonth };
    const all = occurrences(schedule, "2029-02-28");
    for (let today = "2026-01-01"; today <= "2028-12-31"; today = addDays(today, 1)) {
      setToday(today);
      assert.equal(calculate(schedule), all.find((date) => date >= today), `today ${today} day ${dayOfMonth}`);
    }
  }
});

test("DAILY and WEEKLY initialization and advance cross month, leap-day and year boundaries", () => {
  for (const [from, expected] of [
    ["2026-02-28", "2026-03-01"],
    ["2028-02-28", "2028-02-29"],
    ["2028-02-29", "2028-03-01"],
    ["2026-12-31", "2027-01-01"],
  ]) {
    assert.equal(advanceNextRunDate("DAILY", from, null, null), expected);
  }
  for (const [from, expected] of [
    ["2026-12-28", "2027-01-04"],
    ["2028-02-26", "2028-03-04"],
    ["2026-02-28", "2026-03-07"],
  ]) {
    assert.equal(advanceNextRunDate("WEEKLY", from, weekday(from), null), expected);
  }
  setToday("2026-02-28");
  assert.equal(calculateNextRunDate("DAILY", "2026-01-15", null, null), "2026-02-28");
  assert.equal(calculateNextRunDate("DAILY", "2026-03-15", null, null), "2026-03-15");
  assert.equal(calculateNextRunDate("WEEKLY", "2026-01-01", 6, null), "2026-02-28");
  assert.equal(calculateNextRunDate("WEEKLY", "2026-01-01", 0, null), "2026-03-01");

  for (const schedule of [
    { frequency: "DAILY", startDate: "2027-12-20" },
    ...[0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ frequency: "WEEKLY", startDate: "2027-12-20", dayOfWeek })),
  ]) {
    const all = occurrences(schedule, "2028-06-30");
    for (let today = "2027-12-01"; today <= "2028-05-31"; today = addDays(today, 1)) {
      setToday(today);
      assert.equal(calculate(schedule), all.find((date) => date >= today), `${schedule.frequency} today ${today}`);
    }
    for (let i = 0; i + 1 < all.length; i++) assert.equal(advance(schedule, all[i]), all[i + 1]);
  }
});

test("BIWEEKLY initialization is anchored to the start date rather than today's week", () => {
  for (const [today, startDate, dayOfWeek, expected] of [
    ["2026-01-05", "2026-01-05", 1, "2026-01-05"],
    ["2026-01-06", "2026-01-05", 1, "2026-01-19"],
    ["2026-01-12", "2026-01-05", 1, "2026-01-19"],
    ["2026-01-19", "2026-01-05", 1, "2026-01-19"],
    ["2026-01-20", "2026-01-05", 1, "2026-02-02"],
    // A different weekday stays in the first week of each two-week cycle.
    ["2026-01-08", "2026-01-05", 3, "2026-01-21"],
    ["2026-01-05", "2026-01-05", 0, "2026-01-11"],
    ["2026-01-12", "2026-01-05", 0, "2026-01-25"],
    // Across a year end and a leap day.
    ["2028-02-23", "2027-12-27", 1, "2028-03-06"],
    ["2028-02-29", "2027-12-27", 2, "2028-03-07"],
    // A future start date is not shifted by today.
    ["2025-12-01", "2026-01-05", 1, "2026-01-05"],
  ]) {
    setToday(today);
    assert.equal(
      calculateNextRunDate("BIWEEKLY", startDate, dayOfWeek, null),
      expected,
      `today ${today} start ${startDate} weekday ${dayOfWeek}`,
    );
  }
});

test("BIWEEKLY initialization and advance preserve the start-date phase for every start and weekday", () => {
  for (let startOffset = 0; startOffset < 14; startOffset++) {
    const startDate = addDays("2027-12-20", startOffset);
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      const schedule = { frequency: "BIWEEKLY", startDate, dayOfWeek };
      const all = occurrences(schedule, "2028-09-30");
      for (let i = 0; i + 1 < all.length; i++) {
        assert.equal(Math.round((Date.parse(all[i + 1]) - Date.parse(all[i])) / DAY_MS), 14);
        assert.equal(advance(schedule, all[i]), all[i + 1]);
      }
      for (let today = "2027-12-01"; today <= "2028-06-30"; today = addDays(today, 1)) {
        setToday(today);
        assert.equal(calculate(schedule), all.find((date) => date >= today), `start ${startDate} weekday ${dayOfWeek} today ${today}`);
      }
    }
  }
});

test("today is the UTC calendar date regardless of the host time zone", () => {
  try {
    for (const [zone, lateLocalDay, earlyLocalDay] of [
      ["UTC", 31, 1],
      ["America/Los_Angeles", 31, 31],
      ["Pacific/Kiritimati", 1, 1],
      ["Pacific/Pago_Pago", 31, 31],
    ]) {
      process.env.TZ = zone;
      // 23:30 UTC is already Feb 1 in Kiritimati and still Jan 31 afternoon in Los Angeles.
      setToday("2027-01-31", "23:30:00");
      assert.equal(new Date().getDate(), lateLocalDay, `${zone} local day`);
      assert.equal(calculateNextRunDate("DAILY", "2027-01-01", null, null), "2027-01-31", zone);
      assert.equal(calculateNextRunDate("MONTHLY", "2027-01-01", null, 31), "2027-01-31", zone);
      assert.equal(calculateNextRunDate("MONTHLY", "2027-01-01", null, 30), "2027-02-28", zone);
      setToday("2027-02-01", "00:30:00");
      assert.equal(new Date().getDate(), earlyLocalDay, `${zone} local day`);
      assert.equal(calculateNextRunDate("DAILY", "2027-01-01", null, null), "2027-02-01", zone);
      assert.equal(advanceNextRunDate("MONTHLY", "2027-01-31", null, 31), "2027-02-28", zone);
      assert.equal(advanceNextRunDate("BIWEEKLY", "2027-12-27", 1, null), "2028-01-10", zone);
    }
  } finally {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  }
});
