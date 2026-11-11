import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Slideover } from "@/components/ui/slideover";
import { CommentForm } from "./comment-form";

vi.mock("../api", () => ({
  useCreateComment: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ workspaceSlug: "acme" }),
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (
    select: (state: {
      workspaces: Array<{ workspace: { id: string; slug: string } }>;
    }) => unknown,
  ) =>
    select({ workspaces: [{ workspace: { id: "workspace", slug: "acme" } }] }),
}));
vi.mock("@/features/workspaces/api", () => ({
  useWorkspaceMembers: () => ({
    data: {
      data: [
        { user: { id: "ada", displayName: "Ada Lovelace", avatarUrl: null } },
      ],
    },
  }),
}));

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
});
afterEach(cleanup);

it("Escape closes the mention list and leaves the panel and unsent text", async () => {
  const onClose = vi.fn();
  render(
    <Slideover title="Task" onClose={onClose}>
      <CommentForm taskId="task" />
    </Slideover>,
  );
  const input = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
  input.focus();
  fireEvent.change(input, {
    target: { value: "Hello @Ada", selectionStart: 10 },
  });
  expect(screen.getByRole("button", { name: /Ada Lovelace/ })).toBeTruthy();

  fireEvent.keyDown(input, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Task" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Ada Lovelace/ })).toBeNull();
  expect(input.value).toBe("Hello @Ada");

  fireEvent.keyDown(input, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});
