// Every request to the backend, including session refresh, logout, SSO
// redirects, uploads, downloads and the WebSocket, builds its URL here.
//
// VITE_API_BASE_URL may be empty (the default `/api`), a path on the frontend
// origin such as `/custom/api`, or an absolute URL such as
// `https://api.example.com/api`. Trailing slashes are ignored.

const DEFAULT_API_BASE = "/api";

function isAbsolute(value: string) {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value) || value.startsWith("//");
}

/** The configured base without a trailing slash (`""` for the origin root). */
export function normalizeApiBase(configured: string | undefined): string {
  const value = configured?.trim() || DEFAULT_API_BASE;
  const base = isAbsolute(value) ? value : `/${value.replace(/^\/+/, "")}`;
  return base.replace(/\/+$/, "");
}

export function apiBase(): string {
  return normalizeApiBase(import.meta.env.VITE_API_BASE_URL);
}

/** Prefix for ky's `prefixUrl`; always ends with exactly one slash. */
export function apiPrefixUrl(): string {
  return `${apiBase()}/`;
}

/**
 * The URL of an API path such as `auth/refresh` (a leading slash is optional).
 * Search parameters are appended when given.
 */
export function apiUrl(
  path: string,
  search?: URLSearchParams | Record<string, string>,
): string {
  const url = `${apiBase()}/${path.replace(/^\/+/, "")}`;
  if (!search) return url;
  const query = new URLSearchParams(search).toString();
  return query ? `${url}${url.includes("?") ? "&" : "?"}${query}` : url;
}

/** The realtime endpoint, as ws: or wss: on the API's host. */
export function apiWebSocketUrl(path = "ws"): string {
  const url = new URL(apiUrl(path), window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
