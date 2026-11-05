import type { ReactNode } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFileShareStatus } from "./use-file-share-status";

const requests = vi.hoisted(() => [] as string[][]);
vi.mock("@/lib/api-client", () => ({
  api: {
    get: (url: string) => {
      const ids = new URLSearchParams(url.split("?")[1]).get("fileIds")!.split(",");
      requests.push(ids);
      // Every tenth file is shared.
      return { json: () => Promise.resolve({ data: ids.filter((id) => Number(id.slice(1)) % 10 === 0) }) };
    },
  },
}));

const ids = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);

afterEach(() => {
  cleanup();
  requests.length = 0;
});

describe("useFileShareStatus", () => {
  it("asks in groups of 100 entries and merges the answers", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(({ fileIds }) => useFileShareStatus("w", fileIds), {
      wrapper,
      initialProps: { fileIds: ids(250) },
    });
    await waitFor(() => expect(result.current.size).toBe(25));
    expect(requests.map((r) => r.length)).toEqual([100, 100, 50]);
    expect(result.current.has("f240")).toBe(true);

    // The next page of 50: only the last group is asked for again.
    rerender({ fileIds: ids(300) });
    await waitFor(() => expect(result.current.size).toBe(30));
    expect(requests.map((r) => r.length)).toEqual([100, 100, 50, 100]);
    expect(requests.at(-1)![0]).toBe("f200");
  });

  it("asks nothing for an empty folder", () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useFileShareStatus("w", []), { wrapper });
    expect(result.current.size).toBe(0);
    expect(requests).toEqual([]);
  });
});
