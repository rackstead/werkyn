import ky, { type KyResponse } from "ky";
import { useAuthStore } from "@/stores/auth-store";
import type { EditConflictState } from "@/lib/edit-conflict";
import {
  ApiError,
  IdentityChangedError,
  isIdentityChangedError,
} from "./api-error";
import { apiPrefixUrl } from "./api-url";
import { identityGeneration, identitySignal } from "./identity";

export {
  ApiError,
  IdentityChangedError,
  isIdentityChangedError,
} from "./api-error";

export function mapApiErrorToForm(
  error: unknown,
): Record<string, string> | null {
  if (error instanceof ApiError && error.details) {
    const fieldErrors: Record<string, string> = {};
    for (const detail of error.details) {
      fieldErrors[detail.field] = detail.message;
    }
    return fieldErrors;
  }
  return null;
}

async function parseErrorResponse(response: KyResponse): Promise<ApiError> {
  try {
    const body = (await response.json()) as {
      statusCode?: number;
      error?: string;
      message?: string;
      details?: Array<{ field: string; message: string }>;
      code?: string;
      current?: EditConflictState;
    };
    return new ApiError(
      body.statusCode ?? response.status,
      body.error ?? "Error",
      body.message ?? "An error occurred",
      body.details,
      { code: body.code, current: body.current },
    );
  } catch {
    return new ApiError(
      response.status,
      "Error",
      response.statusText || "An error occurred",
    );
  }
}

function assertRequestIdentity(context: Record<string, unknown>) {
  const expectedUserId = context.expectedUserId;
  if (
    typeof expectedUserId === "string" &&
    useAuthStore.getState().user?.id !== expectedUserId
  ) {
    throw new ApiError(
      409,
      "Identity changed",
      "Sign in as the author to save these changes",
    );
  }
}

// The identity generation each request was first sent in, keyed by its ky
// context (one object per request, kept across ky's retries).
const requestGenerations = new WeakMap<object, number>();

/** Rejects a request, or its response, once the identity has changed. */
function assertRequestGeneration(context: object) {
  const current = identityGeneration();
  const started = requestGenerations.get(context);
  if (started === undefined) requestGenerations.set(context, current);
  else if (started !== current) throw new IdentityChangedError();
}

/** `AbortSignal.any`, with a fallback for browsers that predate it. */
function anySignal(signals: AbortSignal[]): {
  signal: AbortSignal;
  release: () => void;
} {
  if (typeof AbortSignal.any === "function")
    return { signal: AbortSignal.any(signals), release: () => {} };
  const controller = new AbortController();
  const unlisten: (() => void)[] = [];
  for (const source of signals) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const abort = () => controller.abort(source.reason);
    source.addEventListener("abort", abort, { once: true });
    unlisten.push(() => source.removeEventListener("abort", abort));
  }
  return {
    signal: controller.signal,
    release: () => unlisten.forEach((remove) => remove()),
  };
}

// Requests are bound to the identity they were sent for: an identity change
// aborts them at once, even if the underlying fetch ignores the abort, so a
// late response cannot reach the next account's caches or callbacks.
function fetchForCurrentIdentity(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const identity = identitySignal();
  const signals = [identity];
  if (input instanceof Request) signals.push(input.signal);
  if (init?.signal) signals.push(init.signal);
  return new Promise<Response>((resolve, reject) => {
    const abort = () => reject(identity.reason);
    identity.addEventListener("abort", abort, { once: true });
    const combined = anySignal(signals);
    globalThis
      .fetch(input, { ...init, signal: combined.signal })
      .then(resolve, reject)
      .finally(() => {
        identity.removeEventListener("abort", abort);
        combined.release();
      });
  });
}

export const api = ky.create({
  prefixUrl: apiPrefixUrl(),
  timeout: 15000,
  credentials: "include",
  fetch: fetchForCurrentIdentity,
  // A request overtaken by an identity change is never sent again.
  retry: {
    shouldRetry: ({ error }) =>
      isIdentityChangedError(error) ? false : undefined,
  },
  hooks: {
    beforeRequest: [
      (request, options) => {
        assertRequestGeneration(options.context);
        assertRequestIdentity(options.context);
        const token = useAuthStore.getState().accessToken;
        if (token) {
          request.headers.set("Authorization", `Bearer ${token}`);
        }
      },
    ],
    afterResponse: [
      async (request, options, response) => {
        assertRequestGeneration(options.context);
        assertRequestIdentity(options.context);
        if (!response.ok) {
          // A 401 for a request that carried an access token means it expired:
          // refresh it (unless this is the refresh endpoint). A request sent
          // while signed out (sign-in, public pages) reports its own 401.
          if (
            response.status === 401 &&
            request.headers.has("Authorization") &&
            !request.url.includes("/auth/refresh")
          ) {
            const generation = identityGeneration();
            const refreshed = await useAuthStore.getState().refresh();
            assertRequestGeneration(options.context);
            assertRequestIdentity(options.context);
            if (refreshed) {
              // Retry the original request with the new token
              request.headers.set(
                "Authorization",
                `Bearer ${useAuthStore.getState().accessToken}`,
              );
              // The raw retry deliberately omits this afterResponse hook, so it
              // cannot refresh indefinitely. Keep the identity guard on the
              // actual retry dispatch, which may occur after an account switch.
              const retried = await ky(request, {
                ...options,
                hooks: {
                  beforeRequest: [
                    (retryRequest, retryOptions) => {
                      assertRequestGeneration(retryOptions.context);
                      assertRequestIdentity(retryOptions.context);
                      retryRequest.headers.set(
                        "Authorization",
                        `Bearer ${useAuthStore.getState().accessToken}`,
                      );
                    },
                  ],
                },
              });
              assertRequestGeneration(options.context);
              assertRequestIdentity(options.context);
              return retried;
            }
            // The session can no longer be refreshed: sign this identity out,
            // unless it has already changed while the refresh was running.
            useAuthStore.getState().expireSession(generation);
          }
          throw await parseErrorResponse(response);
        }
      },
    ],
  },
});
