import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RateManagementDialog } from "./rate-management-dialog";

const state = vi.hoisted(() => ({
  rates: [] as Array<Record<string, unknown>>,
  mutate: vi.fn(),
}));
vi.mock("@/features/workspaces/api", () => ({
  useWorkspaceMembers: () => ({
    data: {
      data: [
        {
          id: "member-1",
          role: "MEMBER",
          user: { id: "user-1", displayName: "Carla", avatarUrl: null },
        },
      ],
    },
  }),
}));
vi.mock("../api", () => ({
  useUserRates: () => ({ data: state.rates }),
  useSetUserRate: () => ({ mutate: state.mutate }),
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-06-15T12:00:00Z") });
  state.mutate.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const rate = (effectiveFrom: string, value: number, currency: string) => ({
  id: effectiveFrom,
  workspaceId: "w",
  userId: "user-1",
  rate: value,
  currency,
  effectiveFrom,
});

it("shows and edits the rate in force today rather than a future-dated one", () => {
  state.rates = [
    rate("2099-01-01", 90, "EUR"),
    rate("2026-06-15", 40, "USD"),
    rate("2026-01-01", 30, "CHF"),
  ];
  render(<RateManagementDialog workspaceId="w" />);
  fireEvent.click(screen.getByText("Manage Rates"));
  expect(screen.getByText("$40.00/hr")).toBeTruthy();
  expect(screen.queryByText("€90.00/hr")).toBeNull();

  fireEvent.click(screen.getByText("$40.00/hr"));
  expect(screen.getByText("USD")).toBeTruthy();
  const input = screen.getByRole("spinbutton");
  fireEvent.change(input, { target: { value: "45" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(state.mutate).toHaveBeenCalledWith(
    { userId: "user-1", data: { rate: 45 } },
    expect.anything(),
  );
});

it("treats a member whose only rate starts in the future as having no current rate", () => {
  state.rates = [rate("2099-01-01", 90, "EUR")];
  render(<RateManagementDialog workspaceId="w" />);
  fireEvent.click(screen.getByText("Manage Rates"));
  expect(screen.getByText("Set rate")).toBeTruthy();
});
