import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SubtaskItem } from "./subtask-item";
import type { Subtask } from "../api";

const subtask: Subtask = {
  id: "sub-1",
  taskId: "task",
  title: "Buy milk",
  completed: false,
  position: 0,
  assigneeId: null,
  dueDate: null,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  assignee: null,
};

afterEach(cleanup);

it("names the drag handle, checkbox, and delete with the subtask title", () => {
  const onDelete = vi.fn();
  render(
    <DndContext>
      <SortableContext items={[subtask.id]}>
        <SubtaskItem
          subtask={subtask}
          canEdit
          onToggle={vi.fn()}
          onUpdate={vi.fn()}
          onDelete={onDelete}
        />
      </SortableContext>
    </DndContext>,
  );
  const reorder = screen.getByRole("button", { name: "Reorder Buy milk" });
  const checkbox = screen.getByRole("checkbox", { name: "Buy milk" });
  const remove = screen.getByRole("button", { name: "Delete Buy milk" });
  expect(reorder.getAttribute("type")).toBe("button");
  expect(remove.getAttribute("type")).toBe("button");
  for (const button of [reorder, remove]) {
    expect(button.className).toContain("opacity-0");
    expect(button.className).toContain("group-hover:opacity-100");
    expect(button.className).toContain("group-focus-within:opacity-100");
    expect(button.className).toContain("focus-visible:opacity-100");
  }
  expect(checkbox.getAttribute("aria-label")).toBe("Buy milk");
  fireEvent.click(remove);
  expect(onDelete).toHaveBeenCalledWith("sub-1");
});
