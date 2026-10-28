import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./api-client";
import { useAuthStore } from "@/stores/auth-store";

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
const bob = {
  ...alice,
  id: "bob",
  email: "bob@example.test",
  displayName: "Bob",
};
const client = api.extend({
  prefixUrl: "https://api.example.test/api",
  retry: 0,
});
const expected = {
  context: { expectedUserId: "alice" },
  json: { description: "Alice draft" },
};
const unauthorized = () =>
  new Response(JSON.stringify({ message: "Expired" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
const success = () =>
  new Response(JSON.stringify({ saved: true }), {
    headers: { "Content-Type": "application/json" },
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let count = 0; count < 100; count++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Request phase not reached");
}
beforeEach(() =>
  useAuthStore.setState({ user: alice, accessToken: "alice-token" }),
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("rejects an editor request before actual fetch when its author is no longer current", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  useAuthStore.setState({ user: bob, accessToken: "bob-token" });
  await expect(
    client.patch("tasks/task-a", expected).json(),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(fetch).not.toHaveBeenCalled();
});

it("a deferred 401 cannot refresh or retry an old draft after switching accounts", async () => {
  const response = deferred<Response>();
  const fetch = vi.fn(() => response.promise);
  vi.stubGlobal("fetch", fetch);
  const refresh = vi.fn(async () => true);
  const logout = vi.fn(async () => {});
  useAuthStore.setState({ refresh, logout });
  const request = client.patch("tasks/task-a", expected).json();
  const rejected = expect(request).rejects.toMatchObject({ statusCode: 409 });
  await until(() => fetch.mock.calls.length === 1);
  useAuthStore.setState({ user: bob, accessToken: "bob-token" });
  response.resolve(unauthorized());
  await rejected;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(refresh).not.toHaveBeenCalled();
  expect(logout).not.toHaveBeenCalled();
  expect(useAuthStore.getState().user?.id).toBe("bob");
});

it("a refresh resolving after an identity switch cannot replay the draft with the new token", async () => {
  const refreshResult = deferred<boolean>();
  const fetch = vi.fn(async () => unauthorized());
  vi.stubGlobal("fetch", fetch);
  const refresh = vi.fn(() => refreshResult.promise);
  const logout = vi.fn(async () => {});
  useAuthStore.setState({ refresh, logout });
  const request = client.patch("tasks/task-a", expected).json();
  const rejected = expect(request).rejects.toMatchObject({ statusCode: 409 });
  await until(() => refresh.mock.calls.length === 1);
  useAuthStore.setState({ user: bob, accessToken: "bob-token" });
  refreshResult.resolve(true);
  await rejected;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(logout).not.toHaveBeenCalled();
});

it("a same-identity refresh retries once with that user's renewed token", async () => {
  const tokens: (string | null)[] = [];
  const fetch = vi.fn(async (request: Request) => {
    tokens.push(request.headers.get("Authorization"));
    return tokens.length === 1 ? unauthorized() : success();
  });
  vi.stubGlobal("fetch", fetch);
  const refresh = vi.fn(async () => {
    useAuthStore.setState({ accessToken: "alice-renewed" });
    return true;
  });
  useAuthStore.setState({ refresh });
  await expect(client.patch("tasks/task-a", expected).json()).resolves.toEqual({
    saved: true,
  });
  expect(tokens).toEqual(["Bearer alice-token", "Bearer alice-renewed"]);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("rejects an old successful response before consumers can cache it under a new identity", async () => {
  const response = deferred<Response>();
  const fetch = vi.fn(() => response.promise);
  vi.stubGlobal("fetch", fetch);
  const request = client.patch("tasks/task-a", expected).json();
  const rejected = expect(request).rejects.toMatchObject({ statusCode: 409 });
  await until(() => fetch.mock.calls.length === 1);
  useAuthStore.setState({ user: bob, accessToken: "bob-token" });
  response.resolve(success());
  await rejected;
  expect(fetch).toHaveBeenCalledTimes(1);
});
