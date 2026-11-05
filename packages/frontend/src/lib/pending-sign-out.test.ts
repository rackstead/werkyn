import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PENDING_SIGN_OUTS,
  PENDING_SIGN_OUT_TTL_MS,
  clearPendingSignOut,
  clearPendingSignOutsExcept,
  hasPendingSignOut,
  pendingSignOuts,
  recordPendingSignOut,
  sessionIdOf,
} from "./pending-sign-out";

const sid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const NOW = Date.UTC(2026, 10, 4);

function token(claims: unknown) {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256" })}.${part(claims)}.signature`;
}

function keys() {
  return Object.keys(localStorage).filter((key) =>
    key.startsWith("pm-auth-signout:"),
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_API_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sessionIdOf", () => {
  it("reads the sid claim of an access token, expired or not", () => {
    expect(sessionIdOf(token({ sub: "u", sid: sid(1), exp: 1 }))).toBe(sid(1));
    expect(sessionIdOf(token({ sid: sid(2).toUpperCase() }))).toBe(sid(2));
    // base64url without padding, with characters that differ from base64
    expect(sessionIdOf(token({ sid: sid(3), name: "ÿÿ>>??" }))).toBe(sid(3));
  });

  it.each([
    ["no token", null],
    ["not a JWT", "alice-token"],
    ["no sid", token({ sub: "u" })],
    ["a sid that is not a UUID", token({ sid: "../../x" })],
    ["a sid that is not a string", token({ sid: 7 })],
    ["a payload that is not JSON", "a.%%%.c"],
  ])("is null for %s", (_label, value) => {
    expect(sessionIdOf(value)).toBeNull();
  });
});

describe("pending sign-out records", () => {
  it("keeps one record per session, under the API's absolute base URL, without tokens", () => {
    expect(recordPendingSignOut(sid(1), "alice", NOW)).toBe(true);
    expect(recordPendingSignOut(sid(1), "alice", NOW + 5)).toBe(true);
    expect(keys()).toEqual([
      `pm-auth-signout:v1:${location.origin}/api/#${sid(1)}`,
    ]);
    expect(JSON.parse(localStorage.getItem(keys()[0])!)).toEqual({
      userId: "alice",
      at: NOW + 5,
    });
    expect(pendingSignOuts(NOW)).toEqual([
      { sessionId: sid(1), userId: "alice", at: NOW + 5 },
    ]);
    expect(hasPendingSignOut(sid(1), NOW)).toBe(true);
    expect(hasPendingSignOut(sid(2), NOW)).toBe(false);
    expect(hasPendingSignOut(null, NOW)).toBe(false);
    clearPendingSignOut(sid(1));
    expect(keys()).toEqual([]);
  });

  it("after a sign-in, keeps only the record of the session signed in", () => {
    recordPendingSignOut(sid(1), "alice", NOW);
    recordPendingSignOut(sid(2), "alice", NOW + 1);
    recordPendingSignOut(sid(3), "bob", NOW + 2);
    clearPendingSignOutsExcept(sid(2));
    expect(pendingSignOuts(NOW + 2).map((record) => record.sessionId)).toEqual([
      sid(2),
    ]);
    clearPendingSignOutsExcept(sid(9));
    expect(pendingSignOuts(NOW + 2)).toEqual([]);
  });

  it("separates APIs and leaves other keys alone", () => {
    localStorage.setItem("unrelated", "kept");
    recordPendingSignOut(sid(1), "alice", NOW);
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.test/api/");
    expect(pendingSignOuts(NOW)).toEqual([]);
    recordPendingSignOut(sid(2), "bob", NOW);
    expect(pendingSignOuts(NOW).map((record) => record.sessionId)).toEqual([
      sid(2),
    ]);
    vi.stubEnv("VITE_API_BASE_URL", "");
    expect(pendingSignOuts(NOW).map((record) => record.sessionId)).toEqual([
      sid(1),
    ]);
    expect(localStorage.getItem("unrelated")).toBe("kept");
    expect(keys()).toHaveLength(2);
  });

  it(`keeps at most ${MAX_PENDING_SIGN_OUTS}, dropping the oldest`, () => {
    for (let n = 1; n <= 20; n++)
      recordPendingSignOut(sid(n), "alice", NOW + n);
    const kept = pendingSignOuts(NOW + 20).map((record) => record.sessionId);
    expect(kept).toEqual(
      Array.from({ length: MAX_PENDING_SIGN_OUTS }, (_, i) => sid(20 - i)),
    );
    expect(keys()).toHaveLength(MAX_PENDING_SIGN_OUTS);
  });

  it("expires records after the refresh-token lifetime, with a day of margin", () => {
    recordPendingSignOut(sid(1), "alice", NOW);
    recordPendingSignOut(sid(2), "alice", NOW + 1000);
    expect(PENDING_SIGN_OUT_TTL_MS).toBeGreaterThanOrEqual(
      8 * 24 * 60 * 60 * 1000,
    );
    expect(hasPendingSignOut(sid(1), NOW + PENDING_SIGN_OUT_TTL_MS)).toBe(true);
    expect(hasPendingSignOut(sid(1), NOW + PENDING_SIGN_OUT_TTL_MS + 1)).toBe(
      false,
    );
    expect(
      pendingSignOuts(NOW + PENDING_SIGN_OUT_TTL_MS + 1).map(
        (r) => r.sessionId,
      ),
    ).toEqual([sid(2)]);
    expect(keys()).toHaveLength(1);
  });

  it("keeps a record whose value is unreadable, as the oldest, and drops keys that name no session", () => {
    const prefix = `pm-auth-signout:v1:${location.origin}/api/#`;
    localStorage.setItem(prefix + sid(1), "{not json");
    localStorage.setItem(prefix + "not-a-session", "{}");
    recordPendingSignOut(sid(2), "alice", NOW);
    expect(pendingSignOuts(NOW)).toEqual([
      { sessionId: sid(2), userId: "alice", at: NOW },
      { sessionId: sid(1), userId: null, at: null },
    ]);
    expect(hasPendingSignOut(sid(1), NOW + 10 * PENDING_SIGN_OUT_TTL_MS)).toBe(
      true,
    );
    expect(localStorage.getItem(prefix + "not-a-session")).toBeNull();
    // An unreadable record is the first to go when the bound is reached.
    for (let n = 3; n < 3 + MAX_PENDING_SIGN_OUTS - 1; n++)
      recordPendingSignOut(sid(n), "alice", NOW + n);
    expect(
      pendingSignOuts(NOW).some((record) => record.sessionId === sid(1)),
    ).toBe(false);
  });

  it("reports nothing stored when storage fails, without throwing", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    expect(recordPendingSignOut(sid(1), "alice", NOW)).toBe(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Denied", "SecurityError");
    });
    expect(hasPendingSignOut(sid(1), NOW)).toBe(false);
    expect(pendingSignOuts(NOW)).toEqual([]);
    expect(() => clearPendingSignOut(sid(1))).not.toThrow();
  });
});
