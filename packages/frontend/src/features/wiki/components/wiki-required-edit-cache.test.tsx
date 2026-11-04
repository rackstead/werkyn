import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useUpdateWikiPage,
  useRestoreVersion,
  wikiPageOwnership,
} from "@/features/wiki/api";
import { useAuthStore } from "@/stores/auth-store";
import { queryKeys } from "@/lib/query-keys";
const { http } = vi.hoisted(() => ({
  http: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/lib/api-client", () => ({ api: http }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}));
let client: QueryClient;
let seq = 0;
const page = (id: string, revision: number) => ({
  id,
  spaceId: "space",
  parentId: null,
  title: "Original",
  icon: null,
  content: "owned content",
  revision,
  updatedAt: "2026-11-04",
});
function wrapper({ children }: any) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: "cache-user" } as any });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
function setup() {
  const id = `owned-cache-${++seq}`;
  client.setQueryData(queryKeys.wikiPage(id), { data: page(id, 7) });
  wikiPageOwnership(client, id, true)!.state.phase = "available";
  client.setQueryData(queryKeys.wikiPageTree("space"), { data: [page(id, 7)] });
  return id;
}
function treeRev(key: readonly unknown[] = queryKeys.wikiPageTree("space")) {
  return client.getQueryData<any>(key).data[0].revision;
}
it("own content ACK advances only a matching existing tree row", async () => {
  const id = setup();
  client.setQueryData(queryKeys.wikiPageTree("space", "newer"), { data: [page(id, 9)] });
  client.setQueryData(queryKeys.wikiPageTree("space", "older"), { data: [page(id, 6)] });
  http.patch.mockReturnValue({ json: async () => ({ data: page(id, 8) }) });
  const { result } = renderHook(() => useUpdateWikiPage(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync({
      pageId: id,
      content: "owned content",
      expectedRevision: 7,
      expectedUserId: "cache-user",
    });
  });
  expect(treeRev(queryKeys.wikiPageTree("space", "newer"))).toBe(9);
  expect(treeRev(queryKeys.wikiPageTree("space", "older"))).toBe(6);
  expect(treeRev()).toBe(8);
  expect(http.get).not.toHaveBeenCalled();
});
it("own restore ACK advances an existing tree row from its reviewed base", async () => {
  const id = setup();
  http.post.mockReturnValue({ json: async () => ({ data: page(id, 8) }) });
  const { result } = renderHook(() => useRestoreVersion(id), { wrapper });
  await act(async () => {
    await result.current.mutateAsync({
      versionId: "owned-version",
      expectedRevision: 7,
    });
  });
  expect(treeRev()).toBe(8);
  expect(http.get).not.toHaveBeenCalled();
});
it("an older ACK cannot downgrade a newer tree or bless unrelated stale metadata", async () => {
  const id = setup();
  client.setQueryData(queryKeys.wikiPageTree("space"), { data: [page(id, 9)] });
  client.setQueryData(queryKeys.wikiPageTree("space", "stale"), {
    data: [{ ...page(id, 6), title: "Stale title" }],
  });
  http.patch.mockReturnValue({ json: async () => ({ data: page(id, 8) }) });
  const { result } = renderHook(() => useUpdateWikiPage(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync({
      pageId: id,
      title: "Original",
      expectedRevision: 7,
      expectedUserId: "cache-user",
    });
  });
  expect(treeRev()).toBe(9);
  expect(treeRev(queryKeys.wikiPageTree("space", "stale"))).toBe(6);
  expect(client.getQueryData<any>(queryKeys.wikiPageTree("space", "stale")).data[0].title).toBe(
    "Stale title",
  );
});

it("delayed own ACK cannot replace a newer refetched detail", async () => {
  const id = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  http.patch.mockReturnValue({
    json: async () => {
      await gate;
      return { data: page(id, 8) };
    },
  });
  const { result } = renderHook(() => useUpdateWikiPage(), { wrapper });
  let operation!: Promise<any>;
  await act(async () => {
    operation = result.current.mutateAsync({
      pageId: id,
      content: "owned content",
      expectedRevision: 7,
      expectedUserId: "cache-user",
    });
    await Promise.resolve();
  });
  await act(async () => {
    client.setQueryData(queryKeys.wikiPage(id), {
      data: { ...page(id, 9), content: "Newer remote content" },
    });
    release();
    await operation;
  });
  const current = client.getQueryData<any>(queryKeys.wikiPage(id));
  expect(current.data.revision).toBe(9);
  expect(current.data.content).toBe("Newer remote content");
});
