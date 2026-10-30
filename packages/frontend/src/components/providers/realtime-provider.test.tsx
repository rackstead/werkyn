import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityGeneration } from "@/lib/identity";
import { useAuthStore } from "@/stores/auth-store";
import { FakeWebSocket } from "@/test/fake-websocket";
import { RealtimeProvider } from "./realtime-provider";

// Real provider, WebSocket client and identity transitions. The store's
// refresh, logout and expireSession are replaced per test; the test plays the
// server closing the socket.

const { refresh, logout, expireSession } = useAuthStore.getState();
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

async function mount(token: string) {
  useAuthStore.setState({ user: alice, accessToken: token });
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

function stubStore(renew: () => Promise<boolean>) {
  const mocks = {
    renew: vi.fn(renew),
    signOut: vi.fn(async () => {}),
    expire: vi.fn((_generation: number) => {
      useAuthStore.setState({ user: null, accessToken: null });
    }),
  };
  useAuthStore.setState({ refresh: mocks.renew, logout: mocks.signOut, expireSession: mocks.expire });
  return mocks;
}

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null, accessToken: null, refresh, logout, expireSession });
  vi.unstubAllGlobals();
});

describe("session close codes", () => {
  it.each([
    [4004, "Session expired"],
    [4005, "Session revoked"],
  ])("refreshes once after %i and reconnects with the new token", async (code, reason) => {
    let finish!: () => void;
    const { renew, signOut, expire } = stubStore(
      () =>
        new Promise<boolean>((resolve) => {
          finish = () => {
            useAuthStore.setState({ accessToken: "fresh-token" });
            resolve(true);
          };
        }),
    );
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
    expect(expire).not.toHaveBeenCalled();
  });

  it("expires the identity's session, without a server logout, when an ended session (4005) cannot be refreshed", async () => {
    const { renew, signOut, expire } = stubStore(async () => false);
    const socket = await mount("stale-token");
    const generation = identityGeneration();

    act(() => socket.closeWith(4005, "Session revoked"));
    await waitFor(() => expect(expire).toHaveBeenCalledTimes(1));
    expect(expire).toHaveBeenCalledWith(generation);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("does not sign out when the refresh after an expiry (4004) fails", async () => {
    const { renew, signOut, expire } = stubStore(async () => false);
    const socket = await mount("stale-token");

    act(() => socket.closeWith(4004, "Session expired"));
    await waitFor(() => expect(renew).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(signOut).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessToken).toBe("stale-token");
  });

  it("does not sign out when another tab supplied a new token during a failed refresh", async () => {
    const { signOut, expire } = stubStore(async () => {
      useAuthStore.setState({ accessToken: "other-tab-token" });
      return false;
    });
    const socket = await mount("stale-token");

    act(() => socket.closeWith(4005, "Session revoked"));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const next = FakeWebSocket.latest();
    act(() => next.accept());
    expect(next.sent[0]).toEqual({ type: "auth", token: "other-tab-token" });
    expect(signOut).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
  });

  it("ignores a session close of the socket it closed for an identity change", async () => {
    const { renew, signOut, expire } = stubStore(async () => false);
    const aliceSocket = await mount("alice-token");

    // Another account signs in: the identity transition closes Alice's socket.
    act(() => useAuthStore.setState({ user: { ...alice, id: "bob" }, accessToken: "bob-token" }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    act(() => aliceSocket.closeWith(4005, "Session revoked"));
    await act(async () => {});

    expect(renew).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessToken).toBe("bob-token");
  });

  it("neither refreshes nor signs out after an ordinary disconnect", async () => {
    const { renew, signOut, expire } = stubStore(async () => true);
    const socket = await mount("token");

    act(() => socket.closeWith(1006));
    await Promise.resolve();
    expect(renew).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
  });
});
