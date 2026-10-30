import type { EditConflictState } from "./edit-conflict";

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
