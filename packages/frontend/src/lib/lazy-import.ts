import { createElement, use, type ComponentProps, type ComponentType } from "react";

// Error messages browsers give when a dynamic import cannot be fetched or
// evaluated, plus Vite's own when a lazy chunk's stylesheet fails to load.
// After a deploy, a tab still running the previous build asks for chunk files
// that no longer exist and gets one of these.
const CHUNK_LOAD_ERROR_MESSAGES = [
  "Failed to fetch dynamically imported module", // Chromium
  "error loading dynamically imported module", // Firefox
  "Importing a module script failed", // Safari
  "Unable to preload CSS", // Vite preload helper
];

/** Whether an error means a lazily loaded part of the app failed to load. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : undefined;
  if (typeof message !== "string") return false;
  return CHUNK_LOAD_ERROR_MESSAGES.some((text) => message.includes(text));
}

export type PreloadableComponent<P> = ComponentType<P> & {
  /**
   * Fetches the chunk once. Resolves (never rejects) when it has settled; a
   * failure is thrown where the component renders, for an error boundary.
   */
  preload: () => Promise<void>;
};

/**
 * A component loaded from a separate chunk on first render, which suspends
 * until then (wrap it in Suspense). Unlike React.lazy, once `preload` has
 * finished it renders immediately, so a view can fetch it ahead of time (for
 * example when the page that shows it mounts) without a fallback flash.
 */
export function lazyNamed<
  M extends Record<K, ComponentType<any>>,
  K extends keyof M,
>(load: () => Promise<M>, name: K): PreloadableComponent<ComponentProps<M[K]>> {
  type Props = ComponentProps<M[K]>;
  let component: ComponentType<Props> | undefined;
  let failure: { error: unknown } | undefined;
  let loading: Promise<void> | undefined;
  const preload = () =>
    (loading ??= load().then(
      (module) => {
        component = module[name] as ComponentType<Props>;
      },
      (error: unknown) => {
        failure = { error };
      },
    ));

  function LazyComponent(props: Props) {
    if (!component && !failure) use(preload());
    if (failure) throw failure.error;
    return createElement(component!, props);
  }
  LazyComponent.displayName = `Lazy(${String(name)})`;
  return Object.assign(LazyComponent, { preload });
}

/** Runs `task` once the browser is idle, or after `timeout` ms at the latest. */
export function whenIdle(task: () => void, timeout = 2000): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(task, { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(task, Math.min(timeout, 200));
  return () => window.clearTimeout(id);
}
