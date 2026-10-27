import { describe, expect, it } from "vitest";
import type { Task } from "@/features/tasks/api";
import { buildEventTooltip } from "./build-event-tooltip";
import {
  CreateStatusColumnSchema,
  UpdateStatusColumnSchema,
} from "../../../../../shared/src/schemas/status-column";
import {
  CreateLabelSchema,
  UpdateLabelSchema,
} from "../../../../../shared/src/schemas/label";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    title: "Task title",
    status: {
      id: "status",
      name: "Open",
      color: "#336699",
      isCompletion: false,
    },
    priority: "HIGH",
    startDate: "2026-10-26",
    dueDate: "2026-10-27",
    assignees: [],
    labels: [],
    description: null,
    ...overrides,
  } as Task;
}

describe("calendar tooltip safety", () => {
  it("renders legacy invalid colors and literal markup without creating elements", () => {
    const payload = "red; border: 4px solid blue";
    const task = makeTask({
      title: "<b>Literal title</b>",
      status: {
        id: "status",
        name: "<em>Literal status</em>",
        color: payload,
        isCompletion: false,
      },
      labels: [
        {
          labelId: "label",
          label: {
            id: "label",
            name: "<strong>Literal label</strong>",
            color: payload,
          },
        },
      ],
      assignees: [
        {
          userId: "user",
          user: {
            id: "user",
            displayName: "<i>Literal assignee</i>",
            avatarUrl: null,
          },
        },
      ],
      description: "<p>Body &amp; text</p>",
    });

    const tooltip = buildEventTooltip(task);
    document.body.append(tooltip);
    expect(
      tooltip.querySelector("b,em,strong,i,p,img,script,svg,iframe"),
    ).toBeNull();
    expect(tooltip.textContent).toContain(task.title);
    expect(tooltip.textContent).toContain(task.status.name);
    expect(tooltip.textContent).toContain(task.labels[0].label.name);
    expect(tooltip.textContent).toContain(task.assignees[0].user.displayName);
    expect(tooltip.textContent).toContain("Body &amp; text");
    for (const swatch of [
      tooltip.children[1].firstElementChild,
      tooltip.children[5].firstElementChild,
    ]) {
      expect((swatch as HTMLElement).style.backgroundColor).toBe(
        "rgb(156, 163, 175)",
      );
    }
    tooltip.remove();
  });

  it("preserves valid tooltip contents and colors", () => {
    const tooltip = buildEventTooltip(
      makeTask({
        labels: [
          {
            labelId: "label",
            label: { id: "label", name: "Design", color: "#f00" },
          },
        ],
        description: `<p>${"x".repeat(110)}</p>`,
      }),
    );
    expect(tooltip).toBeInstanceOf(HTMLDivElement);
    expect(tooltip.textContent).toContain(
      "Task titleOpenHigh priorityOct 26 – Oct 27Design",
    );
    expect(tooltip.querySelector("span")?.style.backgroundColor).toBe(
      "rgb(51, 102, 153)",
    );
    expect(tooltip.textContent).toContain(`${"x".repeat(100)}…`);
  });

  it.each([null, undefined, "red", "rgb(12, 34, 56)", "#12345"])(
    "uses a neutral status swatch for legacy color %s",
    (color) => {
      const task = makeTask();
      task.status.color = color as string | null;
      const tooltip = buildEventTooltip(task);
      expect(
        (tooltip.children[1].firstElementChild as HTMLElement).style
          .backgroundColor,
      ).toBe("rgb(156, 163, 175)");
    },
  );

  it("keeps a date-only tooltip compact and treats description entities as text", () => {
    const tooltip = buildEventTooltip(
      makeTask({ startDate: null, description: "&lt;b&gt;Literal&lt;/b&gt;" }),
    );
    expect(tooltip.children).toHaveLength(5);
    expect(tooltip.children[3].textContent).toBe("Oct 27");
    expect(tooltip.lastElementChild?.textContent).toBe(
      "&lt;b&gt;Literal&lt;/b&gt;",
    );
    expect(tooltip.querySelector("b")).toBeNull();
    expect(
      buildEventTooltip(makeTask({ startDate: null, dueDate: null })).children,
    ).toHaveLength(3);
  });
});

describe("status and label color validation", () => {
  const schemas = [
    CreateStatusColumnSchema,
    UpdateStatusColumnSchema,
    CreateLabelSchema,
    UpdateLabelSchema,
  ];
  it.each(["#abc", "#abcd", "#abcdef", "#ABCDEF", "#abcdef12"])(
    "accepts CSS hex color %s",
    (color) => {
      for (const schema of schemas)
        expect(schema.safeParse({ name: "Color", color }).success).toBe(true);
    },
  );
  it.each([
    "red; border: 4px solid blue",
    "red",
    "rgb(12, 34, 56)",
    "#12345",
    "#zzzzzz",
    "",
  ])("rejects unsafe/invalid color %s", (color) => {
    for (const schema of schemas)
      expect(schema.safeParse({ name: "Color", color }).success).toBe(false);
  });
  it("keeps optional status colors and partial label updates optional", () => {
    expect(CreateStatusColumnSchema.safeParse({ name: "Open" }).success).toBe(
      true,
    );
    expect(UpdateStatusColumnSchema.safeParse({ name: "Closed" }).success).toBe(
      true,
    );
    expect(UpdateLabelSchema.safeParse({ name: "Renamed" }).success).toBe(true);
    expect(CreateLabelSchema.safeParse({ name: "Missing color" }).success).toBe(
      false,
    );
    expect(CreateStatusColumnSchema.parse({ name: "Open" }).isCompletion).toBe(
      false,
    );
    expect(UpdateStatusColumnSchema.parse({})).toEqual({});
    expect(UpdateLabelSchema.parse({})).toEqual({});
    for (const schema of schemas) {
      for (const color of [
        null,
        123,
        " #abc",
        "#abc ",
        "#abc\n",
        "#ab",
        "#abcdef0",
      ]) {
        expect(schema.safeParse({ name: "Color", color }).success).toBe(false);
      }
    }
  });
});
