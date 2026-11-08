import { apiPrefixUrl } from "./api-url";
import { MAX_PENDING_SIGN_OUTS, pendingSignOuts } from "./pending-sign-out";

export interface OidcSignInAttempt {
  attemptId: string;
  sessionIds: string[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function key() {
  const base = new URL(apiPrefixUrl(), window.location.href);
  base.search = "";
  base.hash = "";
  return `pm-auth-oidc:v1:${base.href}`;
}

/** One tab's pre-redirect snapshot; no credential or client-clock expiry. */
export function beginOidcSignIn(): string | null {
  try {
    // Plain HTTP self-hosting has getRandomValues but may lack randomUUID.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const attemptId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    sessionStorage.setItem(key(), JSON.stringify({
      attemptId, sessionIds: pendingSignOuts().map((record) => record.sessionId),
    }));
    return attemptId;
  } catch {
    // Legacy completion remains available when browser storage is blocked.
    return null;
  }
}

export function oidcSignInAttempt(): OidcSignInAttempt | null {
  try {
    const raw = sessionStorage.getItem(key());
    if (!raw || raw.length > 2048) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { attemptId, sessionIds } = value as Partial<OidcSignInAttempt>;
    if (typeof attemptId !== "string" || !UUID.test(attemptId) ||
        !Array.isArray(sessionIds) || sessionIds.length > MAX_PENDING_SIGN_OUTS ||
        !sessionIds.every((id) => typeof id === "string" && UUID.test(id)) ||
        new Set(sessionIds).size !== sessionIds.length) return null;
    return { attemptId, sessionIds };
  } catch {
    return null;
  }
}

/** A stale completion cannot erase another attempt started in this tab. */
export function clearOidcSignIn(attemptId: string) {
  try {
    if (oidcSignInAttempt()?.attemptId === attemptId) sessionStorage.removeItem(key());
  } catch {
    // A later completion remains bound by its server proof and current cookie.
  }
}
