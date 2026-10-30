import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isChunkLoadError, lazyNamed } from "./lazy-import";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { Route as RootRoute } from "@/routes/__root";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function Greeting({ name }: { name: string }) {
  return <p>Hello {name}</p>;
}

const chromiumChunkError = () =>
  new TypeError(
    "Failed to fetch dynamically imported module: https://app.example/assets/board-OLD123.js",
  );

const originalLocation = window.location;
function stubReload() {
  const reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, reload },
  });
  return reload;
}

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  vi.restoreAllMocks();
});

describe("isChunkLoadError", () => {
  it("recognizes failed dynamic imports in each browser and Vite's stylesheet preload", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://app.example/assets/a.js",
      "error loading dynamically imported module: https://app.example/assets/a.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/wiki-editor-abc.css",
    ]) {
      expect(isChunkLoadError(new TypeError(message)), message).toBe(true);
    }
  });

  it("does not treat other failures as a stale deploy", () => {
    expect(isChunkLoadError(new Error("Request failed with status 500"))).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe("lazyNamed", () => {
  it("suspends until its chunk loads, then renders the export with its props", async () => {
    const chunk = deferred<{ Greeting: typeof Greeting }>();
    const load = vi.fn(() => chunk.promise);
    const LazyGreeting = lazyNamed(load, "Greeting");

    // A component suspended on use() only retries inside an awaited act().
    await act(async () => {
      render(
        <Suspense fallback={<p>Loading</p>}>
          <LazyGreeting name="Ada" />
        </Suspense>,
      );
    });
    expect(screen.getByText("Loading")).toBeTruthy();
    void LazyGreeting.preload();

    await act(async () => chunk.resolve({ Greeting }));
    expect(screen.getByText("Hello Ada")).toBeTruthy();
    // Render and preload share one request for the chunk.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("renders without a fallback once preloaded", async () => {
    const LazyGreeting = lazyNamed(async () => ({ Greeting }), "Greeting");
    await LazyGreeting.preload();

    render(
      <Suspense fallback={<p>Loading</p>}>
        <LazyGreeting name="Grace" />
      </Suspense>,
    );
    expect(screen.queryByText("Loading")).toBeNull();
    expect(screen.getByText("Hello Grace")).toBeTruthy();
  });

  it("reports a chunk that fails to load to the error boundary, which offers a reload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = stubReload();
    const LazyGreeting = lazyNamed(
      (): Promise<{ Greeting: typeof Greeting }> => Promise.reject(chromiumChunkError()),
      "Greeting",
    );
    // Preloading never rejects; the failure surfaces where the component renders.
    await expect(LazyGreeting.preload()).resolves.toBeUndefined();

    render(
      <ErrorBoundary>
        <Suspense fallback={<p>Loading</p>}>
          <LazyGreeting name="Ada" />
        </Suspense>
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "A new version of Werkyn is available",
    );
    // Trying again could not help: the old chunk is gone until the page reloads.
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("error screens", () => {
  it("the workspace error boundary still offers Try again for other errors", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Broken(): never {
      throw new Error("Widget exploded");
    }
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Widget exploded")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("the root error screen offers a reload when a route chunk failed to load", () => {
    const reload = stubReload();
    const RootError = RootRoute.options.errorComponent as (props: {
      error: Error;
    }) => React.ReactNode;

    const { unmount } = render(<>{RootError({ error: chromiumChunkError() })}</>);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
    unmount();

    render(<>{RootError({ error: new Error("Unexpected") })}</>);
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("Unexpected")).toBeTruthy();
  });
});
