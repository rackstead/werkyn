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
  // Signing in also ends any superseded run a previous case left behind.
  useAuthStore.getState().setAuth(user, "expired", []);
  useAuthStore.setState({ _refreshPromise: null, isHydrated: false });
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
  await vi.advanceTimersByTimeAsync(13_749);
  expect(fetch).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toBe(false);
  expect(fetch).toHaveBeenCalledTimes(7);
  expect(useAuthStore.getState().accessToken).toBe("expired");
});

it("hydration stops sending a superseded cookie 15 s after the first 409", async () => {
  const sentAt: number[] = [];
  const fetch = vi.fn(async () => {
    sentAt.push(Date.now());
    return status(409);
  });
  vi.stubGlobal("fetch", fetch);
  const hydrated = useAuthStore.getState().hydrate();
  await vi.advanceTimersByTimeAsync(60_000);
  await hydrated;
  expect(useAuthStore.getState().isHydrated).toBe(true);
  // Three refresh attempts, yet nothing is sent once the run is 15 s old,
  // well before the server would treat the old cookie as reuse at 30 s.
  expect(fetch).toHaveBeenCalledTimes(8);
  expect(sentAt[sentAt.length - 1] - sentAt[0]).toBeLessThan(15_000);
});

it("a tab that gave up refreshes again after another tab's broadcast", async () => {
  const fetch = vi.fn(async () => status(409));
  vi.stubGlobal("fetch", fetch);
  const first = useAuthStore.getState().refresh();
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(first).resolves.toBe(false);
  await expect(useAuthStore.getState().refresh()).resolves.toBe(false);
  expect(fetch).toHaveBeenCalledTimes(7);

  await broadcastFromOtherTab("winner");
  await vi.advanceTimersByTimeAsync(6_000);
  fetch.mockImplementation(async () => refreshed("after-broadcast"));
  await expect(useAuthStore.getState().refresh()).resolves.toBe(true);
  expect(fetch).toHaveBeenCalledTimes(8);
  expect(useAuthStore.getState().accessToken).toBe("after-broadcast");
});

it("a busy session retries the unchanged cookie without starting the superseded budget", async () => {
  const fetch = vi.fn(async () => status(503));
  vi.stubGlobal("fetch", fetch);
  const busy = useAuthStore.getState().refresh();
  await vi.advanceTimersByTimeAsync(13_750);
  await expect(busy).resolves.toBe(false);
  expect(fetch).toHaveBeenCalledTimes(7);
  // Contention ends: the same cookie is sent again and succeeds.
  await vi.advanceTimersByTimeAsync(10_000);
  fetch.mockImplementation(async () => refreshed("after-busy"));
  await expect(useAuthStore.getState().refresh()).resolves.toBe(true);
  expect(fetch).toHaveBeenCalledTimes(8);
});

it("a 409 that arrives after another tab's broadcast does not block later refreshes", async () => {
  let respond!: (response: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const result = useAuthStore.getState().refresh();
  await vi.advanceTimersByTimeAsync(1);
  // The winning tab's broadcast lands before this tab's request returns.
  await broadcastFromOtherTab("winner");
  respond(status(409));
  await vi.advanceTimersByTimeAsync(250);
  await expect(result).resolves.toBe(true);

  await vi.advanceTimersByTimeAsync(20_000);
  fetch.mockImplementation(async () => refreshed("next-cycle"));
  await expect(useAuthStore.getState().refresh()).resolves.toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(useAuthStore.getState().accessToken).toBe("next-cycle");
});

it("a rejected refresh fails at once without retrying", async () => {
  const fetch = vi.fn(async () => status(401));
  vi.stubGlobal("fetch", fetch);
  await expect(useAuthStore.getState().refresh()).resolves.toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});
