import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CreateCommentSchema, UpdateCommentSchema } from "@pm/shared";
import { ApiError } from "@/lib/api-error";
import { queryKeys } from "@/lib/query-keys";

const owned = vi.hoisted(() => ({
  client: null as any,
  error: null as unknown,
  calls: [] as Array<{ method: string; path: string; options: any }>,
  toastError: vi.fn(), toastSuccess: vi.fn(),
  state: { workspaces: [] as unknown[], user: null, accessToken: null },
}));
vi.mock("sonner", () => ({ toast: { error: owned.toastError, success: owned.toastSuccess } }));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: Object.assign((selector: any) => selector(owned.state), {
    getState: () => owned.state, subscribe: () => () => {}, setState: vi.fn(),
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useParams: () => ({ workspaceSlug: "owned-workspace" }) }));
vi.mock("@/features/workspaces/api", () => ({ useWorkspaceMembers: () => ({ data: { data: [] } }) }));
vi.mock("@/components/shared/user-avatar", () => ({ UserAvatar: () => null }));
vi.mock("@/components/shared/confirm-dialog", () => ({ ConfirmDialog: () => null }));
vi.mock("@/features/comments/components/mention-dropdown", () => ({ MentionDropdown: () => null }));
vi.mock("@/lib/query-client", () => ({ queryClient: {
  invalidateQueries: (input: any) => owned.client.invalidateQueries(input),
} }));
vi.mock("@/lib/api-client", async (original) => {
  // Keep the real existing error mapper. Replace only the ordinary transport;
  // no network, session transition, refresh, logout or authorization call runs.
  const real = await original<typeof import("@/lib/api-client")>();
  const request = (method: string, path: string, options: any) => ({
    json: async () => {
      owned.calls.push({ method, path, options });
      if (owned.error !== null) throw owned.error;
      return { data: { id: "owned-comment", body: options.json.body } };
    },
  });
  return { ...real, api: { post: (p: string, o: any) => request("POST", p, o), patch: (p: string, o: any) => request("PATCH", p, o) } };
});
import { useCreateComment, useUpdateComment } from "@/features/comments/api";
import { CommentForm } from "@/features/comments/components/comment-form";
import { CommentItem } from "@/features/comments/components/comment-item";

const taskId = "owned-comment-task";
const longOrdinaryBody = "a".repeat(10001); // Ordinary textarea input; bounded10KB.
const draft = "Ordinary draft";
let client: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
function validationError(update = false): ApiError {
  const result = (update ? UpdateCommentSchema : CreateCommentSchema).safeParse({ body: longOrdinaryBody });
  if (result.success) throw new Error("Existing10000-character server schema prerequisite changed");
  const details = result.error.issues.map(issue => ({ field: issue.path.join("."), message: issue.message }));
  expect(details.some(item => item.field === "body")).toBe(true);
  return new ApiError(400, "Bad Request", "Validation failed", details);
}
function requiredMessage(error: ApiError): string {
  const detail = error.details!.find(item => item.field === "body")!;
  return `Comment: ${detail.message}`;
}
function seedCache() {
  client.setQueryData(queryKeys.comments(taskId), { owned: "comments" });
  client.setQueryData(queryKeys.activity(taskId), { owned: "activity" });
}
async function rejectMutation(update: boolean, error: unknown, body = draft) {
  owned.error = error;
  const view = renderHook(() => update ? useUpdateComment(taskId) : useCreateComment(taskId), { wrapper });
  await act(async () => {
    const input = update ? { id: "owned-comment", body } : { body };
    await expect(view.result.current.mutateAsync(input as any)).rejects.toBe(error);
  });
  await waitFor(() => expect(view.result.current.isError).toBe(true));
  expect(owned.calls).toHaveLength(1);
  expect(owned.toastError).toHaveBeenCalledTimes(1);
  expect(client.getQueryState(queryKeys.comments(taskId))?.isInvalidated).toBe(false);
  expect(client.getQueryState(queryKeys.activity(taskId))?.isInvalidated).toBe(false);
  return view;
}
beforeEach(() => {
  owned.error = null; owned.calls.length = 0; owned.toastError.mockClear(); owned.toastSuccess.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  owned.client = client; seedCache();
});
afterEach(async () => {
  cleanup(); client.clear();
  // Settle only the ordinary already-owned notification turn; no fake timers,
  // broad timer flush, error suppression, native parser or modal is used.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  owned.client = null;
});

describe("comment validation feedback", () => {
  it("create reports the existing safe body400 reason once", async () => {
    const error = validationError();
    await rejectMutation(false, error, longOrdinaryBody);
    expect(owned.calls[0]).toEqual({ method: "POST", path: `tasks/${taskId}/comments`, options: { json: { body: longOrdinaryBody } } });
    expect(owned.toastError).toHaveBeenLastCalledWith(requiredMessage(error));
  });
  it("edit reports the existing safe body400 reason once", async () => {
    const error = validationError(true);
    await rejectMutation(true, error, longOrdinaryBody);
    expect(owned.calls[0]).toEqual({ method: "PATCH", path: "comments/owned-comment", options: { json: { body: longOrdinaryBody } } });
    expect(owned.toastError).toHaveBeenLastCalledWith(requiredMessage(error));
  });
  const fallbacks: Array<{ name: string; update: boolean; error: () => unknown }> = [
    { name: "blank body detail", update: false, error: () => new ApiError(400, "Bad Request", "owned-top-level-token", [{ field: "body", message: "   " }]) },
    { name: "non-string body detail", update: true, error: () => new ApiError(400, "Bad Request", "owned-top-level-token", [{ field: "body", message: { owned: "diagnostic-token" } }] as any) },
    { name: "403 body detail", update: false, error: () => new ApiError(403, "Forbidden", "owned-forbidden-token", [{ field: "body", message: "owned-forbidden-detail" }]) },
    { name: "500 body detail", update: true, error: () => new ApiError(500, "Internal Server Error", "owned-server-token", [{ field: "body", message: "owned-server-detail" }]) },
    { name: "native error", update: false, error: () => new TypeError("owned-native-diagnostic-token") },
    { name: "network error", update: true, error: () => new Error("owned-network-diagnostic-token") },
    { name: "unknown object", update: false, error: () => ({ owned: "diagnostic-token" }) },
    { name: "missing details", update: true, error: () => new ApiError(400, "Bad Request", "owned-top-level-token") },
    { name: "unrelated details", update: false, error: () => new ApiError(400, "Bad Request", "owned-top-level-token", [{ field: "unrelated", message: "owned-unrelated-token" }]) },
    { name: "malformed detail array", update: true, error: () => new ApiError(400, "Bad Request", "owned-top-level-token", [null] as any) },
  ];
  for (const item of fallbacks) it(`${item.name} keeps one redacted generic fallback`, async () => {
    await rejectMutation(item.update, item.error());
    expect(owned.toastError).toHaveBeenLastCalledWith(item.update ? "Failed to update comment" : "Failed to post comment");
  });
  it("create success retains payload, comments/activity invalidation and success callback", async () => {
    const success = vi.fn();
    const view = renderHook(() => useCreateComment(taskId), { wrapper });
    const body = "\tHello 世界\n&amp; @[owned-member]";
    await act(async () => { await view.result.current.mutateAsync({ body }, { onSuccess: success }); });
    expect(owned.calls).toEqual([{ method: "POST", path: `tasks/${taskId}/comments`, options: { json: { body } } }]);
    expect(client.getQueryState(queryKeys.comments(taskId))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.activity(taskId))?.isInvalidated).toBe(true);
    expect(success).toHaveBeenCalledTimes(1); expect(owned.toastError).not.toHaveBeenCalled();
  });
  it("edit success retains sparse payload and only comments invalidation", async () => {
    const success = vi.fn();
    const view = renderHook(() => useUpdateComment(taskId), { wrapper });
    await act(async () => { await view.result.current.mutateAsync({ id: "owned-comment", body: draft }, { onSuccess: success }); });
    expect(owned.calls).toEqual([{ method: "PATCH", path: "comments/owned-comment", options: { json: { body: draft } } }]);
    expect(client.getQueryState(queryKeys.comments(taskId))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.activity(taskId))?.isInvalidated).toBe(false);
    expect(success).toHaveBeenCalledTimes(1); expect(owned.toastError).not.toHaveBeenCalled();
  });
  it("actual create caller submits ordinary overlength text and retains its draft after400", async () => {
    owned.error = validationError();
    render(<CommentForm taskId={taskId} />, { wrapper });
    const textarea = screen.getByPlaceholderText("Write a comment... Use @ to mention");
    fireEvent.change(textarea, { target: { value: longOrdinaryBody } });
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() => expect(owned.toastError).toHaveBeenCalledTimes(1));
    expect(owned.calls).toHaveLength(1); expect(owned.calls[0].options.json).toEqual({ body: longOrdinaryBody });
    expect((textarea as HTMLTextAreaElement).value).toBe(longOrdinaryBody);
    await waitFor(() => expect((screen.getByRole("button", { name: "Post" }) as HTMLButtonElement).disabled).toBe(false));
  });
  it("actual edit caller retains overlength draft and edit state after400", async () => {
    owned.error = validationError(true);
    const comment = { id: "owned-comment", taskId, authorId: "owned-author", body: "Stored", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", author: null };
    const view = render(<CommentItem taskId={taskId} comment={comment} currentUserId="owned-author" isAdmin={false} />, { wrapper });
    // Ordinary edit entry only; no visibility/keyboard/modal/accessibility claim.
    fireEvent.click(view.container.querySelector("button")!);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: longOrdinaryBody } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(owned.toastError).toHaveBeenCalledTimes(1));
    expect(owned.calls).toHaveLength(1); expect(owned.calls[0].options.json).toEqual({ body: longOrdinaryBody });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(longOrdinaryBody);
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});
