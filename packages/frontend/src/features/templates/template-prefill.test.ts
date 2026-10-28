import { describe, expect, it } from "vitest";
import type { TaskTemplate } from "./api";
import { templatePrefill } from "./template-prefill";

const template = (overrides: Partial<TaskTemplate>): TaskTemplate => ({
  id: "t1", projectId: "p1", name: "Template", title: "Title", description: null,
  priority: "NONE", statusId: null, dueOffset: null, assigneeIds: [], labelIds: [], subtasks: [],
  createdAt: "", updatedAt: "", ...overrides,
});
const options = { statusIds: ["s1"], memberIds: ["u1", "u2"], labelIds: ["l1"] };

describe("templatePrefill", () => {
  it("keeps references the project still offers", () => {
    expect(templatePrefill(template({ statusId: "s1", assigneeIds: ["u2", "u1"], labelIds: ["l1"] }), options))
      .toEqual({ statusId: "s1", assigneeIds: ["u2", "u1"], labelIds: ["l1"] });
  });

  it("drops deleted, foreign and duplicate references", () => {
    expect(templatePrefill(template({ statusId: "gone", assigneeIds: ["u1", "left", "u1"], labelIds: ["other", "l1", "l1"] }), options))
      .toEqual({ statusId: null, assigneeIds: ["u1"], labelIds: ["l1"] });
  });
});
