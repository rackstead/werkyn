import type { ReactNode } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useApiKeys } from "./api-keys";

const state = vi.hoisted(() => ({
  user: { id: "owner" } as { id: string } | null,
  get: vi.fn(),
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (
    selector: (state: { user: { id: string } | null }) => unknown,
  ) => selector({ user: state.user }),
}));
vi.mock("@/lib/api-client", () => ({ api: { get: state.get } }));

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  state.user = { id: "owner" };
  state.get.mockReset();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
});

it("does not reuse another user's cached key metadata after an account switch", async () => {
  state.get.mockImplementation(() => {
    const owner = state.user!.id;
    return {
      json: async () => ({
        data: [{ id: `${owner}-key`, name: `${owner} integration` }],
      }),
    };
  });
  const { result, rerender } = renderHook(() => useApiKeys(), { wrapper });
  await waitFor(() =>
    expect(result.current.data?.data[0].id).toBe("owner-key"),
  );
  state.user = { id: "other" };
  rerender();
  expect(result.current.data?.data[0]?.id).not.toBe("owner-key");
  await waitFor(() =>
    expect(result.current.data?.data[0].id).toBe("other-key"),
  );
  expect(state.get).toHaveBeenCalledTimes(2);
});

it("does not fetch keys without a signed-in user", () => {
  state.user = null;
  renderHook(() => useApiKeys(), { wrapper });
  expect(state.get).not.toHaveBeenCalled();
});
