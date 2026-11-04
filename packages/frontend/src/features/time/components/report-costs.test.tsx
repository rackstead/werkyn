import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TimeReportGroup } from "../api";
import { formatCostLines, formatEntryCost, formatMoney } from "../money";
import { ReportSummaryCards } from "./report-summary-cards";
import { ReportTable } from "./report-table";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mixed = [
  { currency: "EUR", amount: 50, fractionDigits: 2 },
  { currency: "USD", amount: 110, fractionDigits: 2 },
];

it("formats each currency separately and never sums different currencies", () => {
  expect(formatCostLines(mixed)).toEqual(["€50.00", "$110.00"]);
  expect(formatCostLines([{ currency: "USD", amount: 1234.5, fractionDigits: 2 }])).toEqual([
    "$1,234.50",
  ]);
  expect(formatCostLines([])).toEqual(["0.00"]);
  expect(formatMoney(12.5, "1$X")).toBe("12.50 1$X");
  expect(formatEntryCost(null, null)).toBe("No rate");
  expect(formatEntryCost(0, null)).toBe("0.00");
});

it("shows mixed-currency summary totals and unrated billable hours", () => {
  render(
    <ReportSummaryCards
      totalHours={9}
      billableHours={6}
      nonBillableHours={3}
      costByCurrency={mixed}
      unratedBillableHours={4}
    />,
  );
  expect(screen.getByText("€50.00")).toBeTruthy();
  expect(screen.getByText("$110.00")).toBeTruthy();
  expect(screen.queryByText("$160.00")).toBeNull();
  expect(screen.getByText("4h billable without a rate")).toBeTruthy();
});

it("warns when entries with invalid stored hours were left out", () => {
  const props = {
    totalHours: 2,
    billableHours: 2,
    nonBillableHours: 0,
    costByCurrency: [],
    unratedBillableHours: 0,
  };
  const { rerender } = render(<ReportSummaryCards {...props} skippedEntries={0} />);
  expect(screen.queryByRole("status")).toBeNull();
  rerender(<ReportSummaryCards {...props} skippedEntries={3} />);
  expect(screen.getByRole("status").textContent).toBe(
    "3 time entries with invalid stored hours are not included in this report or its CSV export.",
  );
  rerender(<ReportSummaryCards {...props} skippedEntries={1} />);
  expect(screen.getByRole("status").textContent).toBe(
    "1 time entry with invalid stored hours is not included in this report or its CSV export.",
  );
});

it("renders group costs per currency and unpriced entries as having no rate", () => {
  const group: TimeReportGroup = {
    key: "project-1",
    label: "Rated work",
    totalHours: 4.5,
    billableHours: 4.5,
    nonBillableHours: 0,
    totalCost: null,
    currency: null,
    costByCurrency: mixed,
    unratedBillableHours: 4,
    entries: [
      {
        id: "carla",
        date: "2026-01-20",
        hours: 0.5,
        billable: true,
        description: null,
        userName: "Carla",
        projectName: "Rated work",
        taskTitle: null,
        rate: 100,
        currency: "EUR",
        cost: 50,
        costFractionDigits: 2,
      },
      {
        id: "bob",
        date: "2026-01-05",
        hours: 4,
        billable: true,
        description: null,
        userName: "Bob",
        projectName: "Rated work",
        taskTitle: null,
        rate: null,
        currency: null,
        cost: null,
        costFractionDigits: null,
      },
    ],
  };
  render(<ReportTable groups={[group]} groupBy="project" />);
  expect(screen.getAllByText("€50.00")).toHaveLength(1);
  expect(screen.getByText("$110.00")).toBeTruthy();
  expect(screen.getByText("4h billable without a rate")).toBeTruthy();
  fireEvent.click(screen.getByText("Rated work"));
  expect(screen.getAllByText("€50.00")).toHaveLength(2);
  expect(screen.getByText("No rate")).toBeTruthy();
});

it("renders currency-rounded values and the existing invalid-code fallback", () => {
  const lines = formatCostLines([
    { currency: "USD", amount: 9.99, fractionDigits: 2 },
    { currency: "JPY", amount: 2, fractionDigits: 0 },
    { currency: "KWD", amount: 1.235, fractionDigits: 3 },
    { currency: "CLF", amount: 1.2345, fractionDigits: 4 },
  ]);
  expect(lines[0]).toBe("$9.99");
  expect(lines[1]).toBe("¥2");
  expect(lines[2]).toMatch(/1\.235$/);
  expect(lines[3]).toMatch(/1\.2345$/);
  expect(formatEntryCost(1.24, "1$X", 2)).toBe("1.24 1$X");
});

it("passes server precision explicitly rather than relying on host currency defaults", () => {
  const spy = vi.spyOn(Intl, "NumberFormat");
  for (const [currency, digits] of [["JPY", 0], ["KWD", 3], ["CLF", 4]] as const) {
    formatCostLines([{ currency, amount: 2, fractionDigits: digits }]);
    formatEntryCost(2, currency, digits);
    expect(spy).toHaveBeenLastCalledWith("en-US", {
      style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
    });
  }
});

it("uses the same server precision in summary, group and expanded entry costs", () => {
  const buckets = [{ currency: "KWD", amount: 1.235, fractionDigits: 3 }];
  const group: TimeReportGroup = {
    key: "rounded", label: "Rounded work", totalHours: 1, billableHours: 1,
    nonBillableHours: 0, totalCost: 1.235, currency: "KWD", costByCurrency: buckets,
    unratedBillableHours: 0,
    entries: [{ id: "rounded-entry", date: "2026-01-01", hours: 1, billable: true,
      description: null, userName: "Worker", projectName: null, taskTitle: null,
      rate: 1.2345, currency: "KWD", cost: 1.235, costFractionDigits: 3 }],
  };
  render(<><ReportSummaryCards totalHours={1} billableHours={1} nonBillableHours={0}
    costByCurrency={buckets} unratedBillableHours={0} /><ReportTable groups={[group]} groupBy="project" /></>);
  expect(screen.getAllByText(/1\.235$/)).toHaveLength(2);
  fireEvent.click(screen.getByText("Rounded work"));
  expect(screen.getAllByText(/1\.235$/)).toHaveLength(3);
});

it("large accepted KWD formatting preserves the API decimal spelling", () => {
  const text = formatEntryCost(9007199254740.94, "KWD", 3);
  console.log("COST_FORMAT_FACTS", JSON.stringify({ kind: "large-kwd", text }));
  expect(text).toMatch(/9,007,199,254,740\.940$/);
});

it("large accepted legacy currency formatting preserves the API decimal spelling", () => {
  const text = formatEntryCost(90071992547409.9, "1$X", 2);
  console.log("COST_FORMAT_FACTS", JSON.stringify({ kind: "large-invalid-code", text }));
  expect(text).toBe("90071992547409.90 1$X");
});
