import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
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
const { shouldSaveCustomFieldValue } = await import("../custom-field-save");

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

it("inline saves skip unchanged values and emptied required fields", () => {
  const optional = { required: false };
  const required = { required: true };
  expect(shouldSaveCustomFieldValue(optional, "a", "b")).toBe(true);
  expect(shouldSaveCustomFieldValue(optional, "a", "a")).toBe(false);
  expect(shouldSaveCustomFieldValue(optional, ["a", "b"], ["a", "b"])).toBe(false);
  expect(shouldSaveCustomFieldValue(optional, ["a"], ["a", "b"])).toBe(true);
  expect(shouldSaveCustomFieldValue(optional, "a", null)).toBe(true);
  expect(shouldSaveCustomFieldValue(optional, undefined, null)).toBe(false);
  expect(shouldSaveCustomFieldValue(required, "a", null)).toBe(false);
  expect(shouldSaveCustomFieldValue(required, undefined, null)).toBe(false);
  expect(shouldSaveCustomFieldValue(required, "a", "b")).toBe(true);
  expect(shouldSaveCustomFieldValue(required, false, true)).toBe(true);
});

it("leaving an emptied required field sends nothing and shows the stored value again", async () => {
  http.put.mockReturnValue({ json: () => Promise.resolve({ data: null }) });
  fields.push(
    { id: "ticket", projectId: "p", name: "Ticket", type: "TEXT", options: null, required: true, position: 0 },
    { id: "notes", projectId: "p", name: "Notes", type: "TEXT", options: null, required: false, position: 1 },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <TaskFields task={taskWith([["ticket", "OPS-1"]])} canEdit />
    </QueryClientProvider>,
  );
  const ticket = screen.getByLabelText("Ticket") as HTMLInputElement;
  fireEvent.change(ticket, { target: { value: "" } });
  fireEvent.blur(ticket);
  expect(ticket.value).toBe("OPS-1");
  fireEvent.blur(screen.getByLabelText("Notes")); // empty and left empty
  fireEvent.blur(ticket); // unchanged
  expect(http.put).not.toHaveBeenCalled();
  expect(toastError).not.toHaveBeenCalled();

  fireEvent.change(ticket, { target: { value: "OPS-2" } });
  fireEvent.blur(ticket);
  await waitFor(() =>
    expect(http.put).toHaveBeenCalledWith("projects/p/tasks/t/custom-fields/ticket", { json: { value: "OPS-2" } }),
  );
});

it("a quick change back to the rendered value is still sent while the first save is in flight", async () => {
  // Neither request settles, so the rendered task value stays "A" throughout.
  http.put.mockReturnValue({ json: () => new Promise(() => {}) });
  fields.push({ id: "code", projectId: "p", name: "Code", type: "TEXT", options: null, required: false, position: 0 });
  render(
    <QueryClientProvider client={queryClient}>
      <TaskFields task={taskWith([["code", "A"]])} canEdit />
    </QueryClientProvider>,
  );
  const input = screen.getByLabelText("Code") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "B" } });
  fireEvent.blur(input);
  fireEvent.change(input, { target: { value: "A" } });
  fireEvent.blur(input);
  fireEvent.blur(input); // unchanged since the last save
  await waitFor(() => expect(http.put).toHaveBeenCalledTimes(2));
  expect(http.put.mock.calls.map(([, options]) => options.json.value)).toEqual(["B", "A"]);
});
