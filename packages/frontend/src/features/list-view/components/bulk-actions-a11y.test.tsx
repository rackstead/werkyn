import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BulkActions } from "./bulk-actions";

vi.mock("@/features/tasks/api", () => ({
  useBulkUpdateTasks: () => ({ mutate: vi.fn(), isPending: false }),
  useBulkDeleteTasks: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/shared/confirm-dialog", () => ({
  ConfirmDialog: () => null,
}));
vi.mock("@/features/projects/api", () => ({
  useStatuses: () => ({
    data: {
      data: [
        {
          id: "open",
          name: "In progress",
          position: 0,
          color: null,
          isCompletion: false,
        },
      ],
    },
  }),
  useProjectMembers: () => ({
    data: { data: [{ user: { id: "ada", displayName: "Ada Lovelace" } }] },
  }),
  useLabels: () => ({
    data: { data: [{ id: "bug", name: "Bug", color: "#c00" }] },
  }),
}));

afterEach(cleanup);

it("names the bulk selects and keeps every action in a viewport-capped bar", () => {
  render(
    <BulkActions
      projectId="p"
      selectedTaskIds={["a", "b"]}
      onClear={vi.fn()}
      canDelete
    />,
  );
  const status = screen.getByRole("combobox", { name: "Change status" });
  const priority = screen.getByRole("combobox", { name: "Change priority" });
  const assignee = screen.getByRole("combobox", { name: "Assign to" });
  const label = screen.getByRole("combobox", { name: "Set label" });
  const archive = screen.getByRole("button", { name: "Archive" });
  const remove = screen.getByRole("button", { name: "Delete" });
  const due = screen.getByLabelText("Set due date");
  const clear = screen.getByRole("button", { name: "Clear" });
  const bar = status.closest(".max-w-full");
  expect(bar).toBeTruthy();
  expect(bar?.className).toContain("flex-wrap");
  expect(bar?.className).toContain("w-max");
  expect(bar?.className).toContain("max-w-full");
  expect(bar?.className).toContain("min-w-0");
  expect(bar?.className).toContain("overflow-x-auto");
  expect(bar?.parentElement?.className).toContain("inset-x-0");
  expect(bar?.parentElement?.className).toContain("px-3");
  for (const control of [
    status,
    priority,
    assignee,
    label,
    due,
    clear,
    archive,
    remove,
  ]) {
    expect(control.tabIndex).toBeGreaterThanOrEqual(0);
    expect(bar?.contains(control)).toBe(true);
  }
});
