import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth-store";
import { usePdfPreview } from "./use-pdf-preview";

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

describe("native PDF preview grants", () => {
  it.each(["", "/custom/api/", "https://api.example.test/v1/"])(
    "uses scoped grant URLs with API base %s and no access JWT",
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
      await answer(0, grant("narrow-preview-grant"));
      const prefix = base ? base.replace(/\/+$/, "") : "/api";
      expect(result.current.url).toBe(
        `${prefix}/workspaces/workspace-1/files/file-1/preview?token=narrow-preview-grant`,
      );
      expect(result.current.url).not.toContain("alice-access-jwt");
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    },
  );
  it("does no issuance while disabled or signed out", () => {
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
    expect(view.result.current.url).toBeUndefined();
    await answer(1, grant("file-2-grant"));
    await answer(0, grant("file-1-grant"));
    expect(view.result.current.url).toContain(
      "/file-2/preview?token=file-2-grant",
    );
    expect(post).toHaveBeenCalledTimes(2);
  });
  it("clears the previous identity's URL immediately on account switch or logout", async () => {
    const { result } = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    await answer(0, grant("alice-preview"));
    act(() =>
      useAuthStore.setState({ user: bob, accessToken: "bob-access-jwt" }),
    );
    expect(pending[0].signal.aborted).toBe(true);
    expect(result.current.url).toBeUndefined();
    await answer(1, grant("bob-preview"));
    expect(result.current.url).toContain("bob-preview");
    act(() => useAuthStore.setState({ user: null, accessToken: null }));
    expect(result.current.url).toBeUndefined();
  });
  it("unmount cancels pending issuance and renewal timers", async () => {
    const first = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    first.unmount();
    expect(pending[0].signal.aborted).toBe(true);
    await answer(0);
    const second = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    await answer(1);
    second.unmount();
    expect(pending[1].signal.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000_000);
    });
    expect(post).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled();
  });
  it("renews a long-open preview before expiry without buffering the PDF", async () => {
    const { result } = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    await answer(0, grant("first"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(270_000);
    });
    expect(post).toHaveBeenCalledTimes(2);
    expect(result.current.url).toContain("first");
    await answer(1, grant("renewed"));
    expect(result.current.url).toContain("renewed");
    expect(refresh).not.toHaveBeenCalled();
  });
  it("adopts a fresh access token at a source-expiry-bound renewal", async () => {
    refresh.mockImplementation(async () => {
      useAuthStore.setState({ accessToken: "alice-fresh-access-jwt" });
      return true;
    });
    const { result } = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    await answer(0, grant("source-bound", 120_000, 120_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(result.current.url).toBeUndefined();
    await answer(1, grant("fresh-session-preview"));
    expect(result.current.url).toContain("fresh-session-preview");
    expect(result.current.url).not.toContain("alice-fresh-access-jwt");
  });
  it("does not loop if recent-refresh suppression returns the same almost-expired token", async () => {
    refresh.mockResolvedValue(true);
    const { result } = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    await answer(0, grant("near-expiry", 20_000, 20_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.url).toBeUndefined();
    expect(result.current.error).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("surfaces an error and retries only on explicit request", async () => {
    const { result } = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    await act(async () => {
      pending[0].reject(new Error("Fixture network failure"));
    });
    expect(result.current.error).toBeTruthy();
    expect(result.current.url).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(post).toHaveBeenCalledTimes(1);
    act(() => result.current.retry());
    expect(post).toHaveBeenCalledTimes(2);
    await answer(1, grant("retry-preview"));
    expect(result.current.error).toBeNull();
    expect(result.current.url).toContain("retry-preview");
  });
  it("unloads expired content while renewal is delayed", async () => {
    const { result } = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    await answer(0, grant("expired", 60_000, 900_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(post).toHaveBeenCalledTimes(2);
    expect(result.current.url).toBeUndefined();
    await answer(1, grant("fresh"));
    expect(result.current.url).toContain("fresh");
  });
  it("rejects already expired issuance without automatic retries", async () => {
    const { result } = renderHook(() => usePdfPreview("workspace-1", "file-1"));
    await answer(0, {
      data: {
        token: "bad",
        expiresAt: Date.now() - 1,
        sourceExpiresAt: Date.now() + 300_000,
      },
    });
    expect(result.current.error).toBeTruthy();
    expect(result.current.url).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900_000);
    });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
