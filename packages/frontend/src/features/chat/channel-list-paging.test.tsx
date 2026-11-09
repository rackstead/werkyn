import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const transport = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; searchParams: Record<string, string> }>,
  respond: (() => ({ data: [], nextCursor: null })) as (
    path: string,
    searchParams: Record<string, string>,
  ) => { data: Array<{ id: string }>; nextCursor: string | null },
}));

vi.mock("@/lib/api-client", async (original) => {
  const real = await original<typeof import("@/lib/api-client")>();
  return {
    ...real,
    api: {
      get: (path: string, options: { searchParams?: Record<string, string> } = {}) => ({
        json: async () => {
          const searchParams = { ...(options.searchParams ?? {}) };
          transport.calls.push({ path, searchParams });
          return transport.respond(path, searchParams);
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
});
