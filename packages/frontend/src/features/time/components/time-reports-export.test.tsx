import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { exportTimeReportCSV } = vi.hoisted(() => ({ exportTimeReportCSV: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../api", () => ({
  useTimeReport: () => ({ data: undefined, isLoading: false }),
  exportTimeReportCSV,
}));
vi.mock("./rate-management-dialog", () => ({ RateManagementDialog: () => null }));

const { TimeReportsPage } = await import("./time-reports-page");

afterEach(() => {
  cleanup();
  exportTimeReportCSV.mockReset();
});

function renderPage(startDate: string, endDate: string) {
  render(
    <TimeReportsPage
      workspaceId="w"
      workspaceSlug="ws"
      membership={{ role: "ADMIN" }}
      filters={{ startDate, endDate }}
    />,
  );
  return screen.getByRole("button", { name: /Export CSV/ }) as HTMLButtonElement;
}

it("CSV export waits for complete report dates", () => {
  for (const [start, end] of [
    ["0202-03-01", "2026-03-31"],
    ["2026-03-01", "0020-03-31"],
    ["", "2026-03-31"],
  ]) {
    const button = renderPage(start, end);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    cleanup();
  }
  expect(exportTimeReportCSV).not.toHaveBeenCalled();

  fireEvent.click(renderPage("2026-03-01", "2026-03-31"));
  expect(exportTimeReportCSV).toHaveBeenCalledTimes(1);
  expect(exportTimeReportCSV.mock.calls[0][1]).toMatchObject({
    startDate: "2026-03-01",
    endDate: "2026-03-31",
  });
});
