import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/features/projects/api", () => ({
  useStatuses: () => ({ data: { data: [] } }),
  useLabels: () => ({ data: { data: [] } }),
  useProjectMembers: () => ({ data: { data: [] } }),
}));

const { FilterBar } = await import("./filter-bar");

afterEach(cleanup);

it("a due-date filter keeps the current filter until the typed year is complete", () => {
  const onFilterChange = vi.fn();
  const { container } = render(
    <FilterBar projectId="p" filters={{ dueAfter: "2026-01-01" }} onFilterChange={onFilterChange} />,
  );
  const dueAfter = container.querySelector('input[title="Due after"]') as HTMLInputElement;
  for (const value of ["0002-03-15", "0020-03-15", "0202-03-15"]) {
    fireEvent.change(dueAfter, { target: { value } });
    expect(dueAfter.value).toBe(value);
  }
  expect(onFilterChange).not.toHaveBeenCalled();
  fireEvent.change(dueAfter, { target: { value: "2027-03-15" } });
  expect(onFilterChange.mock.calls).toEqual([[{ dueAfter: "2027-03-15" }]]);

  fireEvent.change(dueAfter, { target: { value: "" } });
  expect(onFilterChange).toHaveBeenLastCalledWith({});
});
