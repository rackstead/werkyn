import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BulkActions } from "./bulk-actions";

const barCss = readFileSync(
  path.resolve(process.cwd(), "src/features/list-view/components/bulk-actions-bar.css"),
  "utf8",
);

/** Where the content-sized bar sits. `contentWidth` is the one-row width measured when it overflowed. */
function barSpan(viewport: number, contentWidth: number, leftInset: number) {
  const padding = 12;
  const inner = viewport - leftInset - padding * 2;
  const width = Math.min(contentWidth, inner);
  const left = leftInset + padding + Math.max(0, inner - width) / 2;
  return { left, right: left + width };
}

function desktopInsetPx(css: string) {
  const block = css.match(/@media\s*\(\s*min-width:\s*768px\s*\)\s*\{([\s\S]*?)\n\}/);
  const left = block?.[1].match(/\.bulk-actions-shell\s*\{[^}]*left:\s*([^;]+);/);
  if (!left) throw new Error("desktop bulk bar does not inset past the sidebar");
  if (left[1].trim() !== "16rem") throw new Error(`expected 16rem, got ${left[1]}`);
  return 16 * 16;
}

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
  const bar = status.closest(".bulk-actions-bar");
  expect(bar).toBeTruthy();
  expect(bar?.className).toContain("overflow-x-auto");
  expect(bar?.parentElement?.className).toContain("bulk-actions-shell");
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

it("at 1400px a point inside the sidebar's right side is not covered by the bar", () => {
  // The one-row bar measured 1143px and, centered on the viewport, started at x=129.
  const contentWidth = 1143;
  const inset = desktopInsetPx(barCss);
  const next = barSpan(1400, contentWidth, inset);
  const previous = barSpan(1400, contentWidth, 0);
  for (const x of [150, 180, 220, 250]) {
    expect(x >= previous.left && x <= previous.right).toBe(true);
    expect(x >= next.left && x <= next.right).toBe(false);
  }
  expect(next.left).toBeGreaterThanOrEqual(256);
});
