import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommentItem } from "./comment-item";
import type { Comment } from "../api";

vi.mock("../api", () => ({
  useUpdateComment: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteComment: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/shared/confirm-dialog", () => ({
  ConfirmDialog: () => null,
}));

const comment: Comment = {
  id: "comment",
  taskId: "task",
  authorId: "member",
  body: "Looks good",
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  author: { id: "member", displayName: "Pat", avatarUrl: null },
};

afterEach(cleanup);

it("names comment edit and delete and keeps them visible while the row is focused", () => {
  render(
    <CommentItem
      comment={comment}
      taskId="task"
      currentUserId="member"
      isAdmin={false}
    />,
  );
  const edit = screen.getByRole("button", { name: "Edit comment" });
  const remove = screen.getByRole("button", { name: "Delete comment" });
  expect(edit.getAttribute("type")).toBe("button");
  expect(remove.getAttribute("type")).toBe("button");
  const actions = edit.parentElement;
  expect(actions?.className).toContain("opacity-0");
  expect(actions?.className).toContain("group-hover:opacity-100");
  expect(actions?.className).toContain("group-focus-within:opacity-100");
  expect(actions?.closest(".group")).toBeTruthy();
});
