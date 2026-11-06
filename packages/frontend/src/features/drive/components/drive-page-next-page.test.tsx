import type { ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-error";
import { useAuthStore } from "@/stores/auth-store";
import { DrivePage } from "./drive-page";

// The folder lists 100 files in two pages; the second is refused once with
// 429 (the server's per-address request limit), asking for a short wait.
const net = vi.hoisted(() => ({
  listings: [] as string[],
  refusals: 0,
  retryAfterMs: 50 as number | undefined,
}));
const file = (i: number) => ({
  id: `file-${i}`,
  workspaceId: "w",
  parentId: null,
  name: `File ${i}.txt`,
  isFolder: false,
  mimeType: "text/plain",
  size: 10,
  starred: false,
  thumbnailPath: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  uploadedBy: { id: "u-1", displayName: "Ana", avatarUrl: null },
});
vi.mock("@/lib/api-client", async () => {
  const { ApiError } = await import("@/lib/api-error");
  return {
    api: {
      get: (url: string) => ({
        json: () => {
          if (url.includes("team-folders") || url.includes("share-status")) return Promise.resolve({ data: [] });
          const cursor = new URLSearchParams(url.split("?")[1]).get("cursor");
          net.listings.push(cursor ?? "first");
          if (!cursor)
            return Promise.resolve({ data: Array.from({ length: 50 }, (_, i) => file(i + 1)), nextCursor: "c1" });
          if (net.refusals > 0) {
            net.refusals--;
            const error = new ApiError(429, "Too Many Requests", "Rate limit exceeded, retry in 1 seconds");
            error.retryAfterMs = net.retryAfterMs;
            return Promise.reject(error);
          }
          return Promise.resolve({ data: Array.from({ length: 50 }, (_, i) => file(i + 51)), nextCursor: null });
        },
      }),
    },
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./file-preview-slideover", () => new Promise(() => {}));

// The end of the list coming into view.
const observers = new Set<(entries: Array<{ isIntersecting: boolean }>) => void>();
function endInView() {
  act(() => {
    for (const callback of observers) callback([{ isIntersecting: true }]);
  });
}

let client: QueryClient;
function Providers({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const renderPage = () =>
  render(
    <DrivePage
      workspaceId="w"
      workspaceSlug="acme"
      view="list"
      trash={false}
      section="drive"
      onNavigate={vi.fn()}
      onViewChange={vi.fn()}
      onTrashToggle={vi.fn()}
    />,
    { wrapper: Providers },
  );

beforeEach(() => {
  net.listings = [];
  net.refusals = 1;
  net.retryAfterMs = 50;
  observers.clear();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback: (entries: Array<{ isIntersecting: boolean }>) => void;
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        this.callback = callback;
      }
      observe() {
        observers.add(this.callback);
      }
      disconnect() {
        observers.delete(this.callback);
      }
    },
  );
  useAuthStore.setState({
    user: { id: "u-1" } as never,
    workspaces: [{ role: "MEMBER", workspace: { id: "w", slug: "acme" } }] as never,
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a next page that fails to load", () => {
  it("keeps the entries loaded, waits as the server asks and loads the page then", async () => {
    renderPage();
    await screen.findByText("File 1.txt");
    endInView();
    await screen.findByText(/Couldn't load more files\./);
    // The list stays, without the full-page error.
    expect(screen.getByText("File 50.txt")).toBeTruthy();
    expect(screen.queryByText("Failed to load files")).toBeNull();
    // While waiting, the end of the list coming into view does not ask again.
    endInView();
    expect(net.listings).toEqual(["first", "c1"]);
    // After the wait, the page is asked for again and shown.
    await screen.findByText("File 51.txt");
    expect(net.listings).toEqual(["first", "c1", "c1"]);
    expect(screen.queryByText(/Couldn't load more files/)).toBeNull();
  });

  it("asks again at once from Try again, and backs off without Retry-After", async () => {
    net.retryAfterMs = undefined;
    net.refusals = 1;
    renderPage();
    await screen.findByText("File 1.txt");
    endInView();
    await screen.findByText(/Couldn't load more files\. Trying again in 2 s\./);
    act(() => screen.getByRole("button", { name: "Try again" }).click());
    await screen.findByText("File 51.txt");
    await waitFor(() => expect(net.listings).toEqual(["first", "c1", "c1"]));
  });
});
