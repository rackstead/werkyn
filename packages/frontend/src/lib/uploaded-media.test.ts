import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UploadedMediaOwner, isUploadedMediaUrl, uploadedMediaReferences } from "./uploaded-media";

const state = vi.hoisted(() => ({ generation: 0, listeners: new Set<() => void>(), request: vi.fn() }));
vi.mock("./api-client", () => ({ api: state.request }));
vi.mock("./identity", () => ({ identityGeneration: () => state.generation, onIdentityChange: (listener: () => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); } }));
const url = (id = 1, ext = "gif") => `/storage/owned/uploads/wiki/space/00000000-0000-4000-8000-${String(id).padStart(12, "0")}.${ext}`;
const owners: UploadedMediaOwner[] = [];
let creates: ReturnType<typeof vi.fn>, revokes: ReturnType<typeof vi.fn>;
let originalCreate: PropertyDescriptor | undefined, originalRevoke: PropertyDescriptor | undefined;
const sample = new Uint8Array([71, 73, 70]);
function owner(refs = [url()], shareToken?: string) { const result = new UploadedMediaOwner(vi.fn(), shareToken); owners.push(result); result.activate(); result.reconcile(new Set(refs)); return result; }
function response(method: string, bytes = sample, mime = "image/gif") { return new Response(method === "HEAD" ? null : bytes, { headers: { "content-length": String(bytes.length), "content-type": mime } }); }
beforeEach(() => {
  state.generation = 0; state.request.mockReset();
  state.request.mockImplementation((_path, options) => Promise.resolve(response(options.method)));
  originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL"); originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  creates = vi.fn(() => `blob:owned-${creates.mock.calls.length}`); revokes = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: creates }); Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokes });
});
afterEach(() => {
  for (const instance of owners.splice(0)) instance.dispose();
  expect(state.listeners.size).toBe(0);
  if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate); else delete (URL as unknown as Record<string, unknown>).createObjectURL;
  if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke); else delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  vi.restoreAllMocks(); vi.useRealTimers();
});

it("recognizes only exact canonical upload refs and structural media properties", () => {
  expect(isUploadedMediaUrl(url())).toBe(true);
  for (const bad of ["https://remote.test" + url(), url() + "?q=1", url().replace("/wiki/", "/wiki%2f")]) expect(isUploadedMediaUrl(bad)).toBe(false);
  expect(uploadedMediaReferences([{ type: "paragraph", content: url(), props: { url: url() }, children: [{ type: "image", props: { url: url(2) } }] }])).toEqual(new Set([url(2)]));
});
it("coalesces safe HEAD/GET loads into one owned URL without changing the source", async () => {
  const source = url(), instance = owner(); const [a, b] = await Promise.all([instance.resolve(source), instance.resolve(source)]);
  expect(a).toBe(b); expect(a).toMatch(/^blob:/); expect(source).toBe(url()); expect(state.request).toHaveBeenCalledTimes(2);
  expect(state.request.mock.calls.map(call => [call[0], call[1].method, call[1].searchParams.get("url")])).toEqual([["uploads/media", "HEAD", source], ["uploads/media", "GET", source]]);
  instance.dispose(); expect(revokes).toHaveBeenCalledWith(a);
});
it("leaves remote media alone and never sends it through the bearer API", async () => { const instance = owner([]); expect(await instance.resolve("https://remote.test/image.png")).toBe("https://remote.test/image.png"); expect(state.request).not.toHaveBeenCalled(); });
it("releases removed references and refuses a stale reference without another request", async () => { const instance = owner(); const result = await instance.resolve(url()); instance.reconcile(new Set()); expect(revokes).toHaveBeenCalledWith(result); await expect(instance.resolve(url())).rejects.toThrow(/unavailable/); expect(state.request).toHaveBeenCalledTimes(2); });
it("aborts an in-flight body when its owner unmounts", async () => {
  let signal: AbortSignal | undefined;
  state.request.mockImplementation((_path, options) => {
    signal = options.signal;
    if (options.method === "HEAD") return Promise.resolve(response("HEAD"));
    return Promise.resolve(new Response(new ReadableStream({ start(controller) { options.signal.addEventListener("abort", () => controller.error(Error("cancelled")), { once: true }); } }), { headers: { "content-length": "3", "content-type": "image/gif" } }));
  });
  const instance = owner(), pending = instance.resolve(url()); void pending.catch(() => {});
  await vi.waitFor(() => expect(state.request).toHaveBeenCalledTimes(2)); instance.dispose(); await expect(pending).rejects.toThrow(); expect(signal!.aborted).toBe(true); expect(creates).not.toHaveBeenCalled();
});
it("a retired activation cannot remove or publish over its replacement", async () => {
  let finish!: (value: Response) => void;
  state.request.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  const instance = owner(), old = instance.resolve(url()); void old.catch(() => {});
  await vi.waitFor(() => expect(state.request).toHaveBeenCalledTimes(1)); instance.dispose(); instance.activate(); instance.reconcile(new Set([url()]));
  const current = await instance.resolve(url()); finish(response("HEAD")); await expect(old).rejects.toThrow(); expect(await instance.resolve(url())).toBe(current); expect(creates).toHaveBeenCalledTimes(1); expect(revokes).not.toHaveBeenCalledWith(current);
});
it("an ordinary identity reset aborts/revokes and does not reuse an A-B-A generation", async () => {
  const instance = owner(), result = await instance.resolve(url()); state.generation++; for (const listener of [...state.listeners]) listener();
  expect(revokes).toHaveBeenCalledWith(result); state.generation++; await expect(instance.resolve(url())).rejects.toThrow(); expect(state.request).toHaveBeenCalledTimes(2);
});
it("rejects an oversized HEAD before reading or materializing the body", async () => {
  state.request.mockResolvedValue(new Response(null, { headers: { "content-length": String(25 * 1024 * 1024 + 1) } })); const instance = owner(); await expect(instance.resolve(url())).rejects.toThrow(/limit/); expect(state.request).toHaveBeenCalledTimes(1); expect(creates).not.toHaveBeenCalled();
});
it("enforces the avatar5MiB bound independently of the wiki limit", async () => {
  const avatar = url().replace("/wiki/space/", "/avatars/user/"); state.request.mockResolvedValue(new Response(null, { headers: { "content-length": String(5 * 1024 * 1024 + 1) } })); await expect(owner([avatar]).resolve(avatar)).rejects.toThrow(/limit/); expect(state.request).toHaveBeenCalledTimes(1);
});
it("detects growth beyond the declared body reservation", async () => {
  state.request.mockImplementation((_path, options) => Promise.resolve(options.method === "HEAD" ? new Response(null, { headers: { "content-length": "2" } }) : response("GET"))); await expect(owner().resolve(url())).rejects.toThrow(/limit/); expect(creates).not.toHaveBeenCalled();
});
it("bounds aggregate retained bytes at64MiB without evicting live references", async () => {
  const bytes = new Uint8Array(25 * 1024 * 1024); state.request.mockImplementation((_path, options) => Promise.resolve(response(options.method, bytes)));
  const instance = owner([url(1), url(2), url(3)]), first = await instance.resolve(url(1)), second = await instance.resolve(url(2));
  await expect(instance.resolve(url(3))).rejects.toThrow(/limit/); expect(creates).toHaveBeenCalledTimes(2); expect(revokes).not.toHaveBeenCalled(); expect(await instance.resolve(url(1))).toBe(first); expect(await instance.resolve(url(2))).toBe(second);
});
it("unsafe content is never a navigable resolver URL and downloads as octet-stream", async () => {
  vi.useFakeTimers(); const source = url(1, "html"); state.request.mockImplementation((_path, options) => Promise.resolve(response(options.method, sample, "text/html")));
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { expect(this.download).toBe("owned.html"); expect(this.href).toMatch(/^blob:/); });
  const open = vi.spyOn(window, "open").mockImplementation(() => null); const instance = owner([source]); await expect(instance.resolve(source)).rejects.toThrow(/download-only/); expect(creates).not.toHaveBeenCalled();
  await instance.download(source, "owned.html"); expect(click).toHaveBeenCalledTimes(1); expect(open).not.toHaveBeenCalled(); expect((creates.mock.calls[0][0] as Blob).type).toBe("application/octet-stream"); vi.advanceTimersByTime(2001); expect(revokes).toHaveBeenCalledTimes(1);
});
it("share reads use only the configured public endpoint and existing cookie context", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, options) => response(options!.method!)); const instance = owner([url()], "owned-token"); await instance.resolve(url()); expect(state.request).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(2);
  for (const [input, options] of fetch.mock.calls) { expect(String(input)).toContain("/api/public/wiki/owned-token/media?url="); expect(options!.credentials).toBe("include"); expect(options!.headers).toBeUndefined(); }
});
