import { appendFile } from "node:fs/promises";
import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { UpdateUserSchema } from "@pm/shared";
import { toast } from "sonner";
import { ApiError } from "@/lib/api-error";
import { identityGeneration } from "@/lib/identity";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth-store";
import { ProfileSettings } from "./profile-settings";

const transport = vi.hoisted(() => {
  vi.stubGlobal("BroadcastChannel", class {
    addEventListener() {}
    removeEventListener() {}
    postMessage() {}
    close() {}
  });
  return { get: vi.fn(), patch: vi.fn(), upload: vi.fn() };
});
vi.mock("@/lib/api-client", () => ({ api: { get: transport.get, patch: transport.patch } }));
vi.mock("@/lib/router", () => ({ router: { invalidate: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({ useParams: () => ({}) }));
vi.mock("@/features/uploads/api", () => ({
  useUploadFile: () => ({ mutate: transport.upload, isPending: false }),
}));
vi.mock("@/components/shared/user-avatar", () => ({ UserAvatar: () => <span>Avatar</span> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type Profile = NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>;
type Patch = Record<string, unknown>;
type PatchRecord = { path: string; json: Patch; owner: string; parsed?: boolean; status?: number };
let server: Profile;
let patches: PatchRecord[];
let unexpected: string[];
let observations: unknown[];
let rejectedOnce: boolean;
let layoutAction: (() => void) | null;
const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

function account(id = "profile-a", overrides: Partial<Profile> = {}): Profile {
  return {
    id, email: `${id}@example.test`, displayName: "Alice Example", avatarUrl: null,
    jobTitle: "Engineer", phone: "+1 555 0100", timezone: "Europe/Paris",
    emailVerified: true, ...overrides,
  };
}
function input(label: string) {
  return screen.getByLabelText(label) as HTMLInputElement;
}
function observe(tag: string) {
  const name = document.querySelector<HTMLInputElement>("#displayName");
  const saveButton = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Save Changes"));
  observations.push({ tag, owner: useAuthStore.getState().user?.id,
    generation: identityGeneration(), patches: structuredClone(patches),
    fields: name ? { displayName: name.value, required: name.required,
      jobTitle: document.querySelector<HTMLInputElement>("#jobTitle")?.value ?? null,
      phone: document.querySelector<HTMLInputElement>("#phone")?.value ?? null,
      saveDisabled: saveButton?.disabled ?? null } : null,
    mutations: queryClient.getMutationCache().getAll().map((mutation) => mutation.state.status),
    success: vi.mocked(toast.success).mock.calls.map(([message]) => message),
    error: vi.mocked(toast.error).mock.calls.map(([message]) => message),
  });
}
function LayoutObservation({ revision }: { revision: number }) {
  useLayoutEffect(() => { const action = layoutAction; layoutAction = null; action?.(); }, [revision]);
  return null;
}
function TestScreen({ revision = 0 }: { revision?: number }) {
  return <QueryClientProvider client={queryClient}>
    <ProfileSettings /><LayoutObservation revision={revision} />
  </QueryClientProvider>;
}
async function start(overrides: Partial<Profile> = {}) {
  server = account("profile-a", overrides);
  act(() => useAuthStore.setState({ user: structuredClone(server), accessToken: "local-fixture", workspaces: [] }));
  const view = render(<TestScreen />);
  await waitFor(() => expect(input("Display Name").value).toBe(server.displayName));
  await waitFor(() => expect((screen.getByRole("button", { name: "Save Changes" }) as HTMLButtonElement).disabled).toBe(false));
  observe("loaded");
  return view;
}
function change(label: string, value: string) {
  fireEvent.change(input(label), { target: { value } });
}
async function settle() {
  await act(async () => { await Promise.resolve(); });
  await waitFor(() => expect(queryClient.isMutating()).toBe(0));
}
async function save() {
  fireEvent.submit(input("Display Name").closest("form")!);
  await settle();
  observe("submitted");
}
async function chooseNone() {
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
  const none = await screen.findByRole("option", { name: "None" });
  fireEvent.keyDown(none, { key: "Enter" });
}
async function transient(view: ReturnType<typeof render>, next: Profile, identities: Profile[] = []) {
  let submitted = false;
  act(() => {
    for (const user of identities) useAuthStore.setState({ user: structuredClone(user), accessToken: "local-fixture" });
    server = structuredClone(next);
    queryClient.setQueryData(queryKeys.me, structuredClone(server));
    layoutAction = () => {
      observe("layout-before-profile-effect");
      const form = input("Display Name").closest("form")!;
      submitted = true;
      fireEvent.submit(form);
    };
    view.rerender(<TestScreen revision={1} />);
  });
  await settle();
  observe("after-profile-transition");
  expect(submitted).toBe(true);
}

beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
beforeEach(() => {
  queryClient.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  transport.get.mockReset(); transport.patch.mockReset(); transport.upload.mockReset();
  vi.mocked(toast.error).mockClear(); vi.mocked(toast.success).mockClear();
  patches = []; unexpected = []; observations = []; rejectedOnce = false; layoutAction = null;
  server = account();
  vi.stubGlobal("fetch", async () => { unexpected.push("real-fetch"); throw new Error("Unexpected real transport"); });
  transport.get.mockImplementation((path: string) => ({ json: async () => {
    if (path !== "users/me") { unexpected.push(`GET ${path}`); throw new Error("Unexpected GET"); }
    return { data: structuredClone(server) };
  } }));
  transport.patch.mockImplementation((path: string, options: { json: Patch }) => {
    const record: PatchRecord = { path, json: structuredClone(options.json), owner: server.id };
    patches.push(record);
    return { json: async () => {
      if (path !== "users/me") { unexpected.push(`PATCH ${path}`); throw new Error("Unexpected PATCH"); }
      const parsed = UpdateUserSchema.safeParse(options.json);
      record.parsed = parsed.success;
      if (!parsed.success) {
        record.status = 400;
        throw new ApiError(400, "Bad Request", "Validation failed",
          parsed.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })));
      }
      if (rejectedOnce) {
        rejectedOnce = false; record.status = 503;
        throw new ApiError(503, "Service Unavailable", "Please retry this save");
      }
      server = { ...server, ...parsed.data };
      record.status = 200;
      return { data: structuredClone(server) };
    } };
  });
});
afterEach(async () => {
  let settlingError: unknown;
  try { await settle(); } catch (error) { settlingError = error; }
  observe("final");
  const record = { name: expect.getState().currentTestName, observations,
    patches: structuredClone(patches), server: { ...server }, unexpected };
  if (process.env.PROFILE_PARTIAL_OBSERVATIONS) {
    await appendFile(process.env.PROFILE_PARTIAL_OBSERVATIONS, JSON.stringify(record) + "\n");
  }
  cleanup();
  await queryClient.cancelQueries(); queryClient.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  if (settlingError) throw settlingError;
  expect(unexpected).toEqual([]);
});
afterAll(() => {
  if (scrollDescriptor) Object.defineProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
  else delete (Element.prototype as Partial<Element>).scrollIntoView;
  vi.unstubAllGlobals();
});

it("sends only an explicitly changed display name with existing trimming", async () => {
  await start(); change("Display Name", "  New Name  "); await save();
  expect(patches.map((p) => p.json)).toEqual([{ displayName: "New Name" }]);
  expect(toast.success).toHaveBeenCalledWith("Profile updated");
});
it("omits an unchanged overlength job title while saving the phone", async () => {
  await start({ jobTitle: "j".repeat(101) }); change("Phone", "222"); await save();
  expect(patches.map((p) => p.json)).toEqual([{ phone: "222" }]);
  expect(patches[0].status).toBe(200); expect(server.jobTitle).toBe("j".repeat(101));
});
it("omits an unchanged overlength display name while saving job title", async () => {
  await start({ displayName: "n".repeat(101) }); change("Job Title", "Lead"); await save();
  expect(patches.map((p) => p.json)).toEqual([{ jobTitle: "Lead" }]);
  expect(patches[0].status).toBe(200); expect(server.displayName).toBe("n".repeat(101));
});
it("does not make an unchanged legacy blank name block a phone edit", async () => {
  await start({ displayName: "" }); change("Phone", "333");
  observe("before-native-submit");
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" })); await settle(); observe("native-submit-finished");
  expect(patches.map((p) => p.json)).toEqual([{ phone: "333" }]);
  expect(server.displayName).toBe("");
});
it("does not normalize an untouched optional field on an unrelated save", async () => {
  await start({ jobTitle: "  Original title  " }); change("Phone", "444"); await save();
  expect(patches.map((p) => p.json)).toEqual([{ phone: "444" }]);
  expect(server.jobTitle).toBe("  Original title  ");
});
it.each([["Job Title", "jobTitle"], ["Phone", "phone"]])("clears only changed %s with explicit null", async (label, key) => {
  await start(); change(label, "   "); await save();
  expect(patches.map((p) => p.json)).toEqual([{ [key]: null }]);
});
it("clears only timezone when None is selected", async () => {
  await start(); await chooseNone(); await save();
  expect(patches.map((p) => p.json)).toEqual([{ timezone: null }]);
});
it("creates no mutation for unchanged null optional fields", async () => {
  await start({ jobTitle: null, phone: null, timezone: null }); await save();
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  expect(patches).toEqual([]); expect(toast.success).not.toHaveBeenCalled();
});
it("creates no mutation after an edit is reverted to its raw original", async () => {
  await start(); change("Phone", "changed"); change("Phone", "+1 555 0100"); await save();
  expect(queryClient.getMutationCache().getAll()).toHaveLength(0); expect(patches).toEqual([]);
});
it("still rejects an explicitly changed invalid value with the existing visible error", async () => {
  await start(); change("Job Title", "x".repeat(101)); await save();
  expect(patches).toHaveLength(1); expect(patches[0].parsed).toBe(false); expect(patches[0].status).toBe(400);
  expect(toast.error).toHaveBeenCalledWith("Validation failed"); expect(toast.success).not.toHaveBeenCalled();
  expect(server.jobTitle).toBe("Engineer"); expect(input("Job Title").value).toBe("x".repeat(101));
});
it("still blocks an explicitly cleared display name in native and JS validation", async () => {
  await start(); change("Display Name", ""); observe("changed-name-validity");
  expect(input("Display Name").required).toBe(true); expect(input("Display Name").checkValidity()).toBe(false);
  await save(); expect(patches).toEqual([]); expect(toast.error).toHaveBeenCalledWith("Display name is required");
  expect(UpdateUserSchema.safeParse({ displayName: "" }).success).toBe(false);
});
it("keeps failed edits for retry and advances the comparison baseline only after success", async () => {
  await start(); change("Job Title", "Lead"); rejectedOnce = true; await save();
  expect(toast.error).toHaveBeenCalledWith("Please retry this save"); expect(input("Job Title").value).toBe("Lead");
  expect(server.jobTitle).toBe("Engineer"); await save();
  expect(patches[1].json).toEqual({ jobTitle: "Lead" }); expect(patches[1].status).toBe(200);
  change("Phone", "555"); await save(); expect(patches[2].json).toEqual({ phone: "555" });
});
it("preserves today's reset on same-user refetch and does not resend an older field", async () => {
  await start(); change("Phone", "unsaved"); server = { ...server, jobTitle: "Newer title", phone: "777" };
  await act(async () => { await queryClient.refetchQueries({ queryKey: queryKeys.me }); });
  await waitFor(() => expect(input("Phone").value).toBe("777")); observe("refetched");
  expect(patches).toEqual([]); change("Display Name", "New Name"); await save();
  expect(patches.map((p) => p.json)).toEqual([{ displayName: "New Name" }]); expect(server.jobTitle).toBe("Newer title");
});
it("refuses a same-user stale draft submit before the profile reset effect", async () => {
  const view = await start(); change("Phone", "unsaved");
  await transient(view, { ...server, jobTitle: "Newer title", phone: "888" });
  expect(patches).toEqual([]);
});
it("refuses another account's old draft before effects and allows the new account edit", async () => {
  const view = await start(); change("Phone", "old-account-draft"); const next = account("profile-b", { displayName: "Bob Example" });
  await transient(view, next, [next]); expect(patches).toEqual([]);
  await waitFor(() => expect(input("Display Name").value).toBe("Bob Example")); change("Phone", "999"); await save();
  expect(patches.map((p) => ({ owner: p.owner, json: p.json }))).toEqual([{ owner: "profile-b", json: { phone: "999" } }]);
});
it("keeps ordinary explicit edits of all four fields and normal encodings", async () => {
  await start(); change("Display Name", "  New Name  "); change("Job Title", "  Lead  "); change("Phone", "  123  "); await chooseNone(); await save();
  expect(patches.map((p) => p.json)).toEqual([{ displayName: "New Name", jobTitle: "Lead", phone: "123", timezone: null }]);
  expect(patches[0].status).toBe(200); expect(toast.success).toHaveBeenCalledWith("Profile updated");
});
it("refuses an old generation's draft after A to B to A and allows a fresh edit", async () => {
  const view = await start(); change("Phone", "old-generation-draft"); const before = identityGeneration();
  const next = account("profile-a", { displayName: "New A profile" });
  await transient(view, next, [account("profile-b"), next]);
  expect(identityGeneration()).toBeGreaterThan(before); expect(patches).toEqual([]);
  await waitFor(() => expect(input("Display Name").value).toBe("New A profile")); change("Phone", "1010"); await save();
  expect(patches.map((p) => p.json)).toEqual([{ phone: "1010" }]);
});
it("omits an unchanged overlength phone while saving a job title", async () => {
  await start({ phone: "1".repeat(31) }); change("Job Title", "Lead"); await save();
  expect(patches.map((p) => p.json)).toEqual([{ jobTitle: "Lead" }]); expect(server.phone).toBe("1".repeat(31));
});
it("omits an unchanged overlength timezone while saving the phone", async () => {
  await start({ timezone: "t".repeat(51) }); change("Phone", "1111"); await save();
  expect(patches.map((p) => p.json)).toEqual([{ phone: "1111" }]); expect(server.timezone).toBe("t".repeat(51));
});

it("advances the draft after a canonical-equal success without a second PATCH", async () => {
  await start();
  const loaded = queryClient.getQueryData(queryKeys.me);
  change("Job Title", " Engineer "); await save();
  observations.push({ tag: "canonical-equal-success", sameQueryObject: queryClient.getQueryData(queryKeys.me) === loaded,
    patchCount: patches.length, mutationCount: queryClient.getMutationCache().getAll().length });
  expect(patches.map((p) => p.json)).toEqual([{ jobTitle: "Engineer" }]);
  expect(patches[0].status).toBe(200); expect(server.jobTitle).toBe("Engineer");
  expect(queryClient.getQueryData(queryKeys.me)).toBe(loaded);
  const mutationCount = queryClient.getMutationCache().getAll().length;
  await save();
  expect(patches).toHaveLength(1);
  expect(queryClient.getMutationCache().getAll()).toHaveLength(mutationCount);
  expect(toast.success).toHaveBeenCalledTimes(1);
});
