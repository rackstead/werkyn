import { type ReactNode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as wiki from "../api";
import { WikiPageView } from "./wiki-page-view";
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
    }: any) => {
      const [value, setValue] = React.useState(
        JSON.stringify(recoveredContent ?? initialContent),
      );
      return (
        <textarea
          aria-label="Page body"
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
    expect(
      (reopened.getByLabelText("Page body") as HTMLTextAreaElement).value,
    ).toContain("closed draft");
    nextPatch = undefined;
    fireEvent.click(reopened.getByText("Retry save"));
    await tick();
    expect(written[1]).toEqual(written[0]);
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
    const retry = notices.error.mock.calls.at(-1)?.[1]?.action?.onClick;
    expect(retry).toBeTypeOf("function");
    retry();
    await tick();
    expect(written).toHaveLength(0);
    act(() => {
      useAuthStore.setState({
        user: { ...useAuthStore.getState().user!, id: "editor-user" },
      });
    });
    await tick();
    fireEvent.click(screen.getByText("Retry save"));
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

  it("reverting or clearing a title saves what the heading shows, never an abandoned value", async () => {
    const id = `title-revert-${++suffix}`;
    const screen = render(view(id), { wrapper });
    const heading = screen.getByRole("heading");
    heading.textContent = `${id} draft`;
    fireEvent.input(heading);
    heading.textContent = id;
    fireEvent.input(heading);
    await tick(801);
    expect(written).toEqual([
      { path: `wiki/pages/${id}`, body: { title: id } },
    ]);
    heading.textContent = `${id} x`;
    fireEvent.input(heading);
    heading.textContent = "";
    fireEvent.input(heading);
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
  });
});
