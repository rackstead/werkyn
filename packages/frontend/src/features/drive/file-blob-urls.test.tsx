import { StrictMode, useState, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "@/lib/query-client";
import { clearFileContentCache, useFilePreviewUrl, useThumbnailUrl, type DriveFile } from "./api";
import { FilePreviewSlideover } from "./components/file-preview-slideover";

// jsdom has no object URL registry; this one records every URL's lifetime.
const registry = {
  created: [] as string[],
  revoked: [] as string[],
  live: new Set<string>(),
};
const original = {
  create: URL.createObjectURL,
  revoke: URL.revokeObjectURL,
};
let fetchMock: ReturnType<typeof vi.fn>;
let client: QueryClient;

beforeEach(() => {
  registry.created = [];
  registry.revoked = [];
  registry.live.clear();
  let n = 0;
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:test/${++n}`;
    registry.created.push(url);
    registry.live.add(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    registry.revoked.push(url);
    registry.live.delete(url);
  });
  fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    blob: async () => new Blob([url]),
    text: async () => url,
  }));
  vi.stubGlobal("fetch", fetchMock);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(() => {
  URL.createObjectURL = original.create;
  URL.revokeObjectURL = original.revoke;
});

/** Every URL revoked was created, none twice, and none is still registered. */
function expectBackToBaseline() {
  expect(new Set(registry.revoked).size).toBe(registry.revoked.length);
  expect([...registry.revoked].sort()).toEqual([...registry.created].sort());
  expect(registry.live.size).toBe(0);
}

const liveSrc = (img: HTMLElement) => {
  const src = img.getAttribute("src")!;
  expect(registry.live.has(src)).toBe(true);
  return src;
};

function Providers({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const image = (id: string) =>
  ({
    id,
    workspaceId: "w",
    name: `${id}.png`,
    mimeType: "image/png",
    size: 10,
    updatedAt: "2026-10-01T00:00:00Z",
    uploadedBy: { displayName: "Alice" },
  }) as unknown as DriveFile;

function Preview({ fileId }: { fileId: string | null }) {
  return fileId ? (
    <FilePreviewSlideover file={image(fileId)} workspaceId="w" onClose={vi.fn()} onDownload={vi.fn()} />
  ) : null;
}

function Thumbnail({ fileId }: { fileId: string }) {
  const { data: url } = useThumbnailUrl("w", fileId, true);
  return url ? <img src={url} alt={`thumbnail ${fileId}`} /> : null;
}

describe("file preview object URLs", () => {
  it("shows a live URL when the same file is previewed again from the cache", async () => {
    const { rerender } = render(<Preview fileId="a" />, { wrapper: Providers });
    liveSrc(await screen.findByRole("img", { name: "a.png" }));

    rerender(<Preview fileId={null} />);
    rerender(<Preview fileId="a" />);
    liveSrc(await screen.findByRole("img", { name: "a.png" }));
    // The second preview came from the cache rather than a second download.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender(<Preview fileId={null} />);
    expectBackToBaseline();
  });

  it("revokes each previous image once when switching files and never shows a revoked one", async () => {
    const { rerender } = render(<Preview fileId="a" />, { wrapper: Providers });
    const first = liveSrc(await screen.findByRole("img", { name: "a.png" }));

    rerender(<Preview fileId="b" />);
    liveSrc(await screen.findByRole("img", { name: "b.png" }));
    expect(registry.revoked).toEqual([first]);

    rerender(<Preview fileId="a" />);
    liveSrc(await screen.findByRole("img", { name: "a.png" }));

    rerender(<Preview fileId={null} />);
    expectBackToBaseline();
  });

  it("never hands a component a URL that is already revoked", async () => {
    const rendered: Array<{ url: string | undefined; revoked: boolean }> = [];
    function Probe({ fileId }: { fileId: string | null }) {
      const { data: url } = useFilePreviewUrl("w", fileId, "image/png");
      rendered.push({ url, revoked: !!url && !registry.live.has(url) });
      return null;
    }
    const { rerender, unmount } = render(<Probe fileId="a" />, { wrapper: Providers });
    await waitFor(() => expect(rendered.at(-1)?.url).toBeTruthy());
    rerender(<Probe fileId={null} />);
    rerender(<Probe fileId="a" />);
    await waitFor(() => expect(rendered.at(-1)?.url).toBeTruthy());
    rerender(<Probe fileId="b" />);
    await waitFor(() => expect(rendered.at(-1)?.url).toBeTruthy());
    unmount();
    expect(rendered.filter((r) => r.revoked)).toEqual([]);
    expectBackToBaseline();
  });

  it("keeps an open preview loadable when the cache is cleared under it", async () => {
    const { rerender } = render(<Preview fileId="a" />, { wrapper: Providers });
    const img = await screen.findByRole("img", { name: "a.png" });
    act(() => client.clear());
    liveSrc(img);
    rerender(<Preview fileId={null} />);
    expectBackToBaseline();
  });

  it("revokes each URL exactly once under StrictMode's double effects", async () => {
    const { unmount } = render(
      <StrictMode>
        <Preview fileId="a" />
      </StrictMode>,
      { wrapper: Providers },
    );
    liveSrc(await screen.findByRole("img", { name: "a.png" }));
    unmount();
    expectBackToBaseline();
  });
});

describe("thumbnail object URLs", () => {
  it("releases every thumbnail when its card unmounts, and eviction leaves nothing registered", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `f${i}`);
    const { unmount } = render(
      <>
        {ids.map((id) => (
          <Thumbnail key={id} fileId={id} />
        ))}
      </>,
      { wrapper: Providers },
    );
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(20));
    screen.getAllByRole("img").forEach(liveSrc);
    unmount();
    expectBackToBaseline();
    act(() => client.clear());
    expectBackToBaseline();
  });

  it("gives each observer of one file its own URL for as long as it is mounted", async () => {
    function Two() {
      const [both, setBoth] = useState(true);
      return (
        <>
          <button onClick={() => setBoth(false)}>hide one</button>
          <Thumbnail fileId="shared" />
          {both && <Thumbnail fileId="shared" />}
        </>
      );
    }
    const { unmount } = render(<Two />, { wrapper: Providers });
    await waitFor(() => expect(screen.getAllByRole("img", { name: "thumbnail shared" })).toHaveLength(2));
    act(() => screen.getByRole("button", { name: "hide one" }).click());
    const remaining = screen.getAllByRole("img", { name: "thumbnail shared" });
    expect(remaining).toHaveLength(1);
    liveSrc(remaining[0]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
    expectBackToBaseline();
  });
});

describe("cached file contents", () => {
  const cached = (qc: QueryClient, key: string) => qc.getQueryCache().findAll({ queryKey: [key] }).length;

  it("drops a closed preview's Blob a minute after it closes", async () => {
    const { rerender } = render(<Preview fileId="a" />, { wrapper: Providers });
    await screen.findByRole("img", { name: "a.png" });
    vi.useFakeTimers();
    rerender(<Preview fileId={null} />);
    expectBackToBaseline();
    expect(cached(client, "file-preview")).toBe(1);
    act(() => vi.advanceTimersByTime(61_000));
    expect(cached(client, "file-preview")).toBe(0);
  });

  it("clearFileContentCache drops thumbnails, previews and text so the next viewer downloads again", async () => {
    const { rerender } = render(<Preview fileId="a" />, { wrapper: Providers });
    await screen.findByRole("img", { name: "a.png" });
    rerender(<Preview fileId={null} />);
    client.setQueryData(["file-thumbnail", { wid: "w", fileId: "t" }], new Blob(["t"]));
    client.setQueryData(["file-text", { wid: "w", fileId: "t" }], "private text");
    client.setQueryData(["files", "unrelated"], { kept: true });

    clearFileContentCache(client);
    expect(["file-thumbnail", "file-preview", "file-text"].map((k) => cached(client, k))).toEqual([0, 0, 0]);
    expect(client.getQueryData(["files", "unrelated"])).toEqual({ kept: true });

    rerender(<Preview fileId="a" />);
    liveSrc(await screen.findByRole("img", { name: "a.png" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    rerender(<Preview fileId={null} />);
    expectBackToBaseline();
  });

  it("clearFileContentCache clears the application's query client by default", () => {
    queryClient.setQueryData(["file-preview", { wid: "w", fileId: "x" }], new Blob(["x"]));
    clearFileContentCache();
    expect(cached(queryClient, "file-preview")).toBe(0);
  });
});
