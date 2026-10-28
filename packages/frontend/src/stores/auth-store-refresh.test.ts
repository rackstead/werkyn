import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAuthStore } from "./auth-store";

const user = {
  id: "alice",
  email: "alice@example.test",
  displayName: "Alice",
  avatarUrl: null,
  phone: null,
  jobTitle: null,
  timezone: null,
  emailVerified: true,
};
const refreshed = (accessToken: string) =>
  new Response(
    JSON.stringify({ data: { user, accessToken, workspaces: [] } }),
    { headers: { "Content-Type": "application/json" } },
  );
const status = (code: number) =>
  new Response(JSON.stringify({ statusCode: code }), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });

let clock = Date.now();
let otherTab: BroadcastChannel;

beforeEach(() => {
  // Each case starts well after any refresh another case recorded.
  clock += 10 * 60 * 1000;
  vi.useFakeTimers({ now: clock, toFake: ["setTimeout", "Date"] });
  otherTab = new BroadcastChannel("pm-auth");
  useAuthStore.setState({
    user,
    accessToken: "expired",
    workspaces: [],
    _refreshPromise: null,
  });
});

afterEach(() => {
  otherTab.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("a superseded refresh retries with the cookie another tab replaced", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(status(409))
    .mockResolvedValueOnce(refreshed("from-retry"));
  vi.stubGlobal("fetch", fetch);
  const result = useAuthStore.getState().refresh();
  await vi.advanceTimersByTimeAsync(250);
  await expect(result).resolves.toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(useAuthStore.getState().accessToken).toBe("from-retry");
});

async function broadcastFromOtherTab(accessToken: string) {
  otherTab.postMessage({
    type: "refresh",
    data: { user, accessToken, workspaces: [] },
  });
  await vi.waitFor(() =>
    expect(useAuthStore.getState().accessToken).toBe(accessToken),
  );
}

it("a superseded refresh adopts the winning tab's broadcast as soon as it arrives", async () => {
  const fetch = vi.fn().mockResolvedValue(status(409));
  vi.stubGlobal("fetch", fetch);
  let settled: boolean | undefined;
  const result = useAuthStore.getState().refresh();
  result.then((value) => (settled = value));
  await vi.advanceTimersByTimeAsync(1);
  await broadcastFromOtherTab("from-other-tab");
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("a slow winning tab's late broadcast is still adopted", async () => {
  const fetch = vi.fn(async () => status(409));
  vi.stubGlobal("fetch", fetch);
  const result = useAuthStore.getState().refresh();
  await vi.advanceTimersByTimeAsync(5000);
  await broadcastFromOtherTab("late-winner");
  await expect(result).resolves.toBe(true);
  expect(fetch).toHaveBeenCalledTimes(5);
});

it("a refresh that stays superseded fails after bounded retries", async () => {
  const fetch = vi.fn(async () => status(409));
  vi.stubGlobal("fetch", fetch);
  const result = useAuthStore.getState().refresh();
  await vi.advanceTimersByTimeAsync(15_749);
  expect(fetch).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toBe(false);
  expect(fetch).toHaveBeenCalledTimes(7);
  expect(useAuthStore.getState().accessToken).toBe("expired");
});

it("a rejected refresh fails at once without retrying", async () => {
  const fetch = vi.fn(async () => status(401));
  vi.stubGlobal("fetch", fetch);
  await expect(useAuthStore.getState().refresh()).resolves.toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});
