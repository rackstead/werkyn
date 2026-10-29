export type SaveStatus = "saved" | "pending" | "saving" | "error";

export interface SaveSnapshot<T> {
  status: SaveStatus;
  error: Error | null;
  /** Unsaved fields of the live editing session: queued, being sent or failed. */
  draft: T | undefined;
  hasUnsavedChanges: boolean;
  /**
   * Unsaved fields whose editing session ended (or lost the right to save)
   * before they were stored. They are never sent automatically: the user
   * restores or discards them.
   */
  parked: T | undefined;
  /**
   * The server refused the parked changes because the stored document had
   * changed since they were based on it, or another user holds its lock.
   * Cleared when they are restored or discarded.
   */
  conflict: Error | null;
}

export interface AutosavePolicy {
  /** Why nothing may be sent right now (for example, no page lock), or null. */
  canSave: () => string | null;
  /** Whether automatic flushes may resend a draft whose last attempt failed. */
  retryFailedAutomatically: boolean;
  /**
   * Whether a failed save conflicts with newer stored content (or another
   * user's lock). Its draft is then set aside instead of being retried.
   */
  isConflict?: (error: Error) => boolean;
}

/**
 * Sends one patch. `baseRevision` is the stored revision the patch is based
 * on (undefined when the server reports none); the save resolves to the
 * stored revision it produced, when known.
 */
export type SaveFn<T> = (
  patch: T,
  baseRevision: number | undefined,
) => Promise<number | void>;

export interface AutosaveCallbacks {
  /** A save attempt failed while an editor was open. */
  onError: (error: Error, retry: () => Promise<void>) => void;
  /** Nothing is queued, retained or open; the queue can be forgotten. */
  onIdle: () => void;
  /** Every retained change was stored. */
  onSaved: () => void;
  /** Unsaved changes were set aside; `closed` when no editor is open. */
  onParked: (closed: boolean) => void;
}

/** Rejects a flush that was not allowed to send anything. */
export class AutosaveBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutosaveBlockedError";
  }
}

/** Serializes one entity's patches; newer fields replace older queued fields. */
export class AutosaveQueue<T extends object> {
  private pending: T | undefined;
  private inFlight: T | undefined;
  private parked: T | undefined;
  // The pending fields include a draft whose last attempt failed or was blocked.
  private failed = false;
  private conflict: Error | null = null;
  // The stored revision the queued changes are based on: the revision the
  // editor showed when it had nothing unsaved, then each save's own result.
  private baseRevision: number | undefined;
  private observedRevision: number | undefined;
  private observedWhileDirty = false;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private policy: AutosavePolicy = {
    canSave: () => null,
    retryFailedAutomatically: true,
  };
  private snapshot: SaveSnapshot<T> = {
    status: "saved",
    error: null,
    draft: undefined,
    hasUnsavedChanges: false,
    parked: undefined,
    conflict: null,
  };

  constructor(
    private save: SaveFn<T>,
    private delay: number,
    private callbacks: AutosaveCallbacks,
  ) {}

  setSave(save: SaveFn<T>) {
    this.save = save;
  }

  /**
   * Reports the stored revision the entity's query now holds. While nothing is
   * unsaved the editor shows that document, so edits are based on it. Like the
   * editors, the first value seen after unsaved changes were stored is not
   * taken: it can be older than this queue's own last save.
   */
  observeRevision = (revision: number | undefined) => {
    if (revision === undefined) return;
    if (this.snapshot.hasUnsavedChanges) {
      this.observedWhileDirty = true;
      return;
    }
    if (this.observedWhileDirty) {
      this.observedWhileDirty = false;
      this.observedRevision = revision;
      return;
    }
    if (revision === this.observedRevision) return;
    this.observedRevision = revision;
    this.baseRevision = revision;
  };

  /**
   * The editor was just reset to the stored document of `revision` (for
   * example remounted after a conflict); later edits are based on it.
   */
  adoptRevision = (revision: number | undefined) => {
    if (revision === undefined || this.snapshot.hasUnsavedChanges) return;
    this.observedWhileDirty = false;
    this.observedRevision = revision;
    this.baseRevision = revision;
  };

  /**
   * A write of this entity made outside the queue (for example a rename from
   * the page tree) produced `revision`. When that is the revision right after
   * the base, nothing else was written in between, so later saves are based
   * on it instead of being refused for this client's own change.
   */
  acknowledgeRevision = (revision: number | undefined) => {
    if (revision === undefined || this.baseRevision === undefined) return;
    if (this.inFlight || revision !== this.baseRevision + 1) return;
    this.baseRevision = revision;
    this.observedRevision = revision;
  };

  setPolicy(policy: AutosavePolicy) {
    this.policy = policy;
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      // A failed draft must not outlive its editor as something that is sent
      // automatically later; keep it for an explicit restore instead.
      if (this.snapshot.status === "error" && !this.running) this.park();
      else if (!this.snapshot.hasUnsavedChanges && !this.parked)
        this.callbacks.onIdle();
    };
  };

  private publish(
    status: SaveStatus,
    draft: T | undefined,
    error: Error | null = null,
  ) {
    this.snapshot = {
      status,
      draft,
      error,
      hasUnsavedChanges: status !== "saved",
      parked: this.parked,
      conflict: this.parked ? this.conflict : null,
    };
    for (const listener of this.listeners) listener();
    if (status === "saved" && !this.parked && !this.listeners.size)
      this.callbacks.onIdle();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Queues an edit made in the open editor. */
  schedule = (patch: T) => {
    // The user is editing the document that shows this draft, so it is live again.
    this.failed = false;
    this.pending = { ...this.pending, ...patch };
    this.publish(this.running ? "saving" : "pending", {
      ...this.snapshot.draft,
      ...patch,
    });
    this.clearTimer();
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, this.delay);
  };

  /**
   * Drops an unsent field, for example a title edited back to its saved value.
   * Returns false when that field is being saved right now; the caller should
   * then schedule a corrective value instead.
   */
  discard = (key: keyof T): boolean => {
    if (this.inFlight && key in this.inFlight) return false;
    if (!this.pending || !(key in this.pending)) return true;
    const pending = { ...this.pending };
    delete pending[key];
    this.pending = Object.keys(pending).length ? pending : undefined;
    const draft = this.snapshot.draft && { ...this.snapshot.draft };
    if (draft) delete draft[key];
    if (this.pending || this.running) {
      this.publish(this.snapshot.status, draft, this.snapshot.error);
    } else {
      this.clearTimer();
      this.failed = false;
      this.publish("saved", undefined);
      this.callbacks.onSaved();
    }
    return true;
  };

  /**
   * Sets unsent changes aside. They stay in this tab (and keep the unload
   * warning) but are only sent again through `restoreParked`.
   */
  park = () => {
    this.clearTimer();
    if (!this.pending) return;
    const closed = !this.listeners.size;
    this.parked = { ...this.parked, ...this.pending };
    this.pending = undefined;
    this.failed = false;
    // Only a request already on the wire can still be in progress.
    this.publish(this.inFlight ? "saving" : "saved", this.inFlight);
    this.callbacks.onParked(closed);
  };

  /** Puts set-aside changes back into the editor's queue and saves them. */
  restoreParked = (): Promise<void> => {
    if (!this.parked) return Promise.resolve();
    // The restored draft replaces whatever the reopened editor holds, which
    // after a conflict is the newer stored document.
    this.pending = { ...this.pending, ...this.parked } as T;
    this.parked = undefined;
    this.conflict = null;
    this.failed = false;
    this.publish(this.running ? "saving" : "pending", {
      ...this.snapshot.draft,
      ...this.pending,
    });
    return this.flush({ explicit: true });
  };

  discardParked = () => {
    if (!this.parked) return;
    this.parked = undefined;
    this.conflict = null;
    this.publish(
      this.snapshot.status,
      this.snapshot.draft,
      this.snapshot.error,
    );
    if (this.snapshot.status === "saved") this.callbacks.onSaved();
  };

  /** A user-requested attempt; it may resend a failed draft. */
  retry = () => this.flush({ explicit: true });

  flush = ({
    explicit = false,
  }: { explicit?: boolean } = {}): Promise<void> => {
    this.clearTimer();
    if (this.running) return this.running;
    if (!this.pending) return Promise.resolve();
    if (this.failed && !explicit && !this.policy.retryFailedAutomatically) {
      return Promise.reject(
        new AutosaveBlockedError(
          "These changes were not saved. Retry them first.",
        ),
      );
    }

    // Begin in a microtask so even an immediately failing save retains running's identity.
    this.running = Promise.resolve()
      .then(async () => {
        while (this.pending) {
          const blocked = this.policy.canSave();
          if (blocked) {
            this.failed = true;
            const error = new AutosaveBlockedError(blocked);
            this.publish("error", this.snapshot.draft ?? this.pending, error);
            if (!this.listeners.size) this.park();
            throw error;
          }
          const patch = this.pending;
          this.pending = undefined;
          this.publish("saving", this.snapshot.draft);
          this.inFlight = patch;
          try {
            const revision = await this.save(patch, this.baseRevision);
            if (typeof revision === "number") this.baseRevision = revision;
          } catch (cause) {
            this.inFlight = undefined;
            this.pending = Object.assign({}, patch, this.pending) as T;
            const error =
              cause instanceof Error
                ? cause
                : new Error("Changes could not be saved");
            if (this.policy.isConflict?.(error)) {
              // Sending these changes again would be refused again, or replace
              // newer content: only an explicit restore sends them.
              this.conflict = error;
              this.park();
              throw error;
            }
            this.failed = true;
            this.publish("error", this.snapshot.draft ?? this.pending, error);
            if (this.listeners.size) this.callbacks.onError(error, this.retry);
            else this.park();
            throw error;
          } finally {
            this.inFlight = undefined;
          }
        }
        this.failed = false;
        this.publish("saved", undefined);
        this.callbacks.onSaved();
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  };
}
