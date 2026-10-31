import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth-store";
import { usePdfPreview } from "./use-pdf-preview";
import { changeIdentity } from "@/lib/identity";
const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ api: { post } }));
const alice = {
  id: "alice",
  email: "alice@example.test",
  displayName: "Alice",
  avatarUrl: null,
  jobTitle: null,
  phone: null,
  timezone: null,
  emailVerified: true,
};
const bob = {
  ...alice,
  id: "bob",
  email: "bob@example.test",
  displayName: "Bob",
};
const oldRefresh = useAuthStore.getState().refresh;
const refresh = vi.fn<() => Promise<boolean>>();
let pending: Array<{
  signal: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}>;
function grant(
  token = "preview-grant",
  duration = 300_000,
  sourceDuration = 900_000,
) {
  return {
    data: {
      token,
      expiresAt: Date.now() + duration,
      sourceExpiresAt: Date.now() + sourceDuration,
    },
  };
}
async function answer(index: number, value = grant()) {
  await act(async () => {
    pending[index].resolve(value);
    await Promise.resolve();
    await Promise.resolve();
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
  vi.stubEnv("VITE_API_BASE_URL", "");
  pending = [];
  post.mockReset();
  post.mockImplementation((_path, { signal }) => ({
    json: () =>
      new Promise((resolve, reject) =>
        pending.push({ signal, resolve, reject }),
      ),
  }));
  refresh.mockReset();
  refresh.mockResolvedValue(false);
  useAuthStore.setState({
    user: alice,
    accessToken: "alice-access-jwt",
    workspaces: [],
    refresh,
  });
});
afterEach(() => {
  cleanup();
  useAuthStore.setState({
    user: null,
    accessToken: null,
    workspaces: [],
    refresh: oldRefresh,
  });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("stable native PDF preview grants", () => {
  it.each(["", "/custom/api/", "https://api.example.test/v1/"])(
    "uses scoped URL and API base %s without an access JWT",
    async (base) => {
      vi.stubEnv("VITE_API_BASE_URL", base);
      const { result } = renderHook(() =>
        usePdfPreview("workspace-1", "file-1"),
      );
      expect(result.current.isLoading).toBe(true);
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toBe(
        "workspaces/workspace-1/files/file-1/preview-grant",
      );
      await answer(0, grant("narrow-preview"));
      const prefix = base ? base.replace(/\/+$/, "") : "/api";
      expect(result.current.url).toBe(
        `${prefix}/workspaces/workspace-1/files/file-1/preview?token=narrow-preview`,
      );
      expect(result.current.url).not.toContain("alice-access-jwt");
      expect(result.current.error).toBeNull();
    },
  );
  it("does not acquire a grant while disabled or signed out", () => {
    const view = renderHook(({ fid }) => usePdfPreview("workspace-1", fid), {
      initialProps: { fid: null as string | null },
    });
    expect(post).not.toHaveBeenCalled();
    act(() => useAuthStore.setState({ user: null, accessToken: null }));
    view.rerender({ fid: "file-1" });
    expect(post).not.toHaveBeenCalled();
    expect(view.result.current.url).toBeUndefined();
  });
  it("aborts old resource work and ignores its late response", async () => {
    const view = renderHook(({ fid }) => usePdfPreview("workspace-1", fid), {
      initialProps: { fid: "file-1" },
    });
    view.rerender({ fid: "file-2" });
    expect(pending[0].signal.aborted).toBe(true);
    await answer(1, grant("file-2"));
    await answer(0, grant("file-1"));
    expect(view.result.current.url).toContain("/file-2/preview?token=file-2");
    expect(post).toHaveBeenCalledTimes(2);
  });
  it("removes the old identity's URL on account switch and logout", async () => {
    const { result } = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    await answer(0, grant("alice"));
    act(() =>
      useAuthStore.setState({ user: bob, accessToken: "bob-access-jwt" }),
    );
    expect(pending[0].signal.aborted).toBe(true);
    expect(result.current.url).toBeUndefined();
    await answer(1, grant("bob"));
    expect(result.current.url).toContain("bob");
    act(() => useAuthStore.setState({ user: null, accessToken: null }));
    expect(result.current.url).toBeUndefined();
  });
  it("discards a batched departure and return to the same user", async () => {
    const { result } = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    act(() => {
      changeIdentity("alice", "bob");
      changeIdentity("bob", "alice");
    });
    expect(pending[0].signal.aborted).toBe(true);
    await answer(1, grant("returned-identity"));
    await answer(0, grant("departed-identity"));
    expect(result.current.url).toContain("returned-identity");
  });
  it("unmount cancels pending acquisition with no later work", async () => {
    const view = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    view.unmount();
    expect(pending[0].signal.aborted).toBe(true);
    await answer(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000_000);
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
  it("keeps the loaded URL after expiry, focus and same-user token rotation", async () => {
    const { result } = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    await answer(0, grant("stable"));
    const url = result.current.url;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_800_000);
    });
    act(() =>
      useAuthStore.setState({ accessToken: "alice-rotated-access-jwt" }),
    );
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current.url).toBe(url);
    expect(post).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    act(() => result.current.retry());
    expect(post).toHaveBeenCalledTimes(2);
    expect(result.current.url).toBeUndefined();
    await answer(1, grant("deliberate-reload"));
    expect(result.current.url).toContain("deliberate-reload");
  });
  it("refreshes a near-expiry source once before exposing any URL", async () => {
    refresh.mockImplementation(async () => {
      useAuthStore.setState({ accessToken: "alice-fresh" });
      return true;
    });
    const { result } = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    await answer(0, grant("too-short", 20_000, 20_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(result.current.url).toBeUndefined();
    await answer(1, grant("fresh-preview"));
    expect(result.current.url).toContain("fresh-preview");
  });
  it("renews a grant made too short by slow initial acquisition", async () => {
    refresh.mockImplementation(async () => {
      useAuthStore.setState({ accessToken: "fresh-after-delay" });
      return true;
    });
    const { result } = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    const delayed = grant("delayed", 35_000, 35_000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    await answer(0, delayed);
    expect(result.current.url).toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);
    await answer(1, grant("usable-after-delay"));
    expect(result.current.url).toContain("usable-after-delay");
  });
  it("adopts a concurrent fresh token without a second cookie refresh", async () => {
    const { result } = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    act(() =>
      useAuthStore.setState({ accessToken: "alice-concurrently-refreshed" }),
    );
    await answer(0, grant("old-source", 20_000, 20_000));
    expect(refresh).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(2);
    await answer(1, grant("new-source"));
    expect(result.current.url).toContain("new-source");
  });
  it("stops if refresh returns the same token or a second short grant", async () => {
    refresh.mockResolvedValue(true);
    const view = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    await answer(0, grant("short", 20_000, 20_000));
    expect(view.result.current.error).toBeTruthy();
    expect(view.result.current.url).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    view.unmount();
    refresh.mockImplementation(async () => {
      useAuthStore.setState({ accessToken: "new-short-source" });
      return true;
    });
    const second = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    await answer(1, grant("short2", 20_000, 20_000));
    await answer(2, grant("still-short", 20_000, 20_000));
    expect(second.result.current.error).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it("surfaces acquisition or frame errors and retries only on request", async () => {
    const { result } = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    await act(async () => {
      pending[0].reject(new Error("Fixture network failure"));
    });
    expect(result.current.error).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(post).toHaveBeenCalledTimes(1);
    act(() => result.current.retry());
    await answer(1, grant("retry"));
    expect(result.current.url).toContain("retry");
    act(() => result.current.reportFrameError());
    expect(result.current.error).toBeTruthy();
    expect(result.current.url).toBeUndefined();
  });
});
