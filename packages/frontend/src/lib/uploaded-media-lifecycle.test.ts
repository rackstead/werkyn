import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorMediaResolver, UploadedMediaOwner } from "@/lib/uploaded-media";
const state = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ api: state.request }));
vi.mock("@/lib/identity", () => ({ identityGeneration: () => 0, onIdentityChange: () => () => {} }));
const url = (i = 1) => `/storage/owned/uploads/wiki/space/00000000-0000-4000-8000-${String(i).padStart(12, "0")}.gif`;
const owners: UploadedMediaOwner[] = [];
const pending: Promise<unknown>[] = [];
const descriptors: Array<[string, PropertyDescriptor | undefined]> = [];
function owner(refs = [url()]) { const value = new UploadedMediaOwner(vi.fn()); owners.push(value); value.activate(); value.reconcile(new Set(refs)); return value; }
function track<T>(promise: Promise<T>) { pending.push(promise); void promise.catch(() => {}); return promise; }
beforeEach(() => {
  state.request.mockReset(); let count = 0;
  for (const [name, value] of [["createObjectURL", () => `blob:owned-${++count}`], ["revokeObjectURL", () => {}]] as const) { descriptors.push([name, Object.getOwnPropertyDescriptor(URL, name)]); Object.defineProperty(URL, name, { configurable: true, value }); }
  state.request.mockImplementation(async (_path, options) => new Response(options.method === "HEAD" ? null : new Uint8Array([71, 73, 70]), { headers: { "content-length": "3", "content-type": "image/gif" } }));
});
afterEach(async () => {
  for (const instance of owners.splice(0)) instance.dispose(); await Promise.allSettled(pending.splice(0));
  for (const [name, descriptor] of descriptors.splice(0)) { if (descriptor) Object.defineProperty(URL, name, descriptor); else Reflect.deleteProperty(URL, name); }
  vi.useRealTimers();
});
function heldBodies(count: number) {
  const bodies = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  state.request.mockImplementation(async (_path, options) => {
    if (options.method === "HEAD") return new Response(null, { headers: { "content-length": "3", "content-type": "image/gif" } });
    const source = options.searchParams.get("url");
    if (Number(source.match(/([0-9]+)\.gif$/)![1]) > count) return new Response(new Uint8Array([71, 73, 70]), { headers: { "content-length": "3", "content-type": "image/gif" } });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      bodies.set(source, controller); options.signal.addEventListener("abort", () => controller.error(Error("owned request aborted")), { once: true });
    } }), { headers: { "content-length": "3", "content-type": "image/gif" } });
  });
  return bodies;
}
it("queue waiting does not consume an active-transfer deadline", async () => {
  vi.useFakeTimers(); const bodies = heldBodies(2), value = owner([url(1), url(2), url(3)]); const outcome = ["pending", "pending", "pending"];
  const work = [1, 2, 3].map((id, index) => track(value.resolve(url(id)).then(result => { outcome[index] = "resolved"; return result; }, error => { outcome[index] = "rejected"; throw error; })));
  await vi.advanceTimersByTimeAsync(0); expect(bodies.size).toBe(2);
  await vi.advanceTimersByTimeAsync(15000); for (const body of bodies.values()) body.enqueue(new Uint8Array([71])); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(6000); expect(outcome[2]).toBe("pending");
  for (const body of bodies.values()) { body.enqueue(new Uint8Array([73, 70])); body.close(); }
  await vi.advanceTimersByTimeAsync(0); expect((await Promise.all(work)).every(result => result.startsWith("blob:"))).toBe(true);
});
it("a progressing body survives more than20s total", async () => {
  vi.useFakeTimers(); const bodies = heldBodies(1), value = owner(); let outcome = "pending";
  const work = track(value.resolve(url()).then(result => { outcome = "resolved"; return result; }, error => { outcome = "rejected"; throw error; }));
  await vi.advanceTimersByTimeAsync(0); expect(bodies.size).toBe(1);
  await vi.advanceTimersByTimeAsync(15000); bodies.get(url())!.enqueue(new Uint8Array([71])); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(10000); expect(outcome).toBe("pending");
  bodies.get(url())!.enqueue(new Uint8Array([73, 70])); bodies.get(url())!.close(); await vi.advanceTimersByTimeAsync(0); expect(await work).toMatch(/^blob:/);
});
it("retired editor reference refuses instead of returning a410 URL", async () => {
  const owner = { resolve: vi.fn() }, resolver = new EditorMediaResolver(owner); const result = resolver.resolve("/storage/uploads/owned.gif"); resolver.commit();
  expect(await result).toBe("about:blank"); expect(owner.resolve).not.toHaveBeenCalled(); resolver.deactivate();
});
it("small canonical load control still completes", async () => { expect(await track(owner().resolve(url()))).toMatch(/^blob:/); expect(state.request).toHaveBeenCalledTimes(2); });

function longBodies() {
  const bodies = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  state.request.mockImplementation(async (_path, options) => {
    if (options.method === "HEAD") return new Response(null, { headers: { "content-length": "1000", "content-type": "image/gif" } });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      bodies.set(options.searchParams.get("url"), controller);
      options.signal.addEventListener("abort", () => controller.error(Error("owned abort")), { once: true });
    } }), { headers: { "content-length": "1000", "content-type": "image/gif" } });
  });
  return bodies;
}
it("queue expires finitely while both active bodies continue progressing", async () => {
  vi.useFakeTimers(); const bodies = longBodies(), value = owner([url(1), url(2), url(3)]), outcomes = ["pending", "pending", "pending"];
  [1, 2, 3].forEach((id, index) => track(value.resolve(url(id)).then(() => { outcomes[index] = "resolved"; }, error => { outcomes[index] = "rejected"; throw error; })));
  await vi.advanceTimersByTimeAsync(0); expect(bodies.size).toBe(2);
  for (let i = 0; i < 12; i++) { await vi.advanceTimersByTimeAsync(10000); for (const body of bodies.values()) body.enqueue(new Uint8Array([71])); await vi.advanceTimersByTimeAsync(0); }
  expect(outcomes).toEqual(["pending", "pending", "rejected"]); expect(bodies.size).toBe(2);
});
it("stalled body expires at its finite inactivity bound", async () => {
  vi.useFakeTimers(); longBodies(); let outcome = "pending";
  track(owner().resolve(url()).catch(error => { outcome = "rejected"; throw error; }));
  await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(19999); expect(outcome).toBe("pending");
  await vi.advanceTimersByTimeAsync(2); expect(outcome).toBe("rejected");
});
it("progressing body still expires at the absolute active bound", async () => {
  vi.useFakeTimers(); const bodies = longBodies(); let outcome = "pending";
  track(owner().resolve(url()).catch(error => { outcome = "rejected"; throw error; })); await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 29; i++) { await vi.advanceTimersByTimeAsync(10000); bodies.get(url())!.enqueue(new Uint8Array([71])); await vi.advanceTimersByTimeAsync(0); }
  expect(outcome).toBe("pending"); await vi.advanceTimersByTimeAsync(10001); expect(outcome).toBe("rejected");
});
