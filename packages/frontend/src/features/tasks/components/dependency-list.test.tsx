import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskDetail } from "../api";
import { DependencyList } from "./dependency-list";

const remove = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({
  useAddDependency: () => ({ mutate: vi.fn() }),
  useRemoveDependency: () => ({ mutate: remove }),
  useProjectTasks: () => ({ data: { data: [] } }),
}));

const task = {
  id: "task",
  projectId: "project",
  blockedBy: [
    {
      id: "dep",
      blockingTask: {
        id: "blocker",
        title: "Ship the API",
        status: { name: "Done" },
      },
    },
  ],
  blocking: [],
} as unknown as TaskDetail;

afterEach(() => {
  cleanup();
  remove.mockClear();
});

it("names the dependency remove button with the blocking task title", () => {
  render(<DependencyList task={task} canEdit />);
  const button = screen.getByRole("button", {
    name: "Remove dependency Ship the API",
  });
  expect(button.getAttribute("type")).toBe("button");
  fireEvent.click(button);
  expect(remove).toHaveBeenCalledWith({
    depId: "dep",
    blockingTaskId: "blocker",
  });
});
