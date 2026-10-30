import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth-store";
import { FakeWebSocket } from "@/test/fake-websocket";
import { RealtimeProvider } from "./realtime-provider";

// Real provider and WebSocket client. The store's refresh and logout are
// replaced per test; the test plays the server closing the socket.

const { refresh, logout } = useAuthStore.getState();

async function mount(token: string) {
  useAuthStore.setState({ accessToken: token });
  render(
    <RealtimeProvider>
      <div />
    </RealtimeProvider>,
  );
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.latest();
  act(() => socket.accept());
  expect(socket.sent[0]).toEqual({ type: "auth", token });
  return socket;
}

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ accessToken: null, refresh, logout });
  vi.unstubAllGlobals();
});

describe("session close codes", () => {
  it.each([
    [4004, "Session expired"],
    [4005, "Session revoked"],
  ])("refreshes once after %i and reconnects with the new token", async (code, reason) => {
    let finish!: () => void;
    const renew = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = () => {
            useAuthStore.setState({ accessToken: "fresh-token" });
            resolve(true);
          };
        }),
    );
    const signOut = vi.fn(async () => {});
    useAuthStore.setState({ refresh: renew, logout: signOut });
    const socket = await mount("stale-token");

    act(() => socket.closeWith(code, reason));
    // Nothing reconnects with the stale token while the refresh runs.
    await Promise.resolve();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => finish());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const next = FakeWebSocket.latest();
    act(() => next.accept());

    expect(next.sent[0]).toEqual({ type: "auth", token: "fresh-token" });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("signs out once when an ended session (4005) cannot be refreshed", async () => {
    const renew = vi.fn(async () => false);
    const signOut = vi.fn(async () => {
      useAuthStore.setState({ accessToken: null });
    });
    useAuthStore.setState({ refresh: renew, logout: signOut });
    const socket = await mount("stale-token");

    act(() => socket.closeWith(4005, "Session revoked"));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(renew).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("does not sign out when the refresh after an expiry (4004) fails", async () => {
    const renew = vi.fn(async () => false);
    const signOut = vi.fn(async () => {});
    useAuthStore.setState({ refresh: renew, logout: signOut });
    const socket = await mount("stale-token");

    act(() => socket.closeWith(4004, "Session expired"));
    await waitFor(() => expect(renew).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(signOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessToken).toBe("stale-token");
  });

  it("does not sign out when another tab supplied a new token during a failed refresh", async () => {
    const renew = vi.fn(async () => {
      useAuthStore.setState({ accessToken: "other-tab-token" });
      return false;
    });
    const signOut = vi.fn(async () => {});
    useAuthStore.setState({ refresh: renew, logout: signOut });
    const socket = await mount("stale-token");

    act(() => socket.closeWith(4005, "Session revoked"));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const next = FakeWebSocket.latest();
    act(() => next.accept());
    expect(next.sent[0]).toEqual({ type: "auth", token: "other-tab-token" });
    expect(signOut).not.toHaveBeenCalled();
  });

  it("neither refreshes nor signs out after an ordinary disconnect", async () => {
    const renew = vi.fn(async () => true);
    const signOut = vi.fn(async () => {});
    useAuthStore.setState({ refresh: renew, logout: signOut });
    const socket = await mount("token");

    act(() => socket.closeWith(1006));
    await Promise.resolve();
    expect(renew).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });
});
