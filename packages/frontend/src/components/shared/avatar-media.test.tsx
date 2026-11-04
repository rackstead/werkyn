import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UserAvatar } from "@/components/shared/user-avatar";
const state = vi.hoisted(() => ({ request: vi.fn(), resets: new Set<() => void>(), generation: 0 }));
vi.mock("@/lib/api-client", () => ({ api: state.request }));
vi.mock("@/lib/identity", () => ({ identityGeneration: () => state.generation, onIdentityChange: (listener: () => void) => { state.resets.add(listener); return () => state.resets.delete(listener); }, subscribeIdentity: () => () => {} }));
const source = "/storage/owned/uploads/avatars/user/00000000-0000-4000-8000-000000000001.gif";
const gif = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), character => character.charCodeAt(0));
const descriptors: Array<[string, PropertyDescriptor | undefined]> = [];
let creates: ReturnType<typeof vi.fn>, revokes: ReturnType<typeof vi.fn>;
beforeEach(() => {
  state.request.mockReset(); creates = vi.fn(() => `blob:owned-avatar-${creates.mock.calls.length}`); revokes = vi.fn();
  for (const [name, value] of [["createObjectURL", creates], ["revokeObjectURL", revokes]] as const) { descriptors.push([name, Object.getOwnPropertyDescriptor(URL, name)]); Object.defineProperty(URL, name, { configurable: true, value }); }
  state.request.mockImplementation(async (_path, options) => new Response(options.method === "HEAD" ? null : gif, { headers: { "content-length": String(gif.length), "content-type": "image/gif" } }));
});
afterEach(async () => {
  cleanup(); await act(async () => {});
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(30001);
  state.generation++; for (const reset of [...state.resets]) reset(); await act(async () => {});
  for (const [name, descriptor] of descriptors.splice(0)) { if (descriptor) Object.defineProperty(URL, name, descriptor); else Reflect.deleteProperty(URL, name); }
  vi.useRealTimers();
});
for (const legacy of ["/storage/avatars/owned.gif", "/storage/uploads/owned.gif", "/uploads/owned.gif"]) it("legacy avatar fallback "+legacy, () => {
  const view = render(<UserAvatar displayName="Owned Person" avatarUrl={legacy} />); expect(view.container.querySelector("img")).toBeNull(); expect(view.getByRole("img").getAttribute("aria-label")).toContain("image unavailable"); expect(state.request).not.toHaveBeenCalled();
});
it("remote avatar failure switches to initials", () => {
  const view = render(<UserAvatar displayName="Owned Person" avatarUrl="https://remote.example.test/owned.gif" />); fireEvent.error(view.getByAltText("Owned Person")); expect(view.container.querySelector("img")).toBeNull(); expect(view.getByRole("img").getAttribute("aria-label")).toContain("image unavailable");
});
it("repeated avatars share one fetch and one live Blob", async () => {
  const view = render(<><UserAvatar displayName="One" avatarUrl={source} /><UserAvatar displayName="Two" avatarUrl={source} /></>);
  await waitFor(() => expect(view.container.querySelectorAll("img").length).toBe(2)); expect(state.request).toHaveBeenCalledTimes(2); expect(creates).toHaveBeenCalledTimes(1);
  const first = view.getByAltText("One").getAttribute("src"); expect(view.getByAltText("Two").getAttribute("src")).toBe(first);
  vi.useFakeTimers(); view.rerender(<><UserAvatar displayName="Two" avatarUrl={source} /></>); expect(revokes).not.toHaveBeenCalledWith(first);
  view.rerender(<><UserAvatar displayName="Two" avatarUrl={source} /><UserAvatar displayName="Three" avatarUrl={source} /></>); await act(async () => {}); expect(state.request).toHaveBeenCalledTimes(2);
  view.unmount(); await vi.advanceTimersByTimeAsync(30001); expect(revokes).toHaveBeenCalledWith(first);
});
it("healthy remote avatar remains direct control", () => { const view = render(<UserAvatar displayName="Owned Person" avatarUrl="https://remote.example.test/owned.gif" />); expect(view.getByAltText("Owned Person").getAttribute("src")).toBe("https://remote.example.test/owned.gif"); expect(state.request).not.toHaveBeenCalled(); });
it("missing avatar URL renders ordinary initials without an error", () => {
  const view = render(<UserAvatar displayName="Owned Person" />);
  expect(view.container.querySelector("img")).toBeNull(); expect(view.getByRole("img").getAttribute("aria-label")).toBe("Owned Person"); expect(view.getByRole("img").textContent).toBe("OP"); expect(state.request).not.toHaveBeenCalled();
});
it("identity reset revokes shared avatars before the new generation publishes", async () => {
  const view = render(<><UserAvatar displayName="One" avatarUrl={source} /><UserAvatar displayName="Two" avatarUrl={source} /></>);
  await waitFor(() => expect(view.container.querySelectorAll("img").length).toBe(2)); const old = view.getByAltText("One").getAttribute("src");
  await act(async () => { state.generation++; for (const reset of [...state.resets]) reset(); });
  expect(revokes).toHaveBeenCalledWith(old);
  view.rerender(<><UserAvatar displayName="One" avatarUrl={source} /><UserAvatar displayName="Two" avatarUrl={source} /></>);
  await waitFor(() => expect(view.getByAltText("One").getAttribute("src")).not.toBe(old));
  expect(view.getByAltText("One").getAttribute("src")).toBe(view.getByAltText("Two").getAttribute("src"));
  expect(state.request).toHaveBeenCalledTimes(4); expect(creates).toHaveBeenCalledTimes(2);
});
it("different idle reference is evicted without revoking a live shared avatar", async () => {
  const other = source.replace("000000000001", "000000000002");
  const view = render(<><UserAvatar key="one" displayName="One" avatarUrl={source} /><UserAvatar key="two" displayName="Two" avatarUrl={other} /></>);
  await waitFor(() => expect(view.container.querySelectorAll("img").length).toBe(2));
  const active = view.getByAltText("One").getAttribute("src"), idle = view.getByAltText("Two").getAttribute("src");
  view.rerender(<UserAvatar key="one" displayName="One" avatarUrl={source} />);
  const third = source.replace("000000000001", "000000000003");
  view.rerender(<><UserAvatar key="one" displayName="One" avatarUrl={source} /><UserAvatar key="three" displayName="Three" avatarUrl={third} /></>);
  await waitFor(() => expect(view.getByAltText("Three").getAttribute("src")).toMatch(/^blob:/));
  expect(revokes).toHaveBeenCalledWith(idle); expect(revokes).not.toHaveBeenCalledWith(active); expect(view.getByAltText("One").getAttribute("src")).toBe(active);
});
it("distinct avatars share the two-active-load bound", async () => {
  const bodies = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  state.request.mockImplementation(async (_path, options) => {
    if (options.method === "HEAD") return new Response(null, { headers: { "content-length": String(gif.length), "content-type": "image/gif" } });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      bodies.set(options.searchParams.get("url"), controller);
      options.signal.addEventListener("abort", () => controller.error(Error("owned avatar abort")), { once: true });
    } }), { headers: { "content-length": String(gif.length), "content-type": "image/gif" } });
  });
  const sources = [source, source.replace("000000000001", "000000000002"), source.replace("000000000001", "000000000003")];
  render(<>{sources.map((url, index) => <UserAvatar key={url} displayName={String(index)} avatarUrl={url} />)}</>);
  await waitFor(() => expect(bodies.size).toBe(2)); expect(state.request).toHaveBeenCalledTimes(4);
  await act(async () => { bodies.get(sources[0])!.enqueue(gif); bodies.get(sources[0])!.close(); });
  await waitFor(() => expect(bodies.size).toBe(3)); expect(state.request).toHaveBeenCalledTimes(6);
});
it("idle eviction retains active accounting until aborted loads actually settle", async () => {
  vi.useFakeTimers(); let active = 0, peak = 0; const finishCancelled: Array<() => void> = [];
  const old = [source, source.replace("000000000001", "000000000002")];
  state.request.mockImplementation(async (_path, options) => {
    const headers = new Headers({ "content-length": String(gif.length), "content-type": "image/gif" });
    if (options.method === "HEAD") return new Response(null, { headers });
    active++; peak = Math.max(peak, active); const held = old.includes(options.searchParams.get("url")); let readCount = 0, finished = false;
    let rejectRead!: (error: Error) => void, finishCancel!: () => void;
    const read = new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => { rejectRead = reject; }); void read.catch(() => {});
    const cancellation = new Promise<void>(resolve => { finishCancel = () => { if (!finished) { finished = true; active--; } resolve(); }; });
    if (held) finishCancelled.push(finishCancel);
    options.signal.addEventListener("abort", () => rejectRead(Error("owned held abort")), { once: true });
    // Explicit transport adapter: abort rejects the pending read, while actual
    // reader cancellation remains owned and pending until this fixture releases it.
    return { headers, body: { getReader: () => ({
      read: () => held ? read : Promise.resolve(readCount++ === 0 ? { done: false, value: gif } : { done: true, value: undefined }),
      cancel: () => { if (!held) finishCancel(); return cancellation; }, releaseLock() {},
    }) } };
  });
  const view = render(<>{old.map(url => <UserAvatar key={url} displayName={url} avatarUrl={url} />)}</>);
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(active).toBe(2); expect(state.request).toHaveBeenCalledTimes(4);
    view.rerender(<></>); await act(async () => { await vi.advanceTimersByTimeAsync(30001); }); expect(active).toBe(2);
    view.rerender(<><UserAvatar displayName="New one" avatarUrl={source.replace("000000000001", "000000000003")} /><UserAvatar displayName="New two" avatarUrl={source.replace("000000000001", "000000000004")} /></>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); expect(state.request).toHaveBeenCalledTimes(4); expect(peak).toBe(2);
    await act(async () => { finishCancelled[0](); await vi.advanceTimersByTimeAsync(0); }); expect(peak).toBe(2);
    await act(async () => { finishCancelled[1](); await vi.advanceTimersByTimeAsync(0); }); expect(peak).toBe(2); expect(active).toBe(0);
  } finally { for (const finish of finishCancelled) finish(); }
});
