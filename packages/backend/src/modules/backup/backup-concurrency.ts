import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../utils/errors.js";

/**
 * How many backup requests (export, preview and restore) one server process
 * accepts at a time (see docs/remediation/b03-backup-transport.md).
 */
export const BACKUP_CONCURRENCY_LIMITS = Object.freeze({
  /** Requests for one workspace, from admission until the handler returns. */
  perWorkspace: 1,
  /**
   * Requests in the whole process. Each may hold one staged file of up to
   * BACKUP_UPLOAD_LIMITS.maxBytes on disk while it uploads or downloads.
   */
  global: 3,
  /** Seconds a refused client is asked to wait before trying again. */
  retryAfterSeconds: 30,
});

export interface BackupConcurrencyLimits {
  perWorkspace: number;
  global: number;
  retryAfterSeconds: number;
}

export const WORKSPACE_BUSY_MESSAGE =
  "A backup export or restore is already running for this workspace. Try again shortly.";
export const SERVER_BUSY_MESSAGE =
  "The server is running other backup exports or restores. Try again shortly.";

/** A refused admission: 429 for this workspace, 503 for the whole server. */
export class BackupBusyError extends AppError {
  constructor(
    readonly scope: "workspace" | "server",
    readonly retryAfter: number,
  ) {
    super(
      scope === "workspace" ? 429 : 503,
      scope === "workspace" ? "Too Many Requests" : "Service Unavailable",
      scope === "workspace" ? WORKSPACE_BUSY_MESSAGE : SERVER_BUSY_MESSAGE,
    );
  }
}

/** The client went away before the exclusive work started. */
export class BackupRequestAbortedError extends AppError {
  constructor() {
    super(400, "Bad Request", "The backup request was cancelled");
  }
}

/**
 * Admission per workspace and per process, plus one exclusive section.
 *
 * Admission is refused at once rather than queued, so a client never waits
 * without knowing why. The exclusive section is where a request parses,
 * validates and restores `backup.json`, or builds an export. Those are the
 * steps whose memory the SEC-028 budget bounds for a single request, so
 * admitted requests take turns there in arrival order. Transfers (upload to a
 * staged file, download from one) run outside it.
 */
export class BackupConcurrency {
  private readonly perWorkspace = new Map<string, number>();
  private admitted = 0;
  private tail: Promise<void> = Promise.resolve();
  private exclusiveRunning = 0;

  constructor(readonly limits: BackupConcurrencyLimits = BACKUP_CONCURRENCY_LIMITS) {}

  /** Admit one request for `workspaceId` or throw BackupBusyError. */
  admit(workspaceId: string): () => void {
    const current = this.perWorkspace.get(workspaceId) ?? 0;
    if (current >= this.limits.perWorkspace) {
      throw new BackupBusyError("workspace", this.limits.retryAfterSeconds);
    }
    if (this.admitted >= this.limits.global) {
      throw new BackupBusyError("server", this.limits.retryAfterSeconds);
    }
    this.perWorkspace.set(workspaceId, current + 1);
    this.admitted++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.admitted--;
      const left = (this.perWorkspace.get(workspaceId) ?? 1) - 1;
      if (left > 0) this.perWorkspace.set(workspaceId, left);
      else this.perWorkspace.delete(workspaceId);
    };
  }

  /**
   * Run `work` once every earlier exclusive section has finished. If `signal`
   * is aborted by the time this request's turn comes, `work` never starts.
   */
  async exclusive<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tail;
    let finish!: () => void;
    this.tail = new Promise<void>((resolve) => (finish = resolve));
    try {
      await previous;
      if (signal?.aborted) throw new BackupRequestAbortedError();
      this.exclusiveRunning++;
      try {
        return await work();
      } finally {
        this.exclusiveRunning--;
      }
    } finally {
      finish();
    }
  }

  /** Current use, for tests and diagnostics. */
  get usage() {
    return {
      admitted: this.admitted,
      workspaces: this.perWorkspace.size,
      exclusiveRunning: this.exclusiveRunning,
    };
  }
}

/** The limits every backup route in this process shares. */
export const backupConcurrency = new BackupConcurrency();

/**
 * A signal that aborts when the client closes the connection before the
 * response has been sent in full.
 */
export function clientAbortSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  const response = reply.raw;
  // Node marks the response destroyed when its connection closes; "close"
  // has then already been emitted.
  if (response.destroyed) {
    if (!response.writableFinished) controller.abort();
  } else {
    response.once("close", () => {
      if (!response.writableFinished) controller.abort();
    });
  }
  return controller.signal;
}

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * Admit the request for its `:wid` before `handler` reads anything, and hold
 * the admission until the handler settles. A handler that streams a response
 * settles only once that stream has ended or been destroyed, so an admission
 * is released on success, on error and when the client goes away.
 */
export function limitBackupRequests(
  handler: Handler,
  concurrency: BackupConcurrency = backupConcurrency,
): Handler {
  return async (request, reply) => {
    const { wid } = request.params as { wid: string };
    let release: () => void;
    try {
      release = concurrency.admit(wid);
    } catch (error) {
      if (error instanceof BackupBusyError) {
        reply.header("Retry-After", String(error.retryAfter));
        request.log.warn({ scope: error.scope }, "Refused a backup request over the concurrency limit");
      }
      throw error;
    }
    try {
      return await handler(request, reply);
    } finally {
      release();
    }
  };
}
