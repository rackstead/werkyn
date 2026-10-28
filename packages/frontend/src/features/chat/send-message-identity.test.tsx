import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth-store";

// Uses the real API client and ky retry engine; only fetch is stubbed. The
// client reads its base URL when it is first imported.
vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test/api");
const { useSendMessage } = await import("./api");
const alice = {
  id: "alice",
  email: "alice@example.test",
  displayName: "Alice",
  avatarUrl: null,
  phone: null,
  jobTitle: null,
  timezone: null,
  emailVerified: true,
};
const bob = { ...alice, id: "bob", email: "bob@example.test", displayName: "Bob" };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => useAuthStore.setState({ user: alice, accessToken: "alice-token" }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => vi.unstubAllEnvs());

it("retries a transient failure as the same author with the same key", async () => {
  const requests: Request[] = [];
  const responses = [json(503, { message: "busy" }), json(201, { data: { id: "m1", parentId: null } })];
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push(request.clone());
    return responses.shift()!;
  }));
  const { result } = renderHook(() => useSendMessage("wid", "channel"), { wrapper });
  await act(() => result.current.mutateAsync({ content: "hello" }));
  expect(requests).toHaveLength(2);
  expect(requests.map((r) => r.headers.get("Authorization"))).toEqual(["Bearer alice-token", "Bearer alice-token"]);
  expect(new Set(requests.map((r) => r.headers.get("Idempotency-Key"))).size).toBe(1);
});

it("does not retry a failed send under an account that signed in meanwhile", async () => {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push(request.clone());
    useAuthStore.setState({ user: bob, accessToken: "bob-token" });
    return json(503, { message: "busy" });
  }));
  const { result } = renderHook(() => useSendMessage("wid", "channel"), { wrapper });
  await act(() =>
    expect(result.current.mutateAsync({ content: "alice's draft" })).rejects.toMatchObject({ statusCode: 409 }),
  );
  expect(requests).toHaveLength(1);
  expect(requests[0].headers.get("Authorization")).toBe("Bearer alice-token");
});
