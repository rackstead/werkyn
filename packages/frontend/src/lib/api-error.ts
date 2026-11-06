import type { EditConflictState } from "./edit-conflict";

export class ApiError extends Error {
  statusCode: number;
  error: string;
  details?: Array<{ field: string; message: string }>;
  /** Machine-readable reason, for example REVISION_CONFLICT or EDIT_LOCKED. */
  code?: string;
  /** The stored state a 409 edit conflict was checked against. */
  current?: EditConflictState;
  /** Whole seconds the server asked to wait (Retry-After), when it did. */
  retryAfter?: number;

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

/**
 * Work started for one signed-in identity (or for the signed-out state) that
 * finished after the browser changed identity. It is discarded rather than
 * applied to the account that is signed in now. It carries no `code`, so it
 * is never taken for an edit conflict (`isEditConflict`).
 */
export class IdentityChangedError extends ApiError {
  constructor() {
    super(
      409,
      "Identity changed",
      "The signed-in account changed before this request finished",
    );
    this.name = "IdentityChangedError";
  }
}

export function isIdentityChangedError(error: unknown): boolean {
  return error instanceof IdentityChangedError;
}

const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * A Retry-After header value as whole seconds from now: delay-seconds or an
 * HTTP date (IMF-fixdate). Missing or unreadable values give undefined.
 */
export function retryAfterSeconds(
  value: string | null,
  now = Date.now(),
): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = HTTP_DATE.test(trimmed) ? Date.parse(trimmed) : NaN;
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}
