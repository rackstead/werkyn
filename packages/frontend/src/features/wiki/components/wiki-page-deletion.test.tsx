import { type ReactNode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { RealtimeProvider } from "@/components/providers/realtime-provider";
import { useWikiRealtime } from "../hooks/use-wiki-realtime";
import { useUpdateWikiPage, wikiAutosaveKey } from "../api";
import { writeAlongsideAutosave } from "@/hooks/use-entity-autosave";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { FakeWebSocket } from "@/test/fake-websocket";
import { useAuthStore } from "@/stores/auth-store";
import * as autosaves from "@/hooks/use-entity-autosave";
import { ApiError } from "@/lib/api-error";
import { WikiPageView } from "./wiki-page-view";
import { WikiEditor } from "./lazy-wiki-editor";

const { http } = vi.hoisted(() => ({ http: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock("@/lib/api-client", () => ({ api: http }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() } }));
vi.mock("./wiki-editor", async () => {
  const React = await import("react");
  return { WikiEditor: ({ initialContent, recoveredContent, readOnly, onChange }: any) => {
    const [value, setValue] = React.useState(JSON.stringify(recoveredContent ?? initialContent));
    return <textarea aria-label="Page body" disabled={readOnly} value={value} onChange={(event) => {
      setValue(event.target.value); onChange([{ type: "paragraph", content: event.target.value }]);
    }} />;
  } };
});
vi.mock("./version-history-panel", () => ({ VersionHistoryPanel: () => null }));
vi.mock("./wiki-comments-panel", () => ({ WikiCommentsPanel: () => null }));
vi.mock("./share-page-dialog", () => ({ SharePageDialog: () => null }));

const originalAutosave = autosaves.useEntityAutosave;
let latest: ReturnType<typeof autosaves.useEntityAutosave<any>>;
let sequence = 0;
let id: string;
let pages: Map<string, any>;
let lockOwner: string | null;
let outside: ReturnType<typeof useUpdateWikiPage>;
let readOverride: ((pageId: string) => Promise<any> | undefined) | undefined;
let patchOverride: ((pageId: string, patch: any) => Promise<any> | undefined) | undefined;
const captured = new Map<string, ReturnType<typeof autosaves.useEntityAutosave<any>>>();
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const writes: { pageId: string; patch: any }[] = [];
const gets: string[] = [];
const paragraph = (text: string) => [{ type: "paragraph", content: text }];
function stored(pageId: string) {
  return { id: pageId, spaceId: "space", parentId: null, title: pageId, icon: null,
    revision: 1, content: paragraph("stored " + pageId), updatedAt: "2026-11-01" };
}
function Consumer({ children }: { children: ReactNode }) { useWikiRealtime("workspace"); outside = useUpdateWikiPage(); return children; }
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}><RealtimeProvider><Consumer>{children}</Consumer></RealtimeProvider></QueryClientProvider>;
}
function view(pageId = id) {
  return <WikiPageView pageId={pageId} workspaceId="workspace" onNavigatePage={() => {}} />;
}
async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function open() {
  const screen = render(view(), { wrapper }); await tick();
  act(() => FakeWebSocket.latest().accept()); await tick();
  expect((screen.getByLabelText("Page body") as HTMLTextAreaElement).disabled).toBe(false);
  return screen;
}
function send(pageId: string, workspaceId = "workspace", event = "wiki_page_deleted", spaceId = "space") {
  act(() => FakeWebSocket.latest().deliver({ event, workspaceId, data: { pageId, spaceId } }));
}
beforeAll(() => WikiEditor.preload());
beforeEach(() => {
  vi.useFakeTimers(); onlineManager.setOnline(true); FakeWebSocket.reset(); vi.stubGlobal("WebSocket", FakeWebSocket);
  id = `deletion-${++sequence}`; pages = new Map([[id, stored(id)]]); lockOwner = "author";
  writes.length = 0; gets.length = 0; captured.clear(); readOverride = undefined; patchOverride = undefined;
  useAuthStore.setState({ accessToken: "test-token", user: { id: "author", email: "author@example.test", displayName: "Author" } as any });
  vi.spyOn(autosaves, "useEntityAutosave").mockImplementation((...args: any[]) => {
    latest = (originalAutosave as any)(...args); captured.set(args[0], latest); return latest;
  });
  http.get.mockImplementation((url: string) => ({ json: async () => {
    const pageId = url.split("/")[2];
    if (url.endsWith("/breadcrumbs")) return { data: [] };
    if (url.endsWith("/lock")) return { data: lockOwner ? { id: `lock-${pageId}`, pageId, userId: lockOwner, user: { displayName: lockOwner } } : null };
    gets.push(pageId); const overridden = readOverride?.(pageId); if (overridden) return overridden;
    const page = pages.get(pageId);
    if (!page) throw new ApiError(404, "Not found", "Wiki page not found");
    return { data: structuredClone(page) };
  } }));
  http.patch.mockImplementation((url: string, options: any) => {
    if (url.endsWith("/heartbeat")) return Promise.resolve();
    return { json: async () => {
      const pageId = url.split("/")[2]; writes.push({ pageId, patch: options.json });
      const overridden = patchOverride?.(pageId, options.json); if (overridden) return overridden;
      const page = pages.get(pageId); if (!page) throw new ApiError(404, "Not found", "Wiki page not found");
      Object.assign(page, options.json, { revision: page.revision + 1 }); return { data: structuredClone(page) };
    } };
  });
  http.post.mockReturnValue({ json: async () => ({ data: {} }) }); http.delete.mockResolvedValue(undefined);
});
afterEach(async () => {
  // Public queue operations clear this fixture's fields before component cleanup.
  await act(async () => { for (const value of captured.values()) { value.park(); value.discardParked(); } });
  onlineManager.setOnline(true); cleanup(); await tick(); queryClient.clear();
  useAuthStore.setState({ accessToken: null, user: null });
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it("a remote leaf deletion retires cached open-page content", async () => {
  const screen = await open(); pages.delete(id); send(id); await tick();
  expect(screen.queryByText(/page (?:is )?(?:no longer available|not found)/i)).not.toBeNull();
  expect(screen.queryByLabelText("Page body")).toBeNull();
});
it("a deletion before debounce retains pending body without another PATCH", async () => {
  const screen = await open(); fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "my pending body" } });
  pages.delete(id); send(id); await tick(1000);
  expect(writes).toHaveLength(0);
  expect(latest.parked?.content).toEqual(paragraph("my pending body"));
});
it("an ancestor deletion verifies an open child even without breadcrumbs", async () => {
  const screen = await open(); pages.delete(id); send("ancestor"); await tick();
  expect(gets.filter((value) => value === id).length).toBeGreaterThan(1);
  expect(screen.queryByText(/page (?:is )?(?:no longer available|not found)/i)).not.toBeNull();
});
it("an unaffected same-space page saves its own pending edit once", async () => {
  const screen = await open(); fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "sibling draft" } });
  send("other-page"); await tick(1000);
  expect(writes).toEqual([{ pageId: id, patch: { content: paragraph("sibling draft"), expectedRevision: 1 } }]);
  expect(latest.parked).toBeUndefined();
});
it("another workspace cannot retire this page or interrupt its save", async () => {
  const screen = await open(); const count = gets.length;
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "workspace draft" } });
  send(id, "elsewhere"); await tick(1000);
  expect(writes).toHaveLength(1); expect(gets).toHaveLength(count);
  expect(screen.queryByText(/no longer available/i)).toBeNull();
});
it("a parked draft is retained on ordinary reopen and never automatically restored", async () => {
  const screen = await open(); fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "kept aside" } });
  lockOwner = null; act(() => queryClient.setQueryData(["wiki-lock", id], { data: null })); await tick();
  const other = `${id}-other`; pages.set(other, stored(other));
  screen.rerender(view(other)); await tick(); screen.rerender(view()); await tick(1000);
  expect(writes).toHaveLength(0); expect(latest.parked?.content).toEqual(paragraph("kept aside"));
  expect((screen.getByText("Restore changes") as HTMLButtonElement).disabled).toBe(true);
});


it("a long unaffected check resumes an expired debounce exactly once", async () => {
  const screen = await open(), check = deferred<any>();
  readOverride = (pageId) => pageId === id ? check.promise : undefined;
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "held live edit" } });
  send("sibling"); await tick(1200); expect(writes).toHaveLength(0);
  readOverride = undefined; check.resolve({ data: structuredClone(pages.get(id)) }); await tick(); await tick(1200);
  expect(writes).toHaveLength(1); expect(writes[0].patch.content).toEqual(paragraph("held live edit"));
  expect(latest.parked).toBeUndefined();
});

it.each(["success", "failure"] as const)("superseded ordinary read %s cannot clear a newer ancestor check", async (outcome) => {
  const screen = await open(), old = deferred<any>(); let first = true;
  readOverride = (pageId) => pageId === id && first ? (first = false, old.promise) : undefined;
  void queryClient.invalidateQueries({ queryKey: queryKeys.wikiPage(id), exact: true }); await tick();
  pages.delete(id); send("ancestor"); await tick();
  expect(screen.queryByText(/no longer available/i)).not.toBeNull();
  if (outcome === "success") old.resolve({ data: stored(id) });
  else old.reject(new ApiError(404, "Not found", "Old missing result"));
  await tick();
  expect(screen.queryByLabelText("Page body")).toBeNull();
  expect(screen.queryByText(/no longer available/i)).not.toBeNull();
});

it("a non-editor late ACK cannot recreate cache after retirement, GC and remount", async () => {
  const screen = await open(), response = deferred<any>();
  patchOverride = (pageId) => pageId === id ? response.promise : undefined;
  let revision: number | undefined;
  const operation = writeAlongsideAutosave(wikiAutosaveKey("author", id), async () => {
    const result = await outside.mutateAsync({ pageId: id, title: "outside rename" });
    revision = result.data.revision; return revision;
  });
  await tick(); pages.delete(id); send(id); await tick();
  const other = `${id}-other`; pages.set(other, stored(other)); screen.rerender(view(other)); await tick();
  queryClient.removeQueries({ queryKey: queryKeys.wikiPage(id), exact: true });
  screen.rerender(view()); await tick();
  const cancel = vi.spyOn(queryClient, "cancelQueries"), invalidate = vi.spyOn(queryClient, "invalidateQueries");
  response.resolve({ data: { ...stored(id), revision: 2, title: "outside rename" } });
  await operation; await tick();
  expect(revision).toBe(2);
  expect(queryClient.getQueryData<{ data: unknown }>(queryKeys.wikiPage(id))?.data).toBeNull();
  expect(cancel).not.toHaveBeenCalled(); expect(invalidate).not.toHaveBeenCalled();
  expect(screen.queryByText(/no longer available/i)).not.toBeNull();
});

it.each(["failure", "success"] as const)("terminal A/B %s stays fenced across A→B→A and a current 200", async (outcome) => {
  const screen = await open(), response = deferred<any>();
  patchOverride = (pageId) => pageId === id ? response.promise : undefined;
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "on-wire A" } }); await tick(801);
  const heading = screen.getByRole("heading", { level: 1 });
  fireEvent.input(heading, { target: { textContent: "newer title B" } });
  expect(writes).toHaveLength(1);
  pages.delete(id); send(id); await tick();
  const other = `${id}-other`; pages.set(other, stored(other)); screen.rerender(view(other)); await tick();
  pages.set(id, { ...stored(id), revision: 3 }); screen.rerender(view()); await tick(1000);
  expect(writes).toHaveLength(1); expect(screen.queryByText(/no longer available/i)).not.toBeNull();
  patchOverride = undefined;
  if (outcome === "failure") response.reject(new ApiError(404, "Not found", "Gone"));
  else response.resolve({ data: { ...stored(id), content: paragraph("on-wire A"), revision: 2 } });
  await tick(); await tick(1000);
  expect(writes).toHaveLength(1);
  expect(latest.parked?.title).toBe("newer title B");
  if (outcome === "failure") expect(latest.parked?.content).toEqual(paragraph("on-wire A"));
  else expect(latest.parked?.content).toBeUndefined();
  fireEvent.click(screen.getByText("Discard")); await tick();
  console.info("post-retirement", { outcome, disabled: (screen.getByLabelText("Page body") as HTMLTextAreaElement).disabled,
    canAcquire: !!screen.queryByText("Start Editing"), parked: latest.parked !== undefined, writes: writes.length });
  // The old lock was removed with the page. A newly available session must
  // acquire its editing lock before the legitimate new C control.
  fireEvent.click(screen.getByText("Start Editing")); await tick();
  expect((screen.getByLabelText("Page body") as HTMLTextAreaElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "new live C" } }); await tick(801);
  expect(writes).toHaveLength(2); expect(latest.parked).toBeUndefined();
  expect(writes[1].patch.content).toEqual(paragraph("new live C"));
});

it("terminal failure with no mounted owner retains the merged remainder for reopen", async () => {
  const screen = await open(), response = deferred<any>();
  patchOverride = () => response.promise;
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "A" } }); await tick(801);
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "B latest" } });
  pages.delete(id); send(id); await tick(); screen.unmount(); await tick();
  response.reject(new ApiError(404, "Not found", "Gone")); await tick(); patchOverride = undefined;
  render(view(), { wrapper }); await tick(1000);
  expect(writes).toHaveLength(1); expect(latest.parked?.content).toEqual(paragraph("B latest"));
});

it("a failed availability read is not deletion and an owned retry resumes live fields", async () => {
  const screen = await open();
  readOverride = () => Promise.reject(new ApiError(503, "Unavailable", "Try again"));
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "kept live" } });
  send("sibling"); await tick(1000);
  expect(screen.queryByText(/could not confirm/i)).not.toBeNull();
  expect(screen.queryByText(/no longer available/i)).toBeNull(); expect(writes).toHaveLength(0);
  readOverride = undefined; fireEvent.click(screen.getByText("Check again")); await tick(); await tick(1000);
  expect(writes).toHaveLength(1); expect(writes[0].patch.content).toEqual(paragraph("kept live"));
});


it("space deletion verifies and retires an open descendant", async () => {
  const screen = await open(); pages.delete(id); send("", "workspace", "wiki_space_deleted"); await tick();
  expect(screen.queryByText(/no longer available/i)).not.toBeNull(); expect(writes).toHaveLength(0);
});

it("a page moved out of a deleted ancestor remains available after its current read", async () => {
  const screen = await open(); pages.get(id).spaceId = "moved-space";
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "moved edit" } });
  send("ancestor"); await tick(1000);
  expect(writes).toHaveLength(1); expect(latest.parked).toBeUndefined();
  expect(screen.queryByText(/no longer available/i)).toBeNull();
});

it("another known space and malformed page deletion do not pause this editor", async () => {
  const screen = await open(), count = gets.length;
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "unrelated events" } });
  send("other-page", "workspace", "wiki_page_deleted", "other-space"); send(""); await tick(1000);
  expect(writes).toHaveLength(1); expect(gets).toHaveLength(count); expect(latest.parked).toBeUndefined();
});

it("lock loss during a long check parks live edits instead of resuming them", async () => {
  const screen = await open(), check = deferred<any>(); readOverride = () => check.promise;
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "lost lock draft" } });
  send("sibling"); await tick(1000);
  lockOwner = null; act(() => queryClient.setQueryData(["wiki-lock", id], { data: null })); await tick();
  readOverride = undefined; check.resolve({ data: pages.get(id) }); await tick(1000);
  expect(writes).toHaveLength(0); expect(latest.parked?.content).toEqual(paragraph("lost lock draft"));
});

it("an unaffected 200 joins A before resuming pending B once on A's acknowledged revision", async () => {
  const screen = await open(), response = deferred<any>(); let first = true;
  patchOverride = () => first ? (first = false, response.promise) : undefined;
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "A" } }); await tick(801);
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "B" } });
  send("sibling"); await tick(1000); expect(writes).toHaveLength(1);
  const saved = { ...stored(id), revision: 2, content: paragraph("A") }; pages.set(id, saved);
  response.resolve({ data: saved }); await tick(1000);
  expect(writes).toHaveLength(2); expect(writes[1].patch).toEqual({ content: paragraph("B"), expectedRevision: 2 });
});

it("an older check finishing after a newer 200 cannot flush the live edit twice", async () => {
  const screen = await open(), firstCheck = deferred<any>(); let first = true;
  readOverride = () => first ? (first = false, firstCheck.promise) : undefined;
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "one live edit" } });
  send("sibling-one"); await tick(1000); send("sibling-two"); await tick();
  firstCheck.resolve({ data: stored(id) }); await tick(1000);
  expect(writes).toHaveLength(1); expect(latest.parked).toBeUndefined();
});


it("a paused editor mutation checks availability before its actual dispatch", async () => {
  const screen = await open(); onlineManager.setOnline(false);
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "offline queued" } }); await tick(801);
  expect(writes).toHaveLength(0); pages.delete(id); send(id); await tick();
  onlineManager.setOnline(true); await tick(1000);
  expect(writes).toHaveLength(0); expect(latest.parked?.content).toEqual(paragraph("offline queued"));
});

it("a prior parked conflict stays parked after an unaffected check", async () => {
  const screen = await open();
  patchOverride = () => Promise.reject(Object.assign(new ApiError(409, "Conflict", "Changed"), {
    code: "REVISION_CONFLICT", current: { revision: 2, updatedAt: "2026-11-01" },
  }));
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "conflicting draft" } }); await tick(801);
  expect(latest.parked?.content).toEqual(paragraph("conflicting draft"));
  patchOverride = undefined; pages.get(id).revision = 2; send("sibling"); await tick(1500);
  expect(writes).toHaveLength(1); expect(latest.conflict).not.toBeNull();
  expect(latest.parked?.content).toEqual(paragraph("conflicting draft"));
});

it("resuming live C leaves an older nonconflicting parked B untouched", async () => {
  const screen = await open(); fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "parked B" } });
  lockOwner = null; act(() => queryClient.setQueryData(["wiki-lock", id], { data: null })); await tick();
  expect(latest.parked?.content).toEqual(paragraph("parked B")); lockOwner = "author";
  fireEvent.click(screen.getByText("Start Editing")); await tick();
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "live C" } }); send("sibling"); await tick(1200);
  expect(writes).toHaveLength(1); expect(writes[0].patch.content).toEqual(paragraph("live C"));
  expect(latest.parked?.content).toEqual(paragraph("parked B"));
});

it("a resumed network failure is attempted only once by that resume job", async () => {
  const screen = await open(); patchOverride = () => Promise.reject(new TypeError("Offline"));
  fireEvent.change(screen.getByLabelText("Page body"), { target: { value: "one attempt" } }); send("sibling"); await tick(5000);
  expect(writes).toHaveLength(1); expect(latest.status).toBe("error");
});

it("a lock acquisition that finishes after deletion cannot re-enable editing or renewal", async () => {
  lockOwner = null;
  const screen = render(view(), { wrapper }); await tick(); act(() => FakeWebSocket.latest().accept()); await tick();
  const acquisition = deferred<any>(); http.post.mockReturnValue({ json: () => acquisition.promise });
  fireEvent.click(screen.getByText("Start Editing")); await tick(); pages.delete(id); send(id); await tick();
  acquisition.resolve({ data: { id: "late-lock", pageId: id, userId: "author" } }); await tick(60_001);
  expect(screen.queryByText(/no longer available/i)).not.toBeNull(); expect(screen.queryByText("Done Editing")).toBeNull();
  expect(http.patch.mock.calls.filter(([url]) => url.endsWith("/heartbeat"))).toHaveLength(0);
});
