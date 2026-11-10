import { writeFile } from "node:fs/promises";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { CreateTemplateSchema, UpdateTemplateSchema } from "@pm/shared";
import { toast } from "sonner";
import { ApiError } from "@/lib/api-error";
import { identityGeneration } from "@/lib/identity";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth-store";
import { TemplateManager } from "./template-manager";
import type { TaskTemplate } from "../api";

const transport = vi.hoisted(() => {
  vi.stubGlobal("BroadcastChannel", class { addEventListener() {} removeEventListener() {} postMessage() {} close() {} });
  return { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() };
});
vi.mock("@/lib/api-client", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/api-client")>(), api: transport }));
vi.mock("@/lib/router", () => ({ router: { invalidate: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type Person = NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>;
type Call = { actor: string; generation: number; method: string; path: string; data?: Record<string, unknown>;
  objectKeys?: string[]; status?: number; details?: Array<{ field: string; message: string }>; delivered: boolean; release?: () => void };
let database: Map<string, Map<string, TaskTemplate[]>>, calls: Call[], notes: unknown[], unexpected: string[];
let holdNext = false, failNext = false;
let ordinaryFailure: unknown = null;
const observations: unknown[] = [];
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
const copy = <T,>(value: T): T => structuredClone(value);
const actor = () => useAuthStore.getState().user?.id ?? "signed-out";
const rows = (owner = actor(), project = "p") => database.get(owner)!.get(project)!;
const writes = () => calls.filter((call) => call.method !== "GET");
const facts = () => calls.map(({ release: _release, ...value }) => copy(value));
function person(id: string): Person {
  return { id, email: `${id}@example.test`, displayName: id, avatarUrl: null,
    jobTitle: null, phone: null, timezone: null, emailVerified: true };
}
function template(id: string, name: string, projectId = "p"): TaskTemplate {
  return { id, projectId, name, title: "Review the plan", description: "Notes &amp; follow-up\nΩ",
    priority: "MEDIUM", statusId: "status-1", dueOffset: 3,
    assigneeIds: ["member-1", "member-2"], labelIds: ["label-1", "label-2"],
    subtasks: [{ title: "First" }, { title: "Second" }],
    createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z" };
}
function signIn(id: string) {
  act(() => useAuthStore.setState({ user: person(id), accessToken: "owned-memory-context", workspaces: [] }));
}
function Subject({ project = "p" }: { project?: string }) {
  return <QueryClientProvider client={queryClient}><TemplateManager projectId={project} /></QueryClientProvider>;
}
const nameInput = () => screen.getByPlaceholderText("e.g. Bug report") as HTMLInputElement;
const maybeName = () => screen.queryByPlaceholderText("e.g. Bug report") as HTMLInputElement | null;
const titleInput = () => screen.getByPlaceholderText("e.g. Fix: ...") as HTMLInputElement;
const dueInput = () => screen.getByPlaceholderText("No due date") as HTMLInputElement;
const descriptionInput = () => screen.getByPlaceholderText("Task description...") as HTMLTextAreaElement;
const editor = () => nameInput().parentElement!.closest<HTMLElement>(".rounded-md.border")!;
const pencilButtons = () => [...document.querySelectorAll("svg.lucide-pencil")].map((svg) => svg.closest("button")!);
const saveButton = () => within(editor()).getByRole("button", { name: "Save" }) as HTMLButtonElement;
const change = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => fireEvent.change(element, { target: { value } });
function note(label: string) {
  notes.push({ label, actor: actor(), generation: identityGeneration(), calls: facts(),
    stores: [...database].map(([owner, projects]) => ({ owner, projects: [...projects].map(([project, values]) => ({ project, values: copy(values) })) })),
    cache: copy(queryClient.getQueryData(queryKeys.templates("p"))),
    inputs: [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea")].map((input) => ({ placeholder: input.placeholder, value: input.value })),
    saveDisabled: maybeName() ? (within(editor()).queryByRole("button", { name: "Save" }) as HTMLButtonElement | null)?.disabled ?? null : null,
    success: vi.mocked(toast.success).mock.calls.map(([message]) => message),
    error: vi.mocked(toast.error).mock.calls.map(([message]) => message) });
}
async function quiet() {
  await act(async () => { await Promise.resolve(); });
  await waitFor(() => expect(queryClient.isMutating()).toBe(0));
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
}
async function mount(fields: Partial<TaskTemplate> = {}) {
  Object.assign(rows("a")[0], fields);
  signIn("a");
  const view = render(<Subject />);
  await waitFor(() => expect(pencilButtons()).toHaveLength(2));
  await quiet(); note("mounted"); return view;
}
async function open(index = 0) {
  fireEvent.click(pencilButtons()[index]);
  await waitFor(() => expect(maybeName()).not.toBeNull());
  note("editor-open");
}
async function save(label = "save-settled") { fireEvent.click(saveButton()); await quiet(); note(label); }
function cancel() { fireEvent.click(within(editor()).getByRole("button", { name: "Cancel" })); }
async function toggle(buttonName: "Assign" | "Label", itemName: string) {
  const button = within(editor()).getByRole("button", { name: buttonName });
  fireEvent.click(button);
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(itemName) }));
  fireEvent.click(button);
  await waitFor(() => expect(screen.queryByPlaceholderText(buttonName === "Assign" ? "Search members..." : "Search labels...")).toBeNull());
}
async function noStatus() {
  fireEvent.keyDown(within(editor()).getByRole("combobox"), { key: "ArrowDown" });
  fireEvent.keyDown(await screen.findByRole("option", { name: "Default (first column)" }), { key: "Enter" });
}
function removeSubtask(index: number) {
  const field = screen.getByPlaceholderText(`Subtask ${index + 1}`);
  fireEvent.click(field.parentElement!.querySelector("button")!);
}
function addSubtask() { fireEvent.click(within(editor()).getByRole("button", { name: "+ Add subtask" })); }
async function pending() {
  holdNext = true;
  fireEvent.click(saveButton());
  await waitFor(() => expect(writes()).toHaveLength(1));
  await waitFor(() => expect(queryClient.isMutating()).toBe(1));
  note("pending-response"); return writes()[0];
}
async function release(call: Call) { await act(async () => { call.release?.(); await Promise.resolve(); }); await quiet(); note("held-response-settled"); }

beforeEach(() => {
  queryClient.clear(); useAuthStore.setState(useAuthStore.getInitialState(), true);
  database = new Map([
    ["a", new Map([["p", [template("template-a", "Template A"), template("template-b", "Template B")]], ["q", [template("template-q", "Project Q", "q")]]])],
    ["b", new Map([["p", [template("template-b-owner", "Other account")]], ["q", [template("template-b-q", "Other Q", "q")]]])],
  ]);
  calls = []; notes = []; unexpected = []; holdNext = false; failNext = false; ordinaryFailure = null;
  vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear();
  for (const mock of Object.values(transport)) mock.mockReset();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", () => { unexpected.push("real-network"); return Promise.reject(new Error("Unexpected real network")); });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  transport.get.mockImplementation((path: string) => ({ json: async () => {
    const call: Call = { actor: actor(), generation: identityGeneration(), method: "GET", path, delivered: true }; calls.push(call);
    const match = /^projects\/(p|q)\/(templates|statuses|labels|members)$/.exec(path);
    if (!match || !database.has(call.actor)) { unexpected.push(`GET ${path}`); throw new Error("Unexpected template GET"); }
    call.status = 200;
    const [, project, resource] = match;
    if (resource === "templates") return { data: copy(rows(call.actor, project)) };
    if (resource === "statuses") return { data: [{ id: "status-1", name: "Ready", color: null, position: 0, isCompletion: false }, { id: "status-2", name: "Done", color: null, position: 1, isCompletion: true }] };
    if (resource === "labels") return { data: [{ id: "label-1", name: "Routine", color: "#123456" }, { id: "label-2", name: "Planning", color: "#654321" }] };
    return { data: [{ id: "member-1-row", user: { id: "member-1", displayName: "Avery Lane", avatarUrl: null } }, { id: "member-2-row", user: { id: "member-2", displayName: "Morgan Reed", avatarUrl: null } }] };
  } }));
  function write(method: "PATCH" | "POST", path: string, options: { json: Record<string, unknown> }) {
    const call: Call = { actor: actor(), generation: identityGeneration(), method, path,
      data: JSON.parse(JSON.stringify(options.json)), objectKeys: Object.keys(options.json).sort(), delivered: false }; calls.push(call);
    const delayed = holdNext, refused = failNext, refusal = ordinaryFailure; holdNext = false; failNext = false; ordinaryFailure = null;
    return { json: async () => {
      const match = /^projects\/(p|q)\/templates(?:\/(template-[a-z-]+))?$/.exec(path);
      if (!match || !database.has(call.actor) || method === "PATCH" && !match[2]) { unexpected.push(`${method} ${path}`); throw new Error("Unexpected template write"); }
      const project = match[1], id = match[2];
      const parsed = method === "PATCH" ? UpdateTemplateSchema.safeParse(call.data) : CreateTemplateSchema.safeParse(call.data);
      if (!parsed.success) { call.status = 400; call.delivered = true; call.details = parsed.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })); throw new ApiError(400, "Bad Request", "Validation failed", call.details); }
      const deliver = () => {
        call.delivered = true;
        if (refusal !== null) { call.status = 503; throw refusal; }
        if (refused) { call.status = 503; throw new ApiError(503, "Service Unavailable", "Owned save unavailable"); }
        if (method === "PATCH") {
          const target = rows(call.actor, project).find((value) => value.id === id);
          if (!target) { unexpected.push("unknown-owned-template"); throw new Error("Unknown owned template"); }
          Object.assign(target, parsed.data); call.status = 200; return { data: copy(target) };
        }
        const created = { ...template("template-created", "Created", project), description: null, statusId: null, dueOffset: null, ...parsed.data } as TaskTemplate;
        rows(call.actor, project).push(created); call.status = 201; return { data: copy(created) };
      };
      if (!delayed) return deliver();
      return new Promise<{ data: TaskTemplate }>((resolve, reject) => { call.release = () => { try { resolve(deliver()); } catch (error) { reject(error); } }; });
    } };
  }
  transport.patch.mockImplementation((path, options) => write("PATCH", path, options));
  transport.post.mockImplementation((path, options) => write("POST", path, options));
  transport.delete.mockImplementation(() => { unexpected.push("unexpected-delete"); return Promise.reject(new Error("Unexpected delete")); });
});

afterEach(async () => {
  for (const call of calls) if (!call.delivered && call.release) await act(async () => call.release!());
  await quiet(); note("final-before-assert-cleanup");
  observations.push({ name: expect.getState().currentTestName, notes, unexpected: [...unexpected],
    pendingWrites: writes().filter((call) => !call.delivered).length });
  if (process.env.TEMPLATE_PARTIAL_OBSERVATIONS) await writeFile(process.env.TEMPLATE_PARTIAL_OBSERVATIONS, JSON.stringify(observations, null, 2) + "\n");
  cleanup(); queryClient.clear(); useAuthStore.setState(useAuthStore.getInitialState(), true); vi.unstubAllGlobals();
  expect(unexpected).toEqual([]); expect(writes().every((call) => call.delivered)).toBe(true);
});
afterAll(() => {
  if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
  else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

test("omits unchanged legacy name due offset and subtasks while changing only title", async () => {
  await mount({ name: "N".repeat(256), dueOffset: 5000, subtasks: [{ title: "S".repeat(256) }] }); await open();
  change(titleInput(), "Revised title"); await save();
  expect(writes()[0].data).toEqual({ title: "Revised title" }); expect(writes()[0].status).toBe(200);
  expect(rows()[0].dueOffset).toBe(5000); expect(rows()[0].name).toHaveLength(256);
});
test("omits unchanged blank legacy title while trimming only the changed name", async () => {
  await mount({ title: "" }); await open(); change(nameInput(), "  Revised name  "); await save();
  expect(writes()).toHaveLength(1); expect(writes()[0].data).toEqual({ name: "Revised name" }); expect(rows()[0].title).toBe("");
});
test("sends only an explicitly edited literal description without decoding text", async () => {
  await mount({ description: "Fish &amp; chips" }); await open();
  expect(descriptionInput().value).toBe("Fish & chips");
  change(descriptionInput(), "Fish & chips today"); await save();
  expect(writes()[0].data).toEqual({ description: "Fish & chips today" });
});
test("clears only the description with null", async () => {
  await mount(); await open(); change(descriptionInput(), ""); await save(); expect(writes()[0].data).toEqual({ description: null });
});
test("clears only status with null through the real select", async () => {
  await mount(); await open(); await noStatus(); await save(); expect(writes()[0].data).toEqual({ statusId: null });
});
test("clears only due offset with null", async () => {
  await mount(); await open(); change(dueInput(), ""); await save(); expect(writes()[0].data).toEqual({ dueOffset: null });
});
test("sends due offset zero rather than null", async () => {
  await mount(); await open(); change(dueInput(), "0"); await save(); expect(writes()[0].data).toEqual({ dueOffset: 0 });
});
test("sends only the explicitly changed priority", async () => {
  await mount(); await open(); fireEvent.click(within(editor()).getByRole("button", { name: "High" })); await save(); expect(writes()[0].data).toEqual({ priority: "HIGH" });
});
test("clears assignees with an explicit empty list", async () => {
  await mount(); await open(); await toggle("Assign", "Avery Lane"); await toggle("Assign", "Morgan Reed"); await save(); expect(writes()[0].data).toEqual({ assigneeIds: [] });
});
test("clears labels with an explicit empty list", async () => {
  await mount(); await open(); await toggle("Label", "Routine"); await toggle("Label", "Planning"); await save(); expect(writes()[0].data).toEqual({ labelIds: [] });
});
test("keeps changed assignee order rather than comparing as a set", async () => {
  await mount(); await open(); await toggle("Assign", "Avery Lane"); await toggle("Assign", "Avery Lane"); await save(); expect(writes()[0].data).toEqual({ assigneeIds: ["member-2", "member-1"] });
});
test("keeps changed label order rather than comparing as a set", async () => {
  await mount(); await open(); await toggle("Label", "Routine"); await toggle("Label", "Routine"); await save(); expect(writes()[0].data).toEqual({ labelIds: ["label-2", "label-1"] });
});
test("preserves changed subtask title text and order while filtering blank rows", async () => {
  await mount(); await open(); removeSubtask(0); addSubtask(); change(screen.getByPlaceholderText("Subtask 2") as HTMLInputElement, " First "); addSubtask(); await save();
  expect(writes()[0].data).toEqual({ subtasks: [{ title: "Second" }, { title: " First " }] });
});
test("clears subtasks with an explicit empty replacement list", async () => {
  await mount(); await open(); removeSubtask(1); removeSubtask(0); await save();
  expect(writes()[0].data).toEqual({ subtasks: [] }); expect(rows()[0].subtasks).toEqual([]);
});
test("rejects a changed invalid subtask and permits a corrected retry", async () => {
  await mount(); await open(); change(screen.getByPlaceholderText("Subtask 1") as HTMLInputElement, "X".repeat(256)); await save();
  expect(writes()[0].status).toBe(400); expect(rows()[0].subtasks[0].title).toBe("First");
  change(screen.getByPlaceholderText("Subtask 1") as HTMLInputElement, "Corrected child"); await save();
  expect(writes()[1].data).toEqual({ subtasks: [{ title: "Corrected child" }, { title: "Second" }] });
  expect(writes()[1].status).toBe(200);
});
test("omits unchanged legacy subtasks when adding a blank row during an unrelated edit", async () => {
  await mount({ subtasks: [{ title: "S".repeat(256) }] }); await open(); addSubtask(); change(titleInput(), "Revised title"); await save();
  expect(writes()[0].data).toEqual({ title: "Revised title" }); expect(writes()[0].status).toBe(200);
  expect(rows()[0].subtasks).toEqual([{ title: "S".repeat(256) }]);
});
test("does not PATCH when only a blank subtask row is added", async () => {
  await mount({ subtasks: [{ title: "S".repeat(256) }] }); await open(); addSubtask(); await save();
  expect(writes()).toHaveLength(0); expect(maybeName()?.value).toBe("Template A");
});
test("preserves raw legacy blank and duplicate subtasks when only appending a blank draft", async () => {
  const legacy = [{ title: "" }, { title: " " }, { title: "S".repeat(256) }, { title: "" }];
  await mount({ subtasks: legacy }); await open(); addSubtask(); change(titleInput(), "Revised title"); await save();
  expect(writes()[0].data).toEqual({ title: "Revised title" }); expect(writes()[0].status).toBe(200);
  expect(rows()[0].subtasks).toEqual(legacy);
});
test("explicitly clears legacy blank subtasks with an empty replacement", async () => {
  await mount({ subtasks: [{ title: "" }, { title: " " }] }); await open(); removeSubtask(1); removeSubtask(0); await save();
  expect(writes()[0].data).toEqual({ subtasks: [] }); expect(writes()[0].status).toBe(200); expect(rows()[0].subtasks).toEqual([]);
});
test("does not PATCH a no-op or exact raw scalar list and subtask reverts", async () => {
  await mount(); await open(); change(titleInput(), "Temporary"); change(titleInput(), "Review the plan");
  await toggle("Assign", "Morgan Reed"); await toggle("Assign", "Morgan Reed"); addSubtask(); removeSubtask(2);
  await save(); expect(writes()).toHaveLength(0); expect(maybeName()?.value).toBe("Template A");
});
test("blocks explicitly blank required name and title without a request", async () => {
  await mount(); await open(); change(nameInput(), "  "); note("blank-name"); expect(saveButton().disabled).toBe(true);
  change(nameInput(), "Template A"); change(titleInput(), ""); note("blank-title"); expect(saveButton().disabled).toBe(true); expect(writes()).toHaveLength(0);
});
test("retains strict changed-invalid errors draft and cache", async () => {
  await mount(); await open(); change(dueInput(), "5001"); await save();
  expect(writes()[0].status).toBe(400); expect(dueInput().value).toBe("5001"); expect(rows()[0].dueOffset).toBe(3); expect(toast.error).toHaveBeenCalledWith("Due offset (days): " + writes()[0].details![0].message);
});
test("keeps the open draft on refetch and reloads it after Cancel and reopen", async () => {
  await mount(); await open(); change(nameInput(), "Local draft"); Object.assign(rows()[0], { name: "Server name", title: "Server title" });
  await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.templates("p") }); }); await quiet(); note("refetched-open");
  expect(nameInput().value).toBe("Local draft"); expect(titleInput().value).toBe("Review the plan"); cancel(); await open();
  expect(nameInput().value).toBe("Server name"); expect(titleInput().value).toBe("Server title"); expect(writes()).toHaveLength(0);
});
test("closes on canonical-equal success even when the query object is retained", async () => {
  await mount(); await open(); const original = queryClient.getQueryData(queryKeys.templates("p")); change(nameInput(), " Template A "); await save();
  expect(writes()).toHaveLength(1); expect(writes()[0].status).toBe(200); expect(maybeName()).toBeNull(); expect(queryClient.getQueryData(queryKeys.templates("p"))).toBe(original);
});
test("preserves same-session close on success after edits made while pending", async () => {
  await mount(); await open(); change(nameInput(), "Submitted name"); const call = await pending(); change(titleInput(), "Later unsent title"); note("late-same-session-edit"); await release(call);
  expect(maybeName()).toBeNull(); expect(rows()[0].name).toBe("Submitted name"); expect(rows()[0].title).toBe("Review the plan"); expect(writes()).toHaveLength(1);
});
test("retains a failed edit and retries only the changed field", async () => {
  await mount(); await open(); failNext = true; change(titleInput(), "Retry title"); await save("first-rejected");
  expect(titleInput().value).toBe("Retry title"); await save("retry-settled");
  expect(writes().map((call) => call.status)).toEqual([503, 200]); expect(writes().map((call) => call.data)).toEqual([{ title: "Retry title" }, { title: "Retry title" }]);
});
test("an older successful editor cannot close a newly opened editor in the same project", async () => {
  await mount(); await open(); change(nameInput(), "Submitted name"); const call = await pending(); cancel(); await open(1); change(titleInput(), "New editor draft"); await release(call);
  expect(maybeName()?.value).toBe("Template B"); expect(titleInput().value).toBe("New editor draft"); await save();
  expect(writes()[1].path).toBe("projects/p/templates/template-b"); expect(writes()[1].data).toEqual({ title: "New editor draft" });
});
test("an older project completion cannot close the new project editor", async () => {
  const view = await mount(); await open(); change(nameInput(), "Submitted name"); const call = await pending(); cancel();
  view.rerender(<Subject project="q" />); await waitFor(() => expect(pencilButtons()).toHaveLength(1)); await waitFor(() => expect(queryClient.isFetching()).toBe(0)); await open(); change(titleInput(), "Q draft"); await release(call);
  expect(maybeName()?.value).toBe("Project Q"); expect(titleInput().value).toBe("Q draft"); await save();
  expect(writes()[1].path).toBe("projects/q/templates/template-q"); expect(writes()[1].data).toEqual({ title: "Q draft" });
});
test("discards delayed old-account callbacks across A to B to A and permits fresh edits", async () => {
  const view = await mount(); await open(); change(nameInput(), "Old account submission"); const call = await pending(); const oldGeneration = call.generation;
  signIn("b"); signIn("a"); view.rerender(<Subject />); await quiet();
  await waitFor(() => expect(pencilButtons()).toHaveLength(2)); await open(); change(titleInput(), "Fresh account draft"); await release(call);
  expect(maybeName()).not.toBeNull(); expect(titleInput().value).toBe("Fresh account draft"); expect(toast.success).not.toHaveBeenCalled();
  await save(); expect(writes()).toHaveLength(2); expect(writes()[1].actor).toBe("a"); expect(writes()[1].generation).toBeGreaterThan(oldGeneration); expect(writes()[1].status).toBe(200);
});
test("keeps CREATE full payload and its successful and Cancel reset policies", async () => {
  await mount(); fireEvent.click(screen.getByRole("button", { name: "New template" })); change(nameInput(), " Plan "); change(titleInput(), " Task ");
  change(descriptionInput(), "Create notes"); change(dueInput(), "0"); fireEvent.click(within(editor()).getByRole("button", { name: "High" })); addSubtask(); change(screen.getByPlaceholderText("Subtask 1") as HTMLInputElement, " Created child "); addSubtask();
  fireEvent.click(screen.getByRole("button", { name: "Create template" })); await quiet(); note("create-settled");
  expect(writes()[0].method).toBe("POST"); expect(writes()[0].status).toBe(201);
  expect(writes()[0].data).toEqual({ name: "Plan", title: "Task", description: "Create notes", priority: "HIGH", dueOffset: 0, assigneeIds: [], labelIds: [], subtasks: [{ title: " Created child " }] });
  expect(writes()[0].objectKeys).toEqual(["assigneeIds", "description", "dueOffset", "labelIds", "name", "priority", "statusId", "subtasks", "title"]);
  fireEvent.click(screen.getByRole("button", { name: "New template" })); expect(nameInput().value).toBe(""); expect(titleInput().value).toBe(""); expect(dueInput().value).toBe("");
  change(nameInput(), "Discarded create draft"); cancel(); fireEvent.click(screen.getByRole("button", { name: "New template" })); note("create-cancel-reopen");
  expect(nameInput().value).toBe(""); expect(descriptionInput().value).toBe(""); expect(writes()).toHaveLength(1);
});


function createFields(description: string, name = "Text contract template") {
  fireEvent.click(screen.getByRole("button", { name: "New template" }));
  change(nameInput(), name); change(titleInput(), "Text contract task"); change(descriptionInput(), description);
}
async function createSave() { fireEvent.click(screen.getByRole("button", { name: "Create template" })); await quiet(); note("text-create-settled"); }

test("text contract: create normalizes only forbidden description controls", async () => {
  await mount(); createFields("First\tΩ\u000BSecond\u000CThird\u0000 end"); await createSave();
  expect(writes()[0].data?.description).toBe("First\tΩ\nSecond\nThird end"); expect(writes()[0].status).toBe(201);
  expect(writes()[0].data).toMatchObject({ name: "Text contract template", title: "Text contract task", assigneeIds: [], labelIds: [], subtasks: [] });
});
test("text contract: edit normalizes a changed description with sparse payload", async () => {
  await mount({ name: "N".repeat(256) }); await open(); change(descriptionInput(), "Changed\u0001 text\u000Bline\tΩ"); await save();
  expect(writes()[0].data).toEqual({ description: "Changed text\nline\tΩ" }); expect(writes()[0].status).toBe(200); expect(rows()[0].name).toHaveLength(256);
});
test("text contract: controls-only create description keeps optional omission", async () => {
  await mount(); createFields("\u0000\u0001"); await createSave(); expect(writes()[0].data).not.toHaveProperty("description"); expect(writes()[0].status).toBe(201);
});
test("text contract: changed controls-only description sends explicit null", async () => {
  await mount(); await open(); change(descriptionInput(), "\u0000\u0001"); await save(); expect(writes()[0].data).toEqual({ description: null }); expect(writes()[0].status).toBe(200);
});
test("text contract: unrelated edit omits unchanged legacy-invalid description", async () => {
  const legacy = "Legacy\u0000 &amp; <b>text</b>"; await mount({ description: legacy }); await open();
  expect(descriptionInput().value).toBe("Legacy\u0000 & <b>text</b>");
  change(titleInput(), "Other field"); await save();
  expect(writes()[0].data).toEqual({ title: "Other field" }); expect(writes()[0].status).toBe(200); expect(rows()[0].description).toBe(legacy);
});
test("text contract: one display decode is not resent and does not accumulate", async () => {
  rows("a")[0].description = "Notes &amp; follow-up";
  rows("a")[1].description = "Fish &amp;amp; chips";
  await mount(); await open(0);
  expect(descriptionInput().value).toBe("Notes & follow-up");
  change(titleInput(), "Other field"); await save();
  expect(writes()[0].data).toEqual({ title: "Other field" });
  expect(rows()[0].description).toBe("Notes &amp; follow-up");
  await open(0);
  expect(descriptionInput().value).toBe("Notes & follow-up");
  cancel(); await open(1);
  expect(descriptionInput().value).toBe("Fish &amp; chips");
  change(titleInput(), "Second field"); await save();
  expect(writes()[1].data).toEqual({ title: "Second field" });
  expect(rows()[1].description).toBe("Fish &amp;amp; chips");
});
test("text contract: editing other words keeps escaped brackets and quotes", async () => {
  const stored = "Fish &amp; chips Use &lt;div&gt; <b>bold</b> say &quot;hi&quot; end";
  await mount({ description: stored }); await open();
  expect(descriptionInput().value).toBe("Fish & chips Use <div> <b>bold</b> say \"hi\" end");
  change(titleInput(), "Other field"); await save();
  expect(writes()[0].data).toEqual({ title: "Other field" });
  expect(rows()[0].description).toBe(stored);
  await open();
  change(descriptionInput(), "Fish & chips today Use <div> <b>bold</b> say \"hi\" fin"); await save();
  expect(writes()[1].data).toEqual({
    description: "Fish & chips today Use &lt;div&gt; <b>bold</b> say &quot;hi&quot; fin",
  });
});
test("text contract: long edits on both ends keep an escaped code sample", async () => {
  const gap = "x".repeat(1001);
  const stored = "A&lt;div&gt;" + gap + "Z";
  await mount({ description: stored }); await open();
  expect(descriptionInput().value).toBe("A<div>" + gap + "Z");
  change(descriptionInput(), "B<div>" + gap + "Y"); await save();
  expect(writes()[0].data).toEqual({ description: "B&lt;div&gt;" + gap + "Y" });
});
test("text contract: a new tag does not steal a code sample's stored spelling", async () => {
  await mount({ description: "Use &lt;div&gt; end" }); await open();
  change(descriptionInput(), "Use <b><div> end"); await save();
  expect(writes()[0].data).toEqual({ description: "Use <b>&lt;div&gt; end" });
});
test("text contract: editing inside a code sample keeps its brackets escaped", async () => {
  await mount({ description: "Use &lt;div&gt; end" }); await open();
  change(descriptionInput(), "Use <span> end"); await save();
  expect(writes()[0].data).toEqual({ description: "Use &lt;span&gt; end" });
});
test("text contract: a long insertion before a code sample keeps its spelling", async () => {
  const inserted = "n".repeat(4001);
  await mount({ description: "Keep &lt;div&gt; tail" }); await open();
  change(descriptionInput(), inserted + "Keep <div> tail"); await save();
  expect(writes()[0].data).toEqual({ description: inserted + "Keep &lt;div&gt; tail" });
});
test("text contract: a duplicated code sample keeps both copies escaped", async () => {
  await mount({ description: "Use &lt;div&gt; end" }); await open();
  change(descriptionInput(), "Use <div> endUse <div> end"); await save();
  expect(writes()[0].data).toEqual({ description: "Use &lt;div&gt; endUse &lt;div&gt; end" });
});
test("text contract: many escaped samples do not escape real formatting tags", async () => {
  const items = Array.from({ length: 251 }, () => "&lt;item&gt;").join(" ");
  const stored = "<p>Intro " + items + " end</p>";
  await mount({ description: stored }); await open();
  expect(descriptionInput().value.startsWith("<p>Intro ")).toBe(true);
  expect(descriptionInput().value.endsWith(" end</p>")).toBe(true);
  change(descriptionInput(), descriptionInput().value.replace("Intro", "Opening")); await save();
  const sent = writes()[0].data?.description as string;
  expect(sent.startsWith("<p>Opening ")).toBe(true);
  expect(sent.endsWith(" end</p>")).toBe(true);
  expect(sent).toContain("&lt;item&gt;");
  expect(sent).not.toContain("<item>");
});
test("text contract: replacing a long description without entities sends the new text", async () => {
  await mount({ description: "a".repeat(5000) }); await open();
  const next = "b".repeat(5000);
  change(descriptionInput(), next); await save();
  expect(writes()[0].data).toEqual({ description: next });
});
test("text contract: description display decodes sanitizer entities once without parsing tags", async () => {
  const stored = "A &lt; B &gt; C &quot;q&quot; it's &amp;lt; <b>keep</b>\u0000";
  await mount({ description: stored }); await open();
  expect(descriptionInput().value).toBe("A < B > C \"q\" it's &lt; <b>keep</b>\u0000");
  change(titleInput(), "Other field"); await save();
  expect(writes()[0].data).toEqual({ title: "Other field" });
  expect(rows()[0].description).toBe(stored);
});
test("text contract: allowed markup entities tabs Unicode and newlines stay verbatim", async () => {
  const allowed = "<p>Résumé &amp; &lt;copy&gt;\tΩ\nnext line</p>"; await mount(); createFields(allowed); await createSave();
  expect(writes()[0].data?.description).toBe(allowed); expect(writes()[0].status).toBe(201); await open(); change(descriptionInput(), allowed); await save();
  expect(writes()[1].data).toEqual({ description: allowed }); expect(writes()[1].status).toBe(200);
});
test("text contract: raw change normalizing to initial value remains an explicit save", async () => {
  await mount({ description: "Same value" }); await open(); change(descriptionInput(), "Same value\u0000"); await save();
  expect(writes()[0].data).toEqual({ description: "Same value" }); expect(writes()[0].status).toBe(200); expect(maybeName()).toBeNull();
});
test("text contract: exact raw description revert remains a no-op", async () => {
  const legacy = "Keep\u0000 raw"; await mount({ description: legacy }); await open(); change(descriptionInput(), "Temporary"); change(descriptionInput(), legacy); await save();
  expect(writes()).toHaveLength(0); expect(descriptionInput().value).toBe(legacy);
});
test("text contract: create reports a strict field error once and retains draft", async () => {
  await mount(); const invalid = "N".repeat(256); createFields("Valid notes", invalid); await createSave();
  expect(writes()[0].status).toBe(400); expect(nameInput().value).toBe(invalid); expect(toast.error).toHaveBeenCalledExactlyOnceWith("Template name: " + writes()[0].details![0].message);
});
test("text contract: update reports a strict field error once without changing cache", async () => {
  await mount(); await open(); change(dueInput(), "5001"); await save(); expect(writes()[0].status).toBe(400); expect(dueInput().value).toBe("5001"); expect(rows()[0].dueOffset).toBe(3);
  expect(toast.error).toHaveBeenCalledExactlyOnceWith("Due offset (days): " + writes()[0].details![0].message);
});
test("text contract: meaningful server message is used without field details", async () => {
  await mount(); await open(); failNext = true; change(descriptionInput(), "Retry notes"); await save(); expect(writes()[0].status).toBe(503); expect(descriptionInput().value).toBe("Retry notes");
  expect(toast.error).toHaveBeenCalledExactlyOnceWith("Owned save unavailable");
});
test("text contract: unknown error keeps operation fallback and draft", async () => {
  await mount(); await open(); ordinaryFailure = {}; change(descriptionInput(), "Unsent notes"); await save(); expect(writes()[0].status).toBe(503); expect(descriptionInput().value).toBe("Unsent notes");
  expect(toast.error).toHaveBeenCalledExactlyOnceWith("Failed to update template");
});

test("text contract: whitespace-only descriptions are not trimmed", async () => {
  const whitespace = " \t\n "; await mount(); createFields(whitespace); await createSave(); expect(writes()[0].data?.description).toBe(whitespace); expect(writes()[0].status).toBe(201);
  await open(); change(descriptionInput(), whitespace); await save(); expect(writes()[1].data).toEqual({ description: whitespace }); expect(writes()[1].status).toBe(200);
});
