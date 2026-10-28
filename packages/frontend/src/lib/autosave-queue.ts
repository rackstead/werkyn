export type SaveStatus = "saved" | "pending" | "saving" | "error";

export interface SaveSnapshot<T> {
  status: SaveStatus;
  error: Error | null;
  // Retain the draft after a failure or an editor unmount so reopening can retry it.
  draft: T | undefined;
  hasUnsavedChanges: boolean;
}

/** Serializes one entity's patches; newer fields replace older queued fields. */
export class AutosaveQueue<T extends object> {
  private pending: T | undefined;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: SaveSnapshot<T> = {
    status: "saved",
    error: null,
    draft: undefined,
    hasUnsavedChanges: false,
  };

  constructor(
    private save: (patch: T) => Promise<unknown>,
    private delay: number,
    private onError: (error: Error, retry: () => Promise<void>) => void,
    private onIdle: () => void,
    private onSaved: () => void = () => {},
  ) {}

  setSave(save: (patch: T) => Promise<unknown>) {
    this.save = save;
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && !this.snapshot.hasUnsavedChanges)
        this.onIdle();
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
    };
    for (const listener of this.listeners) listener();
    if (status === "saved" && !this.listeners.size) this.onIdle();
  }

  schedule = (patch: T) => {
    this.pending = { ...this.pending, ...patch };
    this.publish(this.running ? "saving" : "pending", {
      ...this.snapshot.draft,
      ...patch,
    });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, this.delay);
  };

  flush = (): Promise<void> => {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) return this.running;
    if (!this.pending) return Promise.resolve();

    // Begin in a microtask so even an immediately failing save retains running's identity.
    this.running = Promise.resolve()
      .then(async () => {
        while (this.pending) {
          const patch = this.pending;
          this.pending = undefined;
          this.publish("saving", this.snapshot.draft);
          try {
            await this.save(patch);
          } catch (cause) {
            this.pending = Object.assign({}, patch, this.pending) as T;
            const error =
              cause instanceof Error
                ? cause
                : new Error("Changes could not be saved");
            this.publish("error", this.snapshot.draft ?? this.pending, error);
            this.onError(error, this.flush);
            throw error;
          }
        }
        this.publish("saved", undefined);
        this.onSaved();
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  };
}
