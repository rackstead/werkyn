import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { TimeReportGroup } from "../api";
import { formatCostLines, formatEntryCost, formatMoney } from "../money";
import { ReportSummaryCards } from "./report-summary-cards";
import { ReportTable } from "./report-table";

afterEach(cleanup);

const mixed = [
  { currency: "EUR", amount: 50 },
  { currency: "USD", amount: 110 },
];

it("formats each currency separately and never sums different currencies", () => {
  expect(formatCostLines(mixed)).toEqual(["€50.00", "$110.00"]);
  expect(formatCostLines([{ currency: "USD", amount: 1234.5 }])).toEqual([
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
