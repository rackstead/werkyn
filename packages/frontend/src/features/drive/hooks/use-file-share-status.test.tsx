import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-error";
import { queryKeys } from "@/lib/query-keys";
import { useCreateFileShareLink, useCreateFileShares, useDeleteFileShareLink } from "../api";
import { SHARE_STATUS_GROUP, shareStatusGroups, useFileShareStatus } from "./use-file-share-status";

const net = vi.hoisted(() => ({ requests: [] as string[][], shared: new Set<string>() }));
vi.mock("@/lib/api-client", () => ({
  api: {
    get: (url: string) => {
      const ids = new URLSearchParams(url.split("?")[1]).get("fileIds")!.split(",");
      net.requests.push(ids);
      return { json: () => Promise.resolve({ data: ids.filter((id) => net.shared.has(id)) }) };
    },
    post: () => ({ json: () => Promise.resolve({ data: {} }) }),
    delete: () => Promise.resolve(),
  },
}));

const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `f${from + i}`);

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  net.requests = [];
  // Every tenth file is shared.
  net.shared = new Set(ids(0, 2000).filter((_, i) => i % 10 === 0));
});
afterEach(cleanup);

describe("shareStatusGroups", () => {
  it("fills groups in list order and keeps their members as entries are added or removed", () => {
    const first = shareStatusGroups([], ids(0, 450));
    expect(first.map((g) => g.length)).toEqual([200, 200, 50]);
    // An entry added at the top gets a group of its own; the others keep
    // theirs.
    const added = shareStatusGroups(first, ["new", ...ids(0, 450)]);
    expect(added).toEqual([...first, ["new"]]);
    // A group none of whose entries is listed any more is dropped.
    const removed = shareStatusGroups(added, ["new", ...ids(200, 450)]);
    expect(removed).toEqual(added.slice(1));
    // An entry that leaves the list leaves its group; when it comes back it
    // is in a new group, to be asked for afresh.
    const listed = ["new", ...ids(200, 450)];
    const left = shareStatusGroups(removed, listed.filter((id) => id !== "f205"));
    expect(left[0]).toEqual(removed[0].filter((id) => id !== "f205"));
    expect(left.slice(1)).toEqual(removed.slice(1));
    expect(shareStatusGroups(left, listed)).toEqual([...left, ["f205"]]);
    // Another folder: new groups only.
    expect(shareStatusGroups(removed, ids(1000, 1010))).toEqual([ids(1000, 1010)]);
  });

  it("groups only the entries from the range given, each group filled with those after it", () => {
    const all = ids(0, 1000);
    const near = shareStatusGroups([], all, [450, 520]);
    expect(near).toEqual([ids(450, 650)]);
    // Further on, within that group: nothing new.
    expect(shareStatusGroups(near, all, [500, 640])).toEqual(near);
    // Past it: one more group from the first entry in no group.
    expect(shareStatusGroups(near, all, [600, 700])).toEqual([ids(450, 650), ids(650, 850)]);
    // Back above it: a group up to the first entry already grouped, and on
    // after that group.
    expect(shareStatusGroups(near, all, [400, 460])).toEqual([ids(450, 650), [...ids(400, 450), ...ids(650, 800)]]);
  });
});

describe("useFileShareStatus", () => {
  it("asks in groups, and only for an entry added", async () => {
    const { result, rerender } = renderHook(({ fileIds }) => useFileShareStatus("w", fileIds), {
      wrapper,
      initialProps: { fileIds: ids(0, 450) },
    });
    await waitFor(() => expect(result.current.size).toBe(45));
    expect(net.requests.map((r) => r.length)).toEqual([200, 200, 50]);
    expect(Math.max(...net.requests.map((r) => r.length))).toBeLessThanOrEqual(SHARE_STATUS_GROUP);

    // An entry added at the top of the list.
    net.shared.add("new");
    rerender({ fileIds: ["new", ...ids(0, 450)] });
    expect(result.current.size).toBe(45);
    await waitFor(() => expect(result.current.has("new")).toBe(true));
    expect(net.requests.length).toBe(4);
    expect(net.requests[3]).toEqual(["new"]);
  });

  it("asks only near the entries in view, and nothing before they are known", async () => {
    const all = ids(0, 2000);
    const { result, rerender } = renderHook(
      ({ inView }: { inView: readonly [number, number] | null }) => useFileShareStatus("w", all, inView),
      { wrapper, initialProps: { inView: null as readonly [number, number] | null } },
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(net.requests).toEqual([]);
    // Settled on entries 1,000 to 1,020: one group from 50 before them.
    rerender({ inView: [1000, 1020] });
    await waitFor(() => expect(result.current.size).toBe(20));
    expect(net.requests).toEqual([ids(950, 1150)]);
    // Settled a little further on: already asked.
    rerender({ inView: [1040, 1060] });
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(net.requests.length).toBe(1);
    // Far further on: one group from there; the earlier answers stay.
    rerender({ inView: [1500, 1520] });
    await waitFor(() => expect(result.current.size).toBe(40));
    expect(net.requests[1]).toEqual(ids(1450, 1650));
    expect(result.current.has("f1000")).toBe(true);
  });

  it("asks again after the time a refused request gives", async () => {
    const refusals = { left: 1 };
    const { api } = await import("@/lib/api-client");
    const get = api.get;
    vi.spyOn(api, "get").mockImplementation(((url: string) => {
      if (refusals.left-- > 0) {
        net.requests.push(["refused"]);
        const error = new ApiError(429, "Too Many Requests", "Rate limit exceeded");
        error.retryAfterMs = 20;
        return { json: () => Promise.reject(error) };
      }
      return get(url);
    }) as typeof api.get);
    const { result } = renderHook(() => useFileShareStatus("w", ids(0, 100)), { wrapper });
    await waitFor(() => expect(result.current.size).toBe(10));
    expect(net.requests.map((r) => r.length)).toEqual([1, 100]);
  });

  it("asks afresh for an entry that comes back to the list", async () => {
    const all = ids(0, 450);
    const { result, rerender } = renderHook(({ fileIds }) => useFileShareStatus("w", fileIds), {
      wrapper,
      initialProps: { fileIds: all },
    });
    await waitFor(() => expect(result.current.size).toBe(45));
    // f10 is trashed: its group is asked again without it.
    rerender({ fileIds: all.filter((id) => id !== "f10") });
    await waitFor(() => expect(net.requests.length).toBe(4));
    expect(net.requests[3]).not.toContain("f10");
    // Meanwhile its link is deleted elsewhere (nothing here learns of it),
    // and the file is restored: it is asked for again, and its icon goes.
    net.shared.delete("f10");
    rerender({ fileIds: all });
    await waitFor(() => expect(net.requests.length).toBe(5));
    expect(net.requests[4]).toContain("f10");
    await waitFor(() => expect(result.current.has("f10")).toBe(false));
  });

  it("asks nothing for an empty folder", () => {
    const { result } = renderHook(() => useFileShareStatus("w", []), { wrapper });
    expect(result.current.size).toBe(0);
    expect(net.requests).toEqual([]);
  });

  it("asks again after a share change only for the groups holding the files changed", async () => {
    const { result } = renderHook(
      () => ({
        status: useFileShareStatus("w", ids(0, 600)),
        shares: useCreateFileShares("w"),
        link: useCreateFileShareLink("w"),
        unlink: useDeleteFileShareLink("w"),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.status.size).toBe(60));
    expect(net.requests.length).toBe(3);

    net.shared.add("f1");
    await act(() => result.current.shares.mutateAsync({ fileIds: ["f1"], userIds: ["u2"] }));
    await waitFor(() => expect(result.current.status.has("f1")).toBe(true));
    expect(net.requests.length).toBe(4);
    expect(net.requests[3]).toContain("f1");

    net.shared.add("f450");
    await act(() => result.current.link.mutateAsync({ fileIds: ["f450"] }));
    await waitFor(() => expect(result.current.status.has("f450")).toBe(true));
    expect(net.requests.length).toBe(5);
    expect(net.requests[4]).toContain("f450");

    // Deleting a link the share dialog shows with its files.
    net.shared.delete("f450");
    await act(() => result.current.unlink.mutateAsync({ linkId: "l2", fileIds: ["f450"] }));
    await waitFor(() => expect(result.current.status.has("f450")).toBe(false));
    expect(net.requests.length).toBe(6);
    expect(net.requests[5]).toContain("f450");

    // Deleting a link known only from the cached link lists.
    client.setQueryData(queryKeys.fileShareLinks("w", "f1"), {
      data: [{ id: "l1", files: [{ file: { id: "f1" } }] }],
    });
    net.shared.delete("f1");
    await act(() => result.current.unlink.mutateAsync({ linkId: "l1" }));
    await waitFor(() => expect(result.current.status.has("f1")).toBe(false));
    expect(net.requests.length).toBe(7);
    expect(net.requests[6]).toContain("f1");

    // A link whose files are unknown: every group is asked again.
    await act(() => result.current.unlink.mutateAsync({ linkId: "unknown" }));
    await waitFor(() => expect(net.requests.length).toBe(10));
  });
});
