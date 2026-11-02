import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CreateCommentSchema, UpdateCommentSchema } from "@pm/shared";
import { CommentForm } from "./comment-form";
import { CommentItem } from "./comment-item";
import type { Comment } from "../api";

const mutations = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock("../api", () => ({
  useCreateComment: () => ({ mutate: mutations.create, isPending: false }),
  useUpdateComment: () => ({ mutate: mutations.update, isPending: false }),
  useDeleteComment: () => ({ mutate: mutations.remove, isPending: false }),
}));
vi.mock("@tanstack/react-router", () => ({ useParams: () => ({ workspaceSlug: "acme" }) }));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (select: (state: { workspaces: Array<{ workspace: { id: string; slug: string } }> }) => unknown) =>
    select({ workspaces: [{ workspace: { id: "workspace", slug: "acme" } }] }),
}));
vi.mock("@/features/workspaces/api", () => ({ useWorkspaceMembers: () => ({ data: { data: [] } }) }));
vi.mock("@/components/shared/confirm-dialog", () => ({ ConfirmDialog: () => null }));

const comment: Comment = {
  id: "comment",
  taskId: "task",
  authorId: "member",
  body: "Original text",
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  author: { id: "member", displayName: "Pat", avatarUrl: null },
};

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

function editComment() {
  render(<CommentItem comment={comment} taskId="task" currentUserId="member" isAdmin={false} />);
  fireEvent.click(screen.getAllByRole("button")[0]);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(input.value).toBe(comment.body);
  return input;
}

it("posts pasted paragraph breaks and printable text using the existing comment contract", () => {
  render(<CommentForm taskId="task" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hello\u000bZoë\u000c李\u0007\tthere" } });
  fireEvent.click(screen.getByRole("button", { name: "Post" }));
  expect(mutations.create).toHaveBeenCalledTimes(1);
  const body = mutations.create.mock.calls[0][0];
  expect(body).toEqual({ body: "Hello\nZoë\n李\tthere" });
  expect(CreateCommentSchema.safeParse(body).success).toBe(true);
});

it("saves edited pasted paragraph breaks without sending disallowed control characters", () => {
  const input = editComment();
  fireEvent.change(input, { target: { value: "Revised\u000bwith\u000cparagraphs\u0007 Zoë\t李" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(mutations.update).toHaveBeenCalledTimes(1);
  const inputBody = mutations.update.mock.calls[0][0];
  expect(inputBody).toEqual({ id: "comment", body: "Revised\nwith\nparagraphs Zoë\t李" });
  expect(UpdateCommentSchema.safeParse(inputBody).success).toBe(true);
});

it("keeps Post disabled when normalizing the pasted text leaves no comment", () => {
  render(<CommentForm taskId="task" />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "\u0007\u000b\u000c" } });
  const post = screen.getByRole("button", { name: "Post" }) as HTMLButtonElement;
  expect(post.disabled).toBe(true);
  fireEvent.click(post);
  expect(mutations.create).not.toHaveBeenCalled();
});

it("preserves ordinary Unicode, tabs and line breaks", () => {
  render(<CommentForm taskId="task" />);
  const body = "Text\tZoë 李\nsecond line";
  fireEvent.change(screen.getByRole("textbox"), { target: { value: body } });
  fireEvent.click(screen.getByRole("button", { name: "Post" }));
  expect(mutations.create.mock.calls[0][0]).toEqual({ body });
});

it("does not send an update when a valid comment is saved unchanged", () => {
  editComment();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(mutations.update).not.toHaveBeenCalled();
});
