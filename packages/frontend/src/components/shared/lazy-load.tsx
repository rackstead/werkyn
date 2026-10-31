// Shown instead of a generic error when part of the app could not be loaded,
// usually because a new version was deployed while this tab was open and the
// files it asks for were replaced. Reloading fetches the current version.
// Kept free of UI-kit imports: the root error screen uses it from the entry chunk.
export function ChunkLoadErrorNotice({ fullScreen = false }: { fullScreen?: boolean }) {
  return (
    <div
      role="alert"
      className={
        fullScreen
          ? "flex min-h-screen items-center justify-center p-8"
          : "flex flex-col items-center justify-center p-8"
      }
    >
      <div className="max-w-md space-y-3 text-center">
        <h2 className="text-lg font-semibold">A new version of Werkyn is available</h2>
        <p className="text-sm text-muted-foreground">
          Part of the app could not be loaded, usually because it was updated while this
          page was open. Reload the page to continue.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

/** Shown while a lazily loaded route or panel is being fetched. */
export function LoadingSpinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" className="flex flex-1 items-center justify-center p-8">
      <div
        aria-hidden="true"
        className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"
      />
      <span className="sr-only">{label}</span>
    </div>
  );
}
