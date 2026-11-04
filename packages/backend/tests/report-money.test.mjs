import assert from "node:assert/strict";
import { test } from "node:test";
import { currencyFractionDigits, reportMoneyNumber, roundedCostUnits } from "../src/modules/time/report-money.js";

test("decimal multiplication rounds each USD row before summing", () => {
  const units = roundedCostUnits(0.1, 33.33, 2);
  assert.equal(units, 333n);
  assert.equal(reportMoneyNumber(units, 2), 3.33);
  assert.equal(reportMoneyNumber(3n * units, 2), 9.99);
});

test("decimal ties round away from zero on both signs", () => {
  for (const [rate, expected] of [[1.005, 101n], [-1.005, -101n], [1.0049, 100n], [-1.0049, -100n], [1.0051, 101n], [-1.0051, -101n]]) {
    assert.equal(roundedCostUnits(1, rate, 2), expected, String(rate));
  }
});

test("currency precision covers zero, two, three and four digits", () => {
  for (const [currency, digits] of [["JPY", 0], ["USD", 2], ["KWD", 3], ["CLF", 4]]) {
    assert.equal(currencyFractionDigits(currency), digits);
  }
  assert.equal(roundedCostUnits(1, 1.5, 0), 2n);
  assert.equal(roundedCostUnits(1, 1.2345, 3), 1235n);
  assert.equal(roundedCostUnits(1, 1.23445, 4), 12345n);
});

test("unknown and legacy-invalid currency codes retain the two-digit fallback", () => {
  assert.equal(currencyFractionDigits("ZZZ"), 2);
  assert.equal(currencyFractionDigits("1$X"), 2);
  assert.equal(currencyFractionDigits(""), 2);
});

test("exponent notation and subnormal finite inputs do not use a binary product", () => {
  assert.equal(roundedCostUnits(1e-7, 1e9, 2), 10000n);
  assert.equal(roundedCostUnits(5e-324, 1e9, 4), 0n);
  assert.equal(roundedCostUnits(0.1, 0.05, 2), 1n);
});

test("zero and negative values below half a unit normalize to positive zero", () => {
  assert.equal(roundedCostUnits(-0, 123, 2), 0n);
  const amount = reportMoneyNumber(roundedCostUnits(-0.01, 0.01, 2), 2);
  assert.equal(amount, 0);
  assert.equal(Object.is(amount, -0), false);
});

test("a safe integer of units can still be refused if its API spelling loses a unit", () => {
  assert.equal(reportMoneyNumber(9007199254740991n, 0), Number.MAX_SAFE_INTEGER);
  assert.equal(reportMoneyNumber(9007199254740990n, 2), 90071992547409.9);
  assert.throws(() => reportMoneyNumber(9007199254740991n, 2), { statusCode: 400 });
});

test("the unit bound applies to positive and negative totals", () => {
  for (const amount of [9007199254740992n, -9007199254740992n]) {
    assert.throws(() => reportMoneyNumber(amount, 0), { statusCode: 400 });
  }
});

test("individually safe rows do not authorize an unsafe accumulated total", () => {
  const row = roundedCostUnits(1, 4e13, 2);
  assert.equal(reportMoneyNumber(row, 2), 4e13);
  assert.throws(() => reportMoneyNumber(row * 3n, 2), { statusCode: 400 });
});

test("finite multiplication beyond the Number range is rejected before API conversion", () => {
  assert.throws(() => reportMoneyNumber(roundedCostUnits(24, 1e308, 2), 2), { statusCode: 400 });
});

test("nonfinite inputs and invalid precision never become blank money", () => {
  for (const input of [Infinity, -Infinity, NaN]) assert.throws(() => roundedCostUnits(input, 1, 2), { statusCode: 400 });
  for (const digits of [-1, 1.5, 101, NaN]) assert.throws(() => roundedCostUnits(1, 1, digits), { statusCode: 400 });
});

test("the policy uses decimal currency units rather than a cash increment", () => {
  assert.equal(roundedCostUnits(1, 1.025, currencyFractionDigits("CHF")), 103n);
});
