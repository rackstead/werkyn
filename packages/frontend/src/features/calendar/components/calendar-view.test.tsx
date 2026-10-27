import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Task } from "@/features/tasks/api";
import { CalendarView } from "./calendar-view";

const state = vi.hoisted(() => ({ tasks: [] as Task[] }));
vi.mock("@/features/tasks/api", () => ({
  useProjectTasks: () => ({ data: { data: state.tasks }, isLoading: false }),
  useUpdateTask: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/tasks/components/create-task-dialog", () => ({
  CreateTaskDialog: () => null,
}));
vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => false }));

beforeEach(() => {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  state.tasks = [
    {
      id: "literal-event",
      title: "<b>Literal event title</b>",
      priority: "HIGH",
      startDate: date,
      dueDate: date,
      status: {
        id: "status",
        name: "<em>Literal status</em>",
        color: "red; border: 4px solid blue",
        isCompletion: false,
      },
      assignees: [],
      labels: [],
      description: null,
    } as unknown as Task,
  ];
});
afterEach(cleanup);

it("shows the real FullCalendar event tooltip as literal text and destroys Tippy on removal", async () => {
  const { container, rerender } = render(
    <CalendarView
      projectId="project"
      editable={false}
      onTaskClick={() => {}}
    />,
  );
  const event = container.querySelector(".fc-event") as HTMLElement & {
    _tippy: {
      props: { allowHTML: boolean; content: unknown };
      state: { isDestroyed: boolean };
    };
  };
  expect(event).not.toBeNull();
  const instance = event._tippy;
  expect(instance.props.allowHTML).toBe(false);
  expect(instance.props.content).toBeInstanceOf(HTMLDivElement);
  fireEvent.mouseEnter(event);
  await waitFor(() =>
    expect(document.querySelector(".tippy-content")?.textContent).toContain(
      state.tasks[0].status.name,
    ),
  );
  const content = document.querySelector(".tippy-content")!;
  expect(content.textContent).toContain(state.tasks[0].title);
  expect(content.querySelector("b,em")).toBeNull();
  expect(
    (content.children[0].children[1].firstElementChild as HTMLElement).style
      .backgroundColor,
  ).toBe("rgb(156, 163, 175)");
  state.tasks = [];
  rerender(
    <CalendarView
      projectId="project"
      editable={false}
      onTaskClick={() => {}}
    />,
  );
  expect(instance.state.isDestroyed).toBe(true);
  expect(document.querySelector(".tippy-content")).toBeNull();
});
