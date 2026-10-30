import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeApiBase } from "./api-url";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("normalizes the configured base without duplicating slashes", () => {
  expect(normalizeApiBase(undefined)).toBe("/api");
  expect(normalizeApiBase("")).toBe("/api");
  expect(normalizeApiBase("  ")).toBe("/api");
  expect(normalizeApiBase("/api/")).toBe("/api");
  expect(normalizeApiBase("custom/api")).toBe("/custom/api");
  expect(normalizeApiBase("//edge//")).toBe("//edge");
  expect(normalizeApiBase("/custom/api//")).toBe("/custom/api");
  expect(normalizeApiBase("https://api.example.test/v1/")).toBe(
    "https://api.example.test/v1",
  );
  expect(normalizeApiBase("/")).toBe("");
});

// Every kind of call, including the session and SSO calls that used to be
// hardcoded to /api, uses the configured base.
describe.each([
  ["unset", "", "/api", "ws://localhost:3000/api/ws"],
  ["a custom path", "/custom/api/", "/custom/api", "ws://localhost:3000/custom/api/ws"],
  [
    "an absolute URL",
    "https://api.example.test/v1/",
    "https://api.example.test/v1",
    "wss://api.example.test/v1/ws",
  ],
])("with VITE_API_BASE_URL %s", (_label, configured, base, socket) => {
  async function load() {
    vi.stubEnv("VITE_API_BASE_URL", configured);
    vi.resetModules();
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(input instanceof Request ? input.url : String(input));
        return new Response(null, { status: 204 });
      }),
    );
    return {
      urls,
      apiUrl: await import("./api-url"),
      auth: await import("@/stores/auth-store"),
      sso: await import("@/features/auth/components/sso-buttons"),
    };
  }

  it("builds request, session, SSO and realtime URLs on that base", async () => {
    const { urls, apiUrl, auth, sso } = await load();
    expect(apiUrl.apiPrefixUrl()).toBe(`${base}/`);
    expect(apiUrl.apiUrl("/users/me")).toBe(`${base}/users/me`);
    expect(apiUrl.apiWebSocketUrl()).toBe(socket);
    expect(sso.ssoLoginUrl("github", "/invite/abc")).toBe(
      `${base}/auth/oidc/login?connector_id=github&return_url=%2Finvite%2Fabc`,
    );

    await auth.useAuthStore.getState().refresh();
    auth.useAuthStore.setState({
      user: {
        id: "alice",
        email: "alice@example.test",
        displayName: "Alice",
        avatarUrl: null,
        jobTitle: null,
        phone: null,
        timezone: null,
        emailVerified: true,
      },
      accessToken: "alice-token",
    });
    await auth.useAuthStore.getState().logout();
    expect(urls).toEqual([`${base}/auth/refresh`, `${base}/auth/logout`]);
  });
});

it("sends ky requests to an absolute API base", async () => {
  vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test/v1/");
  vi.resetModules();
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const { api } = await import("./api-client");
  await api.get("users/me").json();
  expect((fetch.mock.calls[0] as unknown[])[0]).toMatchObject({
    url: "https://api.example.test/v1/users/me",
    credentials: "include",
  });
});
