import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const transport = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; searchParams: Record<string, string>; signal?: AbortSignal }>,
  respond: (() => ({ data: [], nextCursor: null })) as (
    path: string,
    searchParams: Record<string, string>,
    signal?: AbortSignal,
  ) => { data: Array<{ id: string }>; nextCursor: string | null } | Promise<{ data: Array<{ id: string }>; nextCursor: string | null }>,
}));

vi.mock("@/lib/api-client", async (original) => {
  const real = await original<typeof import("@/lib/api-client")>();
  return {
    ...real,
    api: {
      get: (path: string, options: { searchParams?: Record<string, string>; signal?: AbortSignal } = {}) => ({
        json: async () => {
          const searchParams = { ...(options.searchParams ?? {}) };
          transport.calls.push({ path, searchParams, signal: options.signal });
          if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("The request was aborted", "AbortError");
          return transport.respond(path, searchParams, options.signal);
        },
      }),
    },
  };
});

import { useChannels } from "./api";

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  transport.calls = [];
});

afterEach(() => {
  client.clear();
});

it("follows channel pages until nextCursor is null", async () => {
  transport.respond = (path, params) => {
    expect(path).toBe("chat/w/channels");
    if (!params.cursor) return { data: [{ id: "a" }], nextCursor: "a" };
    expect(params.cursor).toBe("a");
    return { data: [{ id: "b" }], nextCursor: null };
  };
  const { result } = renderHook(() => useChannels("w"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.data.map((channel) => channel.id)).toEqual(["a", "b"]);
  expect(transport.calls.map((call) => call.searchParams.cursor)).toEqual([undefined, "a"]);
  expect(transport.calls.every((call) => call.signal)).toBe(true);
});

it("fails when a page is still outstanding after the walk cap", async () => {
  let n = 0;
  transport.respond = () => {
    n += 1;
    return { data: [{ id: `c${n}` }], nextCursor: `c${n}` };
  };
  const { result } = renderHook(() => useChannels("w"), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5000 });
  expect(result.current.data).toBeUndefined();
  expect(transport.calls).toHaveLength(200);
});

it("does not request another page after the query is cancelled", async () => {
  transport.respond = (_path, _params, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      reject(signal.reason ?? new DOMException("The request was aborted", "AbortError"));
    }, { once: true });
  });
  const { unmount } = renderHook(() => useChannels("w"), { wrapper });
  await waitFor(() => expect(transport.calls).toHaveLength(1));
  unmount();
  await waitFor(() => expect(transport.calls[0]?.signal?.aborted).toBe(true));
  expect(transport.calls).toHaveLength(1);
});
