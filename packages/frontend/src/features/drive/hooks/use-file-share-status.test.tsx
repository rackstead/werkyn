import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    // An entry added at the top joins the last group; the others keep theirs.
    const added = shareStatusGroups(first, ["new", ...ids(0, 450)]);
    expect(added.slice(0, 2)).toEqual(first.slice(0, 2));
    expect(added[2]).toEqual([...first[2], "new"]);
    // A group none of whose entries is listed any more is dropped.
    const removed = shareStatusGroups(added, ["new", ...ids(200, 450)]);
    expect(removed).toEqual(added.slice(1));
    // An entry that leaves the list leaves its group; when it comes back it
    // joins the last group, to be asked for afresh.
    const left = shareStatusGroups(removed, ["new", ...ids(200, 450)].filter((id) => id !== "f205"));
    expect(left[0]).toEqual(removed[0].filter((id) => id !== "f205"));
    expect(left[1]).toEqual(removed[1]);
    const back = shareStatusGroups(left, ["new", ...ids(200, 450)]);
    expect(back[0]).toEqual(left[0]);
    expect(back[1]).toEqual([...left[1], "f205"]);
    // Another folder: new groups only.
    expect(shareStatusGroups(removed, ids(1000, 1010))).toEqual([ids(1000, 1010)]);
  });
});

describe("useFileShareStatus", () => {
  it("asks in groups and asks again only for the group an added entry joins", async () => {
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
    // The earlier answer stays while the last group is asked again.
    expect(result.current.size).toBe(45);
    await waitFor(() => expect(result.current.has("new")).toBe(true));
    expect(net.requests.length).toBe(4);
    expect(net.requests[3]).toEqual([...ids(400, 450), "new"]);
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
