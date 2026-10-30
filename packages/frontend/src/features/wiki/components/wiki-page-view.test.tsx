import { type ReactNode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as wiki from "../api";
import { WikiPageView } from "./wiki-page-view";
import { wikiAutosaveKey } from "../api";
import { writeAlongsideAutosave } from "@/hooks/use-entity-autosave";
import { PendingEditsError } from "@/lib/autosave-queue";
import { useAuthStore } from "@/stores/auth-store";

const { http, notices } = vi.hoisted(() => ({
  http: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() },
  notices: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("@/lib/api-client", () => ({ api: http }));
vi.mock("sonner", () => ({ toast: notices }));
vi.mock("./wiki-editor", async () => {
  const React = await import("react");
  return {
    WikiEditor: ({
      initialContent,
      recoveredContent,
      onChange,
      readOnly,
      hasUnsavedChanges,
    }: any) => {
      const [value, setValue] = React.useState(
        JSON.stringify(recoveredContent ?? initialContent),
      );
      return (
        <textarea
          aria-label="Page body"
          data-dirty={String(hasUnsavedChanges)}
          disabled={readOnly}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            onChange([{ type: "paragraph", content: event.target.value }]);
          }}
        />
      );
    },
  };
});
vi.mock("./version-history-panel", () => ({
  VersionHistoryPanel: () => <div>History panel</div>,
}));
vi.mock("./wiki-comments-panel", () => ({ WikiCommentsPanel: () => null }));
vi.mock("./share-page-dialog", () => ({ SharePageDialog: () => null }));

let client: QueryClient;
let nextPatch: (() => Promise<unknown>) | undefined;
let suffix = 0;
let pages: Map<string, any>;
const written: { path: string; body: unknown }[] = [];

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
function page(id: string) {
  if (!pages.has(id))
    pages.set(id, {
      id,
      title: id,
      content: [{ type: "paragraph", content: id }],
      spaceId: "space",
      updatedAt: "2026-10-27",
      icon: null,
    });
  return pages.get(id);
}
function view(id: string) {
  return (
    <WikiPageView
      pageId={id}
      workspaceId="workspace"
      onNavigatePage={() => {}}
    />
  );
}
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  written.length = 0;
  nextPatch = undefined;
  pages = new Map();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  useAuthStore.setState({
    user: {
      id: "editor-user",
      email: "editor@example.test",
      displayName: "Editor",
      avatarUrl: null,
      phone: null,
      jobTitle: null,
      timezone: null,
      emailVerified: true,
    },
  });
  vi.spyOn(wiki, "useWikiPage").mockImplementation(
    (id) => ({ data: { data: page(id!) }, isLoading: false }) as any,
  );
  vi.spyOn(wiki, "useWikiPageBreadcrumbs").mockReturnValue({
    data: { data: [] },
  } as any);
  vi.spyOn(wiki, "useWikiPageLock").mockImplementation(
    (id) =>
      ({
        data: {
          data: {
            id: `lock-${id}`,
            pageId: id,
            userId: "editor-user",
            user: { displayName: "Editor" },
          },
        },
        refetch: vi.fn(),
      }) as any,
  );
  http.patch.mockImplementation(
    (path: string, options: { json: Record<string, unknown> }) =>
      path.endsWith("/heartbeat")
        ? Promise.resolve(undefined)
        : {
            json: async () => {
              written.push({ path, body: options.json });
              if (nextPatch) return nextPatch();
              const id = path.split("/").pop()!;
              return { data: { ...page(id), ...options.json } };
            },
          },
  );
  http.delete.mockResolvedValue(undefined);
  http.post.mockReturnValue({ json: async () => ({ data: {} }) });
});
afterEach(async () => {
  cleanup();
  await tick();
  client.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("entity-bound Wiki autosave", () => {
  it("flushes page A to A before a debounce expires when the view becomes page B", async () => {
    const a = `page-a-${++suffix}`,
      b = `page-b-${suffix}`;
    const screen = render(view(a), { wrapper });
    fireEvent.change(screen.getByLabelText("Page body"), {
      target: { value: "A draft" },
    });
    screen.rerender(view(b));
    await tick();
    expect(written).toEqual([
      {
        path: `wiki/pages/${a}`,
        body: { content: [{ type: "paragraph", content: "A draft" }] },
      },
    ]);
    expect(http.delete).toHaveBeenCalledWith(`wiki/pages/${a}/lock`, {
      context: { expectedUserId: "editor-user" },
    });
    expect(http.delete.mock.calls.map(([url]) => url)).not.toContain(
      `wiki/pages/${b}/lock`,
    );
    await tick(801);
    expect(written).toHaveLength(1);
    expect(
      (screen.getByLabelText("Page body") as HTMLTextAreaElement).value,
    ).toContain(b);
  });

  it("Done Editing waits for persistence and only then releases that page lock", async () => {
    const id = `done-${++suffix}`,
      request = deferred<unknown>();
    nextPatch = () => request.promise;
    const screen = render(view(id), { wrapper });
    fireEvent.change(screen.getByLabelText("Page body"), {
      target: { value: "final text" },
    });
    fireEvent.click(screen.getByText("Done Editing"));
    await tick();
    expect(written).toHaveLength(1);
    expect(http.delete).not.toHaveBeenCalled();
    expect(
      (screen.getByLabelText("Page body") as HTMLTextAreaElement).disabled,
    ).toBe(true);
    await act(async () => {
      request.resolve({ data: page(id) });
    });
    await tick();
    expect(http.delete).toHaveBeenCalledWith(`wiki/pages/${id}/lock`, {
      context: { expectedUserId: "editor-user" },
    });
  });

  it("serializes successive patches so slow old writes cannot finish after newer text", async () => {
    const id = `ordered-${++suffix}`,
      first = deferred<unknown>();
    let requestCount = 0;
    nextPatch = () =>
      ++requestCount === 1
        ? first.promise
        : Promise.resolve({ data: page(id) });
    const screen = render(view(id), { wrapper });
    fireEvent.change(screen.getByLabelText("Page body"), {
      target: { value: "older text" },
    });
    await tick(801);
    fireEvent.change(screen.getByLabelText("Page body"), {
      target: { value: "newest text" },
    });
    await tick(801);
    expect(written).toHaveLength(1);
    await act(async () => {
      first.resolve({ data: page(id) });
    });
    await tick();
    expect(written).toEqual([
      {
        path: `wiki/pages/${id}`,
        body: { content: [{ type: "paragraph", content: "older text" }] },
      },
      {
        path: `wiki/pages/${id}`,
        body: { content: [{ type: "paragraph", content: "newest text" }] },
      },
    ]);
  });

  it("retains a failed final draft, keeps the lock, and retries before releasing", async () => {
    const id = `failed-${++suffix}`;
    nextPatch = () => Promise.reject(new Error("Offline"));
    const screen = render(view(id), { wrapper });
    fireEvent.change(screen.getByLabelText("Page body"), {
      target: { value: "keep this text" },
    });
    fireEvent.click(screen.getByText("Done Editing"));
    await tick();
    expect(screen.getByRole("alert").textContent).toContain(
      "Changes not saved",
    );
    expect(http.delete).not.toHaveBeenCalled();
    expect(notices.error).toHaveBeenCalled();
    const unloading = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unloading);
    expect(unloading.defaultPrevented).toBe(true);
    nextPatch = undefined;
    fireEvent.click(screen.getByText("Done Editing"));
    await tick();
    expect(written).toHaveLength(2);
    expect(written[1]).toEqual(written[0]);
    expect(http.delete).toHaveBeenCalledWith(`wiki/pages/${id}/lock`, {
      context: { expectedUserId: "editor-user" },
    });
  });

  it("flushes immediately on close and can recover a failed closed draft on reopen", async () => {
    const id = `reopen-${++suffix}`;
    nextPatch = () => Promise.reject(new Error("Offline"));
    const screen = render(view(id), { wrapper });
    fireEvent.change(screen.getByLabelText("Page body"), {
      target: { value: "closed draft" },
    });
    screen.unmount();
    await tick();
    expect(written).toHaveLength(1);
    expect(http.delete).not.toHaveBeenCalled();
    const reopened = render(view(id), { wrapper });
    await tick();
    // Reopening shows the stored page and offers the draft instead of resending it.
    expect(
      (reopened.getByLabelText("Page body") as HTMLTextAreaElement).value,
    ).not.toContain("closed draft");
    expect(written).toHaveLength(1);
    nextPatch = undefined;
    fireEvent.click(reopened.getByText("Restore changes"));
    await tick();
    expect(written[1]).toEqual(written[0]);
    expect(
      (reopened.getByLabelText("Page body") as HTMLTextAreaElement).value,
    ).toContain("closed draft");
  });

  it("queues title input before blur so navigation cannot silently drop it", async () => {
    const id = `title-${++suffix}`;
    const screen = render(view(id), { wrapper });
    const heading = screen.getByRole("heading");
    heading.textContent = "New title before blur";
    fireEvent.input(heading);
    fireEvent.click(screen.getByText("Done Editing"));
    await tick();
    expect(written).toEqual([
      { path: `wiki/pages/${id}`, body: { title: "New title before blur" } },
    ]);
  });

  it("never retries a previous account's draft or releases its lock as a new account", async () => {
    const id = `identity-${++suffix}`;
    const screen = render(view(id), { wrapper });
    fireEvent.change(screen.getByLabelText("Page body"), {
      target: { value: "Alice private draft" },
    });
    act(() => {
      useAuthStore.setState({
        user: { ...useAuthStore.getState().user!, id: "bob" },
      });
    });
    await tick();
    expect(written).toHaveLength(0);
    expect(http.delete).not.toHaveBeenCalled();
    expect(
      (screen.getByLabelText("Page body") as HTMLTextAreaElement).value,
    ).not.toContain("Alice private draft");
    // Alice's notice is not left on screen (or retryable) for Bob.
    expect(notices.dismiss).toHaveBeenCalledWith(
      `autosave:wiki:editor-user:${id}`,
    );
    expect(
      notices.error.mock.calls.filter(([, options]) => options?.action),
    ).toHaveLength(0);
    act(() => {
      useAuthStore.setState({
        user: { ...useAuthStore.getState().user!, id: "editor-user" },
      });
    });
    await tick();
    expect(written).toHaveLength(0);
    fireEvent.click(screen.getByText("Restore changes"));
    await tick();
    expect(written[0].path).toBe(`wiki/pages/${id}`);
    expect(JSON.stringify(written[0].body)).toContain("Alice private draft");
  });

  it("renews an already-held page lock on reopen and stops renewing after close", async () => {
    const id = `heartbeat-${++suffix}`;
    const screen = render(view(id), { wrapper });
    await tick();
    expect(
      http.patch.mock.calls.filter(
        ([url]) => url === `wiki/pages/${id}/lock/heartbeat`,
      ),
    ).toHaveLength(1);
    await tick(30_001);
    expect(
      http.patch.mock.calls.filter(
        ([url]) => url === `wiki/pages/${id}/lock/heartbeat`,
      ),
    ).toHaveLength(2);
    screen.unmount();
    await tick();
    await tick(30_001);
    expect(
      http.patch.mock.calls.filter(
        ([url]) => url === `wiki/pages/${id}/lock/heartbeat`,
      ),
    ).toHaveLength(2);
  });

  it("effect replay never releases the live page's lock or stops its new heartbeat", async () => {
    const id = `replay-${++suffix}`;
    const screen = render(view(id), { wrapper, reactStrictMode: true });
    await tick();
    expect(http.delete).not.toHaveBeenCalled();
    const renewals = http.patch.mock.calls.filter(
      ([url]) => url === `wiki/pages/${id}/lock/heartbeat`,
    ).length;
    await tick(30_001);
    expect(
      http.patch.mock.calls.filter(
        ([url]) => url === `wiki/pages/${id}/lock/heartbeat`,
      ),
    ).toHaveLength(renewals + 1);
    screen.unmount();
    await tick();
    expect(http.delete).toHaveBeenCalledTimes(1);
    expect(http.delete.mock.calls[0][0]).toBe(`wiki/pages/${id}/lock`);
  });

  it("rapid A→B→A keeps the newly mounted A lock after the old A save completes", async () => {
    const a = `return-a-${++suffix}`,
      b = `return-b-${suffix}`,
      saving = deferred<unknown>();
    nextPatch = () => saving.promise;
    const screen = render(view(a), { wrapper });
    fireEvent.change(screen.getByLabelText("Page body"), {
      target: { value: "A pending" },
    });
    screen.rerender(view(b));
    await tick();
    screen.rerender(view(a));
    await tick();
    await act(async () => {
      saving.resolve({ data: page(a) });
    });
    await tick();
    expect(http.delete.mock.calls.map(([url]) => url)).not.toContain(
      `wiki/pages/${a}/lock`,
    );
    const renewals = http.patch.mock.calls.filter(
      ([url]) => url === `wiki/pages/${a}/lock/heartbeat`,
    ).length;
    await tick(30_001);
    expect(
      http.patch.mock.calls.filter(
        ([url]) => url === `wiki/pages/${a}/lock/heartbeat`,
      ),
    ).toHaveLength(renewals + 1);
  });

  it("only the latest retired A lifetime releases after A→B→A→B while saving", async () => {
    const a = `retired-a-${++suffix}`,
      b = `retired-b-${suffix}`,
      saving = deferred<unknown>();
    nextPatch = () => saving.promise;
    const screen = render(view(a), { wrapper });
    fireEvent.change(screen.getByLabelText("Page body"), {
      target: { value: "A final queued text" },
    });
    screen.rerender(view(b));
    await tick();
    screen.rerender(view(a));
    await tick();
    screen.rerender(view(b));
    await tick();
    await act(async () => {
      saving.resolve({ data: page(a) });
    });
    await tick();
    expect(
      http.delete.mock.calls.filter(([url]) => url === `wiki/pages/${a}/lock`),
    ).toHaveLength(1);
  });

  it("an acquisition completing after A remounts never releases the new A lifetime's lock", async () => {
    const a = `acquire-a-${++suffix}`,
      b = `acquire-b-${suffix}`,
      acquiring = deferred<unknown>();
    let held = false;
    vi.mocked(wiki.useWikiPageLock).mockImplementation(
      (id) =>
        ({
          data: {
            data: held
              ? {
                  pageId: id,
                  userId: "editor-user",
                  user: { displayName: "Editor" },
                }
              : null,
          },
          refetch: vi.fn(),
        }) as any,
    );
    http.post.mockReturnValue({ json: () => acquiring.promise });
    const screen = render(view(a), { wrapper });
    fireEvent.click(screen.getByText("Start Editing"));
    await tick();
    screen.rerender(view(b));
    await tick();
    held = true;
    screen.rerender(view(a));
    await tick();
    await act(async () => {
      acquiring.resolve({ data: { pageId: a, userId: "editor-user" } });
    });
    await tick();
    expect(http.delete.mock.calls.map(([url]) => url)).not.toContain(
      `wiki/pages/${a}/lock`,
    );
    screen.unmount();
    await tick();
    expect(
      http.delete.mock.calls.filter(([url]) => url === `wiki/pages/${a}/lock`),
    ).toHaveLength(1);
  });

  it("a final retired lifetime waits for its pending acquisition and cleans that exact lock", async () => {
    const id = `late-close-${++suffix}`,
      acquiring = deferred<unknown>();
    vi.mocked(wiki.useWikiPageLock).mockReturnValue({
      data: { data: null },
      refetch: vi.fn(),
    } as any);
    http.post.mockReturnValue({ json: () => acquiring.promise });
    const screen = render(view(id), { wrapper });
    fireEvent.click(screen.getByText("Start Editing"));
    await tick();
    screen.unmount();
    await tick();
    expect(http.delete).not.toHaveBeenCalled();
    await act(async () => {
      acquiring.resolve({ data: { pageId: id, userId: "editor-user" } });
    });
    await tick();
    expect(http.delete).toHaveBeenCalledTimes(1);
    expect(http.delete.mock.calls[0][0]).toBe(`wiki/pages/${id}/lock`);
  });

  it("coalesces repeated Start Editing clicks while the same acquisition is pending", async () => {
    const id = `repeat-acquire-${++suffix}`,
      acquiring = deferred<unknown>();
    vi.mocked(wiki.useWikiPageLock).mockReturnValue({
      data: { data: null },
      refetch: vi.fn(),
    } as any);
    http.post.mockReturnValue({ json: () => acquiring.promise });
    const screen = render(view(id), { wrapper });
    fireEvent.click(screen.getByText("Start Editing"));
    fireEvent.click(screen.getByText("Start Editing"));
    await tick();
    expect(http.post).toHaveBeenCalledTimes(1);
    screen.unmount();
    await act(async () => {
      acquiring.resolve({ data: { pageId: id, userId: "editor-user" } });
    });
    await tick();
    expect(http.delete).toHaveBeenCalledTimes(1);
  });

  it("a content save refreshes no other wiki queries; a title save refreshes the tree", async () => {
    const id = `refresh-${++suffix}`;
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const screen = render(view(id), { wrapper });
    fireEvent.change(screen.getByLabelText("Page body"), {
      target: { value: "body only" },
    });
    await tick(801);
    expect(written).toHaveLength(1);
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["wiki-pages"] });
    const heading = screen.getByRole("heading");
    heading.textContent = `${id} renamed`;
    fireEvent.input(heading);
    await tick(801);
    expect(written).toHaveLength(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wiki-pages"] });
  });

  it("a pending title does not hold back a refreshed page body", async () => {
    const id = `title-only-${++suffix}`;
    const screen = render(view(id), { wrapper });
    const body = screen.getByLabelText("Page body");
    const heading = screen.getByRole("heading");
    heading.textContent = `${id} renamed`;
    fireEvent.input(heading);
    expect(screen.getByText("Saving changes…")).toBeTruthy();
    expect(body.getAttribute("data-dirty")).toBe("false");
    fireEvent.change(body, { target: { value: "body edit" } });
    expect(body.getAttribute("data-dirty")).toBe("true");
    await tick(801);
    expect(body.getAttribute("data-dirty")).toBe("false");
  });

  it("reverting or clearing an unsent title edit sends nothing", async () => {
    const id = `title-revert-${++suffix}`;
    const screen = render(view(id), { wrapper });
    const heading = screen.getByRole("heading");
    heading.textContent = `${id} draft`;
    fireEvent.input(heading);
    heading.textContent = id;
    fireEvent.input(heading);
    expect(screen.getByText("All changes saved")).toBeTruthy();
    heading.textContent = `${id} x`;
    fireEvent.input(heading);
    heading.textContent = "";
    fireEvent.input(heading);
    await tick(801);
    expect(written).toEqual([]);
    expect(screen.getByText("All changes saved")).toBeTruthy();
  });

  it("reverting a title that is already being saved sends a corrective title", async () => {
    const id = `title-inflight-${++suffix}`,
      request = deferred<unknown>();
    nextPatch = () => request.promise;
    const screen = render(view(id), { wrapper });
    const heading = screen.getByRole("heading");
    heading.textContent = `${id} draft`;
    fireEvent.input(heading);
    await tick(801);
    expect(written).toEqual([
      { path: `wiki/pages/${id}`, body: { title: `${id} draft` } },
    ]);
    heading.textContent = id;
    fireEvent.input(heading);
    nextPatch = undefined;
    await act(async () => {
      request.resolve({ data: { ...page(id), title: `${id} draft` } });
    });
    await tick(801);
    expect(written.at(-1)).toEqual({
      path: `wiki/pages/${id}`,
      body: { title: id },
    });
  });

  it("a failed lock renewal keeps renewing and refreshes the lock state", async () => {
    const id = `renewal-${++suffix}`,
      refetch = vi.fn();
    vi.mocked(wiki.useWikiPageLock).mockReturnValue({
      data: {
        data: {
          pageId: id,
          userId: "editor-user",
          user: { displayName: "Editor" },
        },
      },
      refetch,
    } as any);
    const patch = http.patch.getMockImplementation()!;
    let renewals = 0;
    http.patch.mockImplementation((path: string, options: any) => {
      if (!path.endsWith("/heartbeat")) return patch(path, options);
      return ++renewals === 1
        ? Promise.reject(new Error("Network blip"))
        : Promise.resolve(undefined);
    });
    render(view(id), { wrapper });
    await tick();
    expect(renewals).toBe(1);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(notices.error).toHaveBeenCalledWith(expect.any(String), {
      id: `wiki-lock-renewal:${id}`,
    });
    await tick(30_001);
    expect(renewals).toBe(2);
    expect(notices.dismiss).toHaveBeenCalledWith(`wiki-lock-renewal:${id}`);
  });

  it("a new acquisition waits for an in-flight release of the same page", async () => {
    const a = `release-race-a-${++suffix}`,
      b = `release-race-b-${suffix}`,
      releasing = deferred<undefined>();
    let held = true;
    vi.mocked(wiki.useWikiPageLock).mockImplementation(
      (id) =>
        ({
          data: {
            data:
              held && id === a
                ? {
                    pageId: id,
                    userId: "editor-user",
                    user: { displayName: "Editor" },
                  }
                : null,
          },
          refetch: vi.fn(),
        }) as any,
    );
    http.delete.mockReturnValueOnce(releasing.promise);
    const screen = render(view(a), { wrapper });
    await tick();
    screen.rerender(view(b));
    await tick();
    expect(http.delete).toHaveBeenCalledWith(`wiki/pages/${a}/lock`, {
      context: { expectedUserId: "editor-user" },
    });
    held = false;
    screen.rerender(view(a));
    await tick();
    fireEvent.click(screen.getByText("Start Editing"));
    await tick();
    expect(http.post).not.toHaveBeenCalled();
    await act(async () => {
      releasing.resolve(undefined);
    });
    await tick();
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(http.post.mock.calls[0][0]).toBe(`wiki/pages/${a}/lock`);
  });

  it("repeated save failures share one notice that a successful save clears", async () => {
    const id = `notice-${++suffix}`;
    const generic = vi.fn();
    client.setDefaultOptions({
      ...client.getDefaultOptions(),
      mutations: { retry: false, onError: generic },
    });
    nextPatch = () => Promise.reject(new Error("Offline"));
    const screen = render(view(id), { wrapper });
    fireEvent.change(screen.getByLabelText("Page body"), {
      target: { value: "still offline" },
    });
    fireEvent.click(screen.getByText("Done Editing"));
    await tick();
    fireEvent.click(screen.getByText("Retry save"));
    await tick();
    const notice = `autosave:wiki:editor-user:${id}`;
    const failures = notices.error.mock.calls.filter(
      ([, options]) => options?.action,
    );
    expect(failures).toHaveLength(2);
    expect(failures.every(([, options]) => options.id === notice)).toBe(true);
    nextPatch = undefined;
    fireEvent.click(screen.getByText("Retry save"));
    await tick();
    expect(notices.dismiss).toHaveBeenCalledWith(notice);
    // No generic per-attempt error toast alongside the autosave notice.
    expect(generic).not.toHaveBeenCalled();
  });

  describe("retained drafts never overwrite another editor's work (R1)", () => {
    function lockState() {
      const state = { owner: "editor-user" as string | null, offline: false };
      const refetch = vi.fn();
      vi.mocked(wiki.useWikiPageLock).mockImplementation(
        (id) =>
          ({
            data: {
              data: state.owner
                ? {
                    id: `lock-${id}`,
                    pageId: id,
                    userId: state.owner,
                    user: {
                      displayName: state.owner === "bob" ? "Bob" : "Editor",
                    },
                  }
                : null,
            },
            refetch,
          }) as any,
      );
      const patch = http.patch.getMockImplementation()!;
      http.patch.mockImplementation((path: string, options: any) => {
        if (path.endsWith("/heartbeat")) {
          if (state.offline)
            return Promise.reject(new TypeError("Failed to fetch"));
          return state.owner === "editor-user"
            ? Promise.resolve(undefined)
            : Promise.reject(
                Object.assign(new Error("No active lock found"), {
                  statusCode: 404,
                }),
              );
        }
        if (!state.offline) return patch(path, options);
        return {
          json: async () => {
            written.push({ path, body: options.json });
            throw new TypeError("Failed to fetch");
          },
        };
      });
      http.post.mockImplementation(() => {
        state.owner = "editor-user";
        return { json: async () => ({ data: {} }) };
      });
      return state;
    }
    const writesTo = (id: string) =>
      written.filter((entry) => entry.path === `wiki/pages/${id}`);
    const body = (screen: ReturnType<typeof render>) =>
      screen.getByLabelText("Page body") as HTMLTextAreaElement;

    it("R1a: a draft that failed while the lock lapsed is not sent once another user holds it", async () => {
      const a = `r1a-a-${++suffix}`,
        b = `r1a-b-${suffix}`;
      const state = lockState();
      const screen = render(view(a), { wrapper });
      await tick();
      state.offline = true;
      fireEvent.change(body(screen), {
        target: { value: "Alice offline draft" },
      });
      await tick(801);
      expect(writesTo(a)).toHaveLength(1);
      // Renewals keep failing until the server could have let the lock lapse.
      await tick(125_000);
      // Soft checks keep the run going to the decisive write check below.
      expect.soft(body(screen).disabled).toBe(true);
      expect.soft(body(screen).value).not.toContain("Alice offline draft");
      // Bob takes the expired lock and saves; Alice's network comes back.
      state.owner = "bob";
      page(a).content = [{ type: "paragraph", content: "Bob's edit" }];
      state.offline = false;
      await tick(30_001);
      expect.soft(screen.queryByText(/Being edited by Bob/)).not.toBeNull();
      expect
        .soft(
          (screen.queryByText("Restore changes") as HTMLButtonElement | null)
            ?.disabled,
        )
        .toBe(true);
      // Leaving the page (no Retry) must not send the retained draft.
      screen.rerender(view(b));
      await tick(801);
      expect(writesTo(a)).toHaveLength(1);
      screen.rerender(view(a));
      await tick(801);
      expect(writesTo(a)).toHaveLength(1);
    });

    it("R1b: a draft left by 'Leave anyway' is offered on reopen, not shown or replayed over newer work", async () => {
      const a = `r1b-a-${++suffix}`,
        b = `r1b-b-${suffix}`;
      const state = lockState();
      const screen = render(view(a), { wrapper });
      await tick();
      state.offline = true;
      fireEvent.change(body(screen), {
        target: { value: "Alice stale draft" },
      });
      screen.rerender(view(b));
      await tick();
      expect(writesTo(a)).toHaveLength(1);
      // Later, Bob edits page A and finishes; Alice's network is back.
      state.offline = false;
      state.owner = null;
      page(a).content = [{ type: "paragraph", content: "Bob finished edit" }];
      screen.rerender(view(a));
      await tick();
      expect.soft(body(screen).value).toContain("Bob finished edit");
      expect
        .soft(
          (screen.queryByText("Restore changes") as HTMLButtonElement | null)
            ?.disabled,
        )
        .toBe(true);
      screen.rerender(view(b));
      await tick(801);
      expect(writesTo(a)).toHaveLength(1);
      // Starting to edit alone sends nothing; restoring is an explicit choice.
      screen.rerender(view(a));
      await tick();
      fireEvent.click(screen.getByText("Start Editing"));
      await tick();
      await tick(801);
      expect(writesTo(a)).toHaveLength(1);
      fireEvent.click(screen.getByText("Restore changes"));
      await tick();
      expect(writesTo(a)).toHaveLength(2);
      expect(JSON.stringify(writesTo(a)[1].body)).toContain(
        "Alice stale draft",
      );
      expect(body(screen).value).toContain("Alice stale draft");
    });

    it("discarding a retained draft forgets it", async () => {
      const a = `discard-a-${++suffix}`,
        b = `discard-b-${suffix}`;
      const state = lockState();
      const screen = render(view(a), { wrapper });
      await tick();
      state.offline = true;
      fireEvent.change(body(screen), { target: { value: "unwanted" } });
      screen.rerender(view(b));
      await tick();
      state.offline = false;
      screen.rerender(view(a));
      await tick();
      fireEvent.click(screen.getByText("Discard"));
      await tick();
      expect(screen.queryByText("Restore changes")).toBeNull();
      screen.rerender(view(b));
      await tick(801);
      screen.rerender(view(a));
      await tick();
      expect(screen.queryByText("Restore changes")).toBeNull();
      expect(writesTo(a)).toHaveLength(1);
    });
  });
});

describe("server revisions and edit conflicts", () => {
  type Stored = { revision: number; title: string; content: unknown };
  function paragraph(text: string) {
    return [{ type: "paragraph", content: text }];
  }
  function refusal(
    code: "REVISION_CONFLICT" | "EDIT_LOCKED",
    revision: number,
    extra: Record<string, unknown> = {},
  ) {
    return Object.assign(new Error("Refused"), {
      statusCode: 409,
      code,
      current: { revision, updatedAt: "2026-10-30T00:00:00.000Z", ...extra },
    });
  }
  // Stands in for the server's compare-and-set: a save based on another
  // revision, or made while `lockedBy` holds the lock, writes nothing.
  function serve(id: string, stored: Stored, lockedBy?: { current: string | null }) {
    pages.set(id, { ...page(id), ...structuredClone(stored) });
    http.patch.mockImplementation(
      (path: string, options: { json: Record<string, unknown> }) =>
        path.endsWith("/heartbeat")
          ? Promise.resolve(undefined)
          : {
              json: async () => {
                written.push({ path, body: options.json });
                const { expectedRevision, ...fields } = options.json;
                if (lockedBy?.current)
                  throw refusal("EDIT_LOCKED", stored.revision, {
                    lockedBy: { id: "other", displayName: lockedBy.current },
                  });
                if (
                  expectedRevision !== undefined &&
                  expectedRevision !== stored.revision
                )
                  throw refusal("REVISION_CONFLICT", stored.revision);
                Object.assign(stored, fields);
                stored.revision += 1;
                return { data: { ...page(id), ...structuredClone(stored) } };
              },
            },
    );
  }
  // What a refetch of the page delivers to the open view.
  function refetched(id: string, stored: Stored, screen: { rerender: (ui: ReactNode) => void }) {
    pages.set(id, { ...page(id), ...structuredClone(stored) });
    screen.rerender(view(id));
  }
  function body(screen: { getByLabelText: (label: string) => HTMLElement }) {
    return screen.getByLabelText("Page body") as HTMLTextAreaElement;
  }

  it("sends the revision its document is based on, then each save's own revision", async () => {
    const id = `revision-${++suffix}`;
    const stored = { revision: 4, title: id, content: paragraph("start") };
    serve(id, stored);
    const screen = render(view(id), { wrapper });
    fireEvent.change(body(screen), { target: { value: "one" } });
    await tick(801);
    // The cached page still says revision 4; the next save is based on the
    // revision this session's own save produced.
    fireEvent.change(body(screen), { target: { value: "two" } });
    await tick(801);
    expect(written.map((w) => (w.body as any).expectedRevision)).toEqual([4, 5]);
    expect(stored).toMatchObject({ revision: 6, content: paragraph("two") });
    // A newer document fetched while idle is what later edits are based on.
    stored.revision = 9;
    refetched(id, stored, screen);
    await tick();
    fireEvent.change(body(screen), { target: { value: "three" } });
    await tick(801);
    expect((written.at(-1)!.body as any).expectedRevision).toBe(9);
    expect(stored).toMatchObject({ revision: 10, content: paragraph("three") });
  });

  it("a save refused for an older revision is set aside with an explicit conflict, never resent", async () => {
    const id = `conflict-${++suffix}`;
    const stored = { revision: 1, title: id, content: paragraph("base") };
    serve(id, stored);
    const screen = render(view(id), { wrapper });
    await tick();
    // Another client stores revision 2 before this edit is sent.
    Object.assign(stored, { revision: 2, content: paragraph("theirs") });
    fireEvent.change(body(screen), { target: { value: "mine" } });
    await tick(801);
    expect(written).toEqual([
      {
        path: `wiki/pages/${id}`,
        body: { content: paragraph("mine"), expectedRevision: 1 },
      },
    ]);
    expect(stored.content).toEqual(paragraph("theirs"));
    expect(screen.getByRole("status").textContent).toContain(
      "This page was changed elsewhere while you were editing",
    );
    // The editor shows the stored page again, not the refused draft, and no
    // generic retry notice is offered.
    expect(body(screen).value).not.toContain("mine");
    expect(screen.queryByText("Retry save")).toBeNull();
    expect(notices.error).not.toHaveBeenCalled();
    // Blur, navigation flushes and timers send nothing more.
    fireEvent.click(screen.getByText("History"));
    await tick(5000);
    expect(written).toHaveLength(1);
    fireEvent.click(screen.getByText("History"));
    await tick();

    // Once the newer page arrives, restoring is an explicit replacement of it.
    refetched(id, stored, screen);
    await tick();
    fireEvent.click(screen.getByText("Restore changes"));
    await tick();
    expect(written.at(-1)!.body).toEqual({
      content: paragraph("mine"),
      expectedRevision: 2,
    });
    expect(stored).toMatchObject({ revision: 3, content: paragraph("mine") });
    expect(screen.queryByText("Restore changes")).toBeNull();
    // The restored draft is now stored as revision 3, which the next edit is
    // based on although the cached page still says 2.
    fireEvent.change(body(screen), { target: { value: "mine, edited" } });
    await tick(801);
    expect(written.at(-1)!.body).toEqual({
      content: paragraph("mine, edited"),
      expectedRevision: 3,
    });
    expect(stored.revision).toBe(4);
  });

  it("after a conflict the page stays locked until the draft is restored or discarded, then edits build on the page shown", async () => {
    const id = `after-conflict-${++suffix}`;
    const stored = { revision: 1, title: id, content: paragraph("base") };
    serve(id, stored);
    const screen = render(view(id), { wrapper });
    await tick();
    Object.assign(stored, { revision: 2, content: paragraph("theirs") });
    fireEvent.change(body(screen), { target: { value: "mine: a long paragraph" } });
    await tick(801);
    expect(written).toHaveLength(1);
    // Until the newer page arrives the editor shows the older one; it is
    // locked, so nothing typed there can be refused again and replace the
    // set-aside draft (independent review M1).
    expect(body(screen).disabled).toBe(true);
    fireEvent.change(body(screen), { target: { value: "base x" } });
    await tick(801);
    refetched(id, stored, screen);
    await tick(801);
    expect(written).toHaveLength(1);
    // The original draft is what Restore brings back.
    fireEvent.click(screen.getByText("Restore changes"));
    await tick();
    expect(written.at(-1)!.body).toEqual({
      content: paragraph("mine: a long paragraph"),
      expectedRevision: 2,
    });
    expect(stored).toMatchObject({ revision: 3, content: paragraph("mine: a long paragraph") });
  });

  it("discarding a conflicting draft unlocks the page and later edits build on the page shown", async () => {
    const id = `discard-conflict-${++suffix}`;
    const stored = { revision: 1, title: id, content: paragraph("base") };
    serve(id, stored);
    const screen = render(view(id), { wrapper });
    await tick();
    Object.assign(stored, { revision: 2, content: paragraph("theirs") });
    fireEvent.change(body(screen), { target: { value: "mine" } });
    refetched(id, stored, screen);
    await tick(801);
    expect(written.map((w) => (w.body as any).expectedRevision)).toEqual([1]);
    fireEvent.click(screen.getByText("Discard"));
    await tick();
    expect(body(screen).disabled).toBe(false);
    fireEvent.change(body(screen), { target: { value: "theirs, edited" } });
    await tick(801);
    expect(written.at(-1)!.body).toEqual({
      content: paragraph("theirs, edited"),
      expectedRevision: 2,
    });
    expect(stored.revision).toBe(3);
    expect(screen.queryByText("Restore changes")).toBeNull();
  });

  it("a rename from the page tree is stored after pending edits and not reported as a conflict", async () => {
    const id = `tree-rename-${++suffix}`;
    const stored = { revision: 4, title: id, content: paragraph("start") };
    serve(id, stored);
    const screen = render(view(id), { wrapper });
    await tick();
    fireEvent.change(body(screen), { target: { value: "pending body" } });
    // What the tree's rename does, without waiting for the editor's debounce.
    await act(async () => {
      await writeAlongsideAutosave(wikiAutosaveKey("editor-user", id), async () => {
        const response = (await http
          .patch(`wiki/pages/${id}`, { json: { title: "Renamed" } })
          .json()) as { data: { revision: number } };
        return response.data.revision;
      });
    });
    expect(written.map((w) => w.body)).toEqual([
      { content: paragraph("pending body"), expectedRevision: 4 },
      { title: "Renamed" },
    ]);
    // The cached page has not caught up, yet the next edit builds on the rename.
    fireEvent.change(body(screen), { target: { value: "after rename" } });
    await tick(801);
    expect(written.at(-1)!.body).toEqual({
      content: paragraph("after rename"),
      expectedRevision: 6,
    });
    expect(stored).toMatchObject({ revision: 7, title: "Renamed" });
    expect(screen.queryByText("Restore changes")).toBeNull();
  });

  it("an edit made while a page-tree write is in flight is sent after it, on its revision", async () => {
    const id = `tree-held-${++suffix}`;
    const stored = { revision: 4, title: id, content: paragraph("start") };
    serve(id, stored);
    const screen = render(view(id), { wrapper });
    await tick();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let outside!: Promise<void>;
    await act(async () => {
      outside = writeAlongsideAutosave(wikiAutosaveKey("editor-user", id), async () => {
        await gate;
        const response = (await http
          .patch(`wiki/pages/${id}`, { json: { title: "Renamed" } })
          .json()) as { data: { revision: number } };
        return response.data.revision;
      });
    });
    fireEvent.change(body(screen), { target: { value: "typed during rename" } });
    await tick(801);
    expect(written).toEqual([]);
    await act(async () => {
      release();
      await outside;
    });
    await tick();
    expect(written.map((w) => w.body)).toEqual([
      { title: "Renamed" },
      { content: paragraph("typed during rename"), expectedRevision: 5 },
    ]);
    expect(stored).toMatchObject({ revision: 6, title: "Renamed" });
    expect(screen.queryByText("Restore changes")).toBeNull();
  });

  it("a page-tree write is not made when the editor's pending edits cannot be stored", async () => {
    const id = `tree-blocked-${++suffix}`;
    const stored = { revision: 4, title: id, content: paragraph("start") };
    serve(id, stored);
    const served = http.patch.getMockImplementation()!;
    http.patch.mockImplementation((path: string, options: any) =>
      options.json.content
        ? { json: async () => { written.push({ path, body: options.json }); throw new Error("Offline"); } }
        : served(path, options),
    );
    const screen = render(view(id), { wrapper });
    await tick();
    fireEvent.change(body(screen), { target: { value: "unsaved" } });
    let refused: unknown;
    await act(async () => {
      await writeAlongsideAutosave(wikiAutosaveKey("editor-user", id), async () => {
        throw new Error("the outside write must not run");
      }).catch((error) => {
        refused = error;
      });
    });
    expect(refused).toBeInstanceOf(PendingEditsError);
    expect(written.map((w) => w.body)).toEqual([
      { content: paragraph("unsaved"), expectedRevision: 4 },
    ]);
    expect(stored).toMatchObject({ revision: 4, title: id });
  });

  it("a save refused by another user's lock names the holder and is not resent", async () => {
    const id = `locked-${++suffix}`;
    const stored = { revision: 3, title: id, content: paragraph("base") };
    const lockedBy = { current: null as string | null };
    serve(id, stored, lockedBy);
    const screen = render(view(id), { wrapper });
    await tick();
    // The lock lapsed and Bob took the page before this tab noticed.
    lockedBy.current = "Bob";
    fireEvent.change(body(screen), { target: { value: "late" } });
    await tick(801);
    expect(written).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain(
      "Bob is editing this page",
    );
    expect(stored).toMatchObject({ revision: 3, content: paragraph("base") });
    fireEvent.click(screen.getByText("Done Editing"));
    await tick(5000);
    expect(written).toHaveLength(1);
  });
});
