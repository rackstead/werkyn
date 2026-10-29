import ky, { type KyResponse } from "ky";
import { useAuthStore } from "@/stores/auth-store";
import type { EditConflictState } from "@/lib/edit-conflict";

export class ApiError extends Error {
  statusCode: number;
  error: string;
  details?: Array<{ field: string; message: string }>;
  /** Machine-readable reason, for example REVISION_CONFLICT or EDIT_LOCKED. */
  code?: string;
  /** The stored state a 409 edit conflict was checked against. */
  current?: EditConflictState;

  constructor(
    statusCode: number,
    error: string,
    message: string,
    details?: Array<{ field: string; message: string }>,
    conflict?: { code?: string; current?: EditConflictState },
  ) {
    super(message);
    this.statusCode = statusCode;
    this.error = error;
    this.details = details;
    this.code = conflict?.code;
    this.current = conflict?.current;
    this.name = "ApiError";
  }
}


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

export const api = ky.create({
  prefixUrl: import.meta.env.VITE_API_BASE_URL || "/api",
  timeout: 15000,
  credentials: "include",
  hooks: {
    beforeRequest: [
      (request, options) => {
        assertRequestIdentity(options.context);
        const token = useAuthStore.getState().accessToken;
        if (token) {
          request.headers.set("Authorization", `Bearer ${token}`);
        }
      },
    ],
    afterResponse: [
      async (request, options, response) => {
        assertRequestIdentity(options.context);
        if (!response.ok) {
          // On 401, try to refresh token (unless it's the refresh endpoint)
          if (
            response.status === 401 &&
            !request.url.includes("/auth/refresh")
          ) {
            const refreshed = await useAuthStore.getState().refresh();
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
                      assertRequestIdentity(retryOptions.context);
                      retryRequest.headers.set(
                        "Authorization",
                        `Bearer ${useAuthStore.getState().accessToken}`,
                      );
                    },
                  ],
                },
              });
              assertRequestIdentity(options.context);
              return retried;
            }
            // Refresh failed — force logout
            useAuthStore.getState().logout();
          }
          throw await parseErrorResponse(response);
        }
      },
    ],
  },
});
