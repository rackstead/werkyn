import type { ReactNode } from "react";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { CustomField } from "@/features/projects/api";
import type { TaskDetail } from "../api";

const { http, toastError, fields } = vi.hoisted(() => ({
  http: { get: vi.fn(), put: vi.fn() },
  toastError: vi.fn(),
  fields: [] as unknown[],
}));

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  api: http,
}));
vi.mock("../api", () => ({
  useUpdateTask: () => ({ mutate: vi.fn() }),
  useAddAssignee: () => ({ mutate: vi.fn() }),
  useRemoveAssignee: () => ({ mutate: vi.fn() }),
  useAddTaskLabel: () => ({ mutate: vi.fn() }),
  useRemoveTaskLabel: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/projects/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/projects/api")>()),
  useStatuses: () => ({ data: { data: [] } }),
  useLabels: () => ({ data: { data: [] } }),
  useProjectMembers: () => ({ data: { data: [] } }),
  useCustomFields: () => ({ data: { data: fields } }),
}));

const { ApiError } = await import("@/lib/api-client");
const { queryClient } = await import("@/lib/query-client");
const { useSetCustomFieldValue } = await import("@/features/projects/api");
const { TaskFields } = await import("./task-fields");
const { getColumns } = await import("@/features/list-view/components/columns");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  fields.length = 0;
});

const urlField = (id: string, name: string): CustomField => ({
  id, projectId: "p", name, type: "URL", options: null, required: false, position: 0,
});

function taskWith(values: Array<[string, string]>) {
  return {
    id: "t", projectId: "p", statusId: "s", priority: "NONE", startDate: null, dueDate: null,
    status: { id: "s", name: "Open", color: null, isCompletion: false }, assignees: [], labels: [],
    customFieldValues: values.map(([fieldId, value]) => ({ fieldId, value })),
  } as unknown as TaskDetail;
}

const SAFE = "https://example.com/spec";
const UNSAFE = "javascript:alert(document.cookie)";

it("task details link only http(s) URL values and show older unsafe values as text", () => {
  fields.push(urlField("safe", "Safe link"), urlField("unsafe", "Unsafe link"));
  render(<TaskFields task={taskWith([["safe", SAFE], ["unsafe", UNSAFE]])} canEdit={false} />);
  expect(screen.getByRole("link", { name: SAFE }).getAttribute("href")).toBe(SAFE);
  expect(screen.getByText(UNSAFE).closest("a")).toBeNull();
  expect(screen.getAllByRole("link")).toHaveLength(1);
});

it("list cells link only http(s) URL values", () => {
  const safe = urlField("safe", "Safe link");
  const unsafe = urlField("unsafe", "Unsafe link");
  const columns = getColumns({
    canEdit: false, onTaskClick: () => {}, onUpdateTask: () => {}, statuses: [], members: [], projectLabels: [],
    customFields: [safe, unsafe],
  });
  const task = taskWith([["safe", SAFE], ["unsafe", UNSAFE]]);
  for (const id of ["safe", "unsafe"]) {
    const column = columns.find((c) => c.id === `cf_${id}`)!;
    const cell = column.cell as (context: unknown) => ReactNode;
    render(<>{cell({ row: { original: task } })}</>);
  }
  expect(screen.getByRole("link").getAttribute("href")).toBe(SAFE);
  expect(screen.getByText(UNSAFE).closest("a")).toBeNull();
});

it("a value the server rejects shows the server's message", async () => {
  const message = '"Spec" must be an http or https URL, such as https://example.com, without spaces';
  http.put.mockReturnValue({ json: () => Promise.reject(new ApiError(400, "Bad Request", message, [{ field: "value", message }])) });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useSetCustomFieldValue("t", "p"), { wrapper });
  await act(async () => {
    result.current.mutate({ fieldId: "spec", value: "example.com" });
  });
  await waitFor(() => expect(toastError).toHaveBeenCalledWith(message));
  expect(http.put).toHaveBeenCalledWith("projects/p/tasks/t/custom-fields/spec", { json: { value: "example.com" } });
});
