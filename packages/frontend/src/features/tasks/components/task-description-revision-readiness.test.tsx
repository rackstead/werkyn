import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskDescription } from "@/features/tasks/components/task-description";
import { useAuthStore } from "@/stores/auth-store";
const { http } = vi.hoisted(() => ({
  http: { patch: vi.fn(), get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/lib/api-client", () => ({ api: http }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}));
let client: QueryClient;
let seq = 0;
function wrapper({ children }: any) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  useAuthStore.setState({ user: { id: "description-user" } as any });
});
afterEach(() => {
  cleanup();
  client.clear();
});
it("task stays read-only until its first description revision is available", async () => {
  const id = `unknown-revision-${++seq}`;
  const s = render(
    <TaskDescription
      taskId={id}
      description="<p>Reviewed server text</p>"
      canEdit
    />,
    { wrapper },
  );
  await waitFor(() =>
    expect(s.container.querySelector(".tiptap")).not.toBeNull(),
  );
  expect(
    s.container.querySelector(".tiptap")!.getAttribute("contenteditable"),
  ).toBe("false");
  expect(http.patch).not.toHaveBeenCalled();
  s.rerender(
    <TaskDescription
      taskId={id}
      description="<p>Reviewed server text</p>"
      descriptionRevision={7}
      canEdit
    />,
  );
  await waitFor(() =>
    expect(
      s.container.querySelector(".tiptap")!.getAttribute("contenteditable"),
    ).toBe("true"),
  );
  expect(s.container.textContent).toContain("Reviewed server text");
  expect(http.patch).not.toHaveBeenCalled();
});
it("known description revision allows editing without an automatic write", async () => {
  const s = render(
    <TaskDescription
      taskId={`known-revision-${++seq}`}
      description="<p>Reviewed server text</p>"
      descriptionRevision={7}
      canEdit
    />,
    { wrapper },
  );
  await waitFor(() =>
    expect(
      s.container.querySelector(".tiptap")!.getAttribute("contenteditable"),
    ).toBe("true"),
  );
  expect(http.patch).not.toHaveBeenCalled();
});
