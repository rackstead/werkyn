import assert from "node:assert/strict";
import { test } from "node:test";
import { rateInEffect } from "../src/modules/time/user-rates.service.ts";

const history = [
  { effectiveFrom: "2025-12-01", rate: 10 },
  { effectiveFrom: "2026-01-15", rate: 20 },
  { effectiveFrom: "2026-03-01", rate: 50 },
];

test("selects the latest rate whose start date is on or before the entry date", () => {
  const rateOn = (date) => rateInEffect(history, date)?.rate ?? null;
  assert.equal(rateOn("2025-11-30"), null, "before the first rate");
  assert.equal(rateOn("2025-12-01"), 10, "first day of the first rate");
  assert.equal(rateOn("2026-01-14"), 10, "day before a change");
  assert.equal(rateOn("2026-01-15"), 20, "same-day boundary");
  assert.equal(rateOn("2026-02-28"), 20, "a later rate is not applied early");
  assert.equal(rateOn("2026-03-01"), 50);
  assert.equal(rateOn("2030-01-01"), 50);
  assert.equal(rateInEffect([], "2026-01-01"), null);
});

test("matches a linear scan for every date across the history", () => {
  const start = Date.UTC(2025, 10, 1);
  for (let day = 0; day < 200; day += 1) {
    const date = new Date(start + day * 86_400_000).toISOString().slice(0, 10);
    const expected = history.filter((rate) => rate.effectiveFrom <= date).at(-1) ?? null;
    assert.equal(rateInEffect(history, date), expected, date);
  }
});
