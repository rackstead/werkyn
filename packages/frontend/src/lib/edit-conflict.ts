/** The stored state an edit was checked against when the server refused it. */
export interface EditConflictState {
  revision: number;
  updatedAt: string;
  /** Who holds the edit lock, for an EDIT_LOCKED refusal. */
  lockedBy?: { id: string; displayName: string };
  lockExpiresAt?: string;
}

export interface EditConflictError extends Error {
  statusCode: 409;
  code: "REVISION_CONFLICT" | "EDIT_LOCKED";
  current?: EditConflictState;
}

/**
 * The server refused an edit without writing it (409): the edit was based on
 * an older revision (REVISION_CONFLICT), or another user holds the edit lock
 * (EDIT_LOCKED). Sending it again would be refused again or replace newer
 * content, so it is never retried automatically.
 */
export function isEditConflict(error: unknown): error is EditConflictError {
  if (!(error instanceof Error)) return false;
  const { statusCode, code } = error as Partial<EditConflictError>;
  return (
    statusCode === 409 &&
    (code === "REVISION_CONFLICT" || code === "EDIT_LOCKED")
  );
}
