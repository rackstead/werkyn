import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { beginOidcSignIn, clearOidcSignIn, oidcSignInAttempt } from "./oidc-sign-in";
import { recordPendingSignOut } from "./pending-sign-out";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubEnv("VITE_API_BASE_URL", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const sid = "00000000-0000-4000-8000-000000000001";

it("keeps a bounded pre-redirect snapshot in this tab, with no credential", () => {
  recordPendingSignOut(sid, "alice");
  const attemptId = beginOidcSignIn();
  expect(attemptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(oidcSignInAttempt()).toEqual({ attemptId, sessionIds: [sid] });
  expect(Object.keys(sessionStorage)).toEqual([`pm-auth-oidc:v1:${location.origin}/api/`]);
  expect(JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage)[0])!)).toEqual({ attemptId, sessionIds: [sid] });
});

it("keeps only the latest attempt per API and does not erase it for an older completion", () => {
  const first = beginOidcSignIn()!;
  const second = beginOidcSignIn()!;
  clearOidcSignIn(first);
  expect(oidcSignInAttempt()?.attemptId).toBe(second);
  expect(Object.keys(sessionStorage)).toHaveLength(1);
  clearOidcSignIn(second);
  expect(oidcSignInAttempt()).toBeNull();
});

it("does not use an attempt from another API base", () => {
  beginOidcSignIn();
  vi.stubEnv("VITE_API_BASE_URL", "https://other.example.test/api");
  expect(oidcSignInAttempt()).toBeNull();
});

it("rejects malformed or oversized snapshot data", () => {
  beginOidcSignIn();
  const key = Object.keys(sessionStorage)[0];
  for (const value of ["{", "x".repeat(2049), JSON.stringify({ attemptId: sid, sessionIds: [sid, sid] }),
    JSON.stringify({ attemptId: "invalid", sessionIds: [] }), JSON.stringify({ attemptId: sid, sessionIds: [7] })]) {
    sessionStorage.setItem(key, value);
    expect(oidcSignInAttempt()).toBeNull();
  }
});

it("preserves legacy behavior when session storage cannot be written", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(beginOidcSignIn()).toBeNull();
  expect(oidcSignInAttempt()).toBeNull();
});
