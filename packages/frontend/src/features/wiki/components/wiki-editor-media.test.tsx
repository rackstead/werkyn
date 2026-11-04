import { StrictMode, useLayoutEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { BlockNoteEditor } from "@blocknote/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WikiEditor } from "./wiki-editor";

const { observed } = vi.hoisted(() => ({ observed: { current: null as BlockNoteEditor | null, editors: new Set<BlockNoteEditor>(), phase: "render", commits: 0, resolverPhases: [] as string[], requestPhases: [] as string[], request: vi.fn(), modelBefore: "" } }));
vi.mock("@/lib/api-client", () => ({ api: observed.request }));
vi.mock("@blocknote/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@blocknote/react")>();
  return { ...actual, useCreateBlockNote: (...args: Parameters<typeof actual.useCreateBlockNote>) => {
    const options = args[0];
    if (options?.resolveFileUrl) {
      const resolve = options.resolveFileUrl;
      args[0] = { ...options, resolveFileUrl: (url: string) => { observed.resolverPhases.push(observed.phase); return resolve(url); } };
    }
    const editor = actual.useCreateBlockNote(...args); observed.current = editor; observed.editors.add(editor); return editor;
  } };
});
const source = "/storage/owned/uploads/wiki/space/00000000-0000-4000-8000-000000000001.gif";
const gif = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), character => character.charCodeAt(0));
const input = () => [{ id: "owned-media", type: "image", props: { url: source, name: "Owned committed image", showPreview: true, previewWidth: 64 }, children: [] }, { id: "owned-tail", type: "paragraph", content: [], children: [] }];
const descriptors: Array<[object, string, PropertyDescriptor | undefined]> = [];
let created: ReturnType<typeof vi.fn>, revoked: ReturnType<typeof vi.fn>;
function replace(target: object, name: string, value: unknown) { descriptors.push([target, name, Object.getOwnPropertyDescriptor(target, name)]); Object.defineProperty(target, name, { configurable: true, value }); }
beforeEach(() => {
  observed.phase = "render"; observed.commits = 0; observed.resolverPhases = []; observed.requestPhases = []; observed.modelBefore = ""; observed.request.mockReset();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true }));
  for (const name of ["getClientRects", "getBoundingClientRect"]) replace(Range.prototype, name, () => name === "getClientRects" ? [] : new DOMRect(0, 0, 0, 0));
  created = vi.fn(() => `blob:owned-commit-${created.mock.calls.length}`); revoked = vi.fn(); replace(URL, "createObjectURL", created); replace(URL, "revokeObjectURL", revoked);
  observed.request.mockImplementation(async (_path, options) => {
    observed.requestPhases.push(observed.phase); observed.modelBefore ||= JSON.stringify(observed.current!.document);
    return new Response(options.method === "HEAD" ? null : gif, { headers: { "content-type": "image/gif", "content-length": String(gif.length) } });
  });
});
afterEach(async () => {
  cleanup(); for (const editor of observed.editors) editor.unmount();
  await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
  for (const [target, name, descriptor] of descriptors.splice(0).reverse()) { if (descriptor) Object.defineProperty(target, name, descriptor); else Reflect.deleteProperty(target, name); }
  observed.current = null; observed.editors.clear(); vi.unstubAllGlobals();
});
function Committed({ content, onChange }: { content: unknown; onChange: () => void }) {
  observed.phase = "render";
  useLayoutEffect(() => { observed.phase = "committed"; observed.commits++; return () => { observed.phase = "cleanup"; }; }, []);
  return <WikiEditor initialContent={content} readOnly onChange={onChange} />;
}
for (const strict of [false, true]) it(`real core ${strict ? "StrictMode replay" : "initial mount"} resolves the visible image only after commit without changing its document`, async () => {
  const content = input(), original = JSON.stringify(content), onChange = vi.fn();
  const child = <Committed content={content} onChange={onChange} />; const view = render(strict ? <StrictMode>{child}</StrictMode> : child);
  await waitFor(() => expect(view.container.querySelector<HTMLImageElement>('img[alt="Owned committed image"]')?.getAttribute("src")).toMatch(/^blob:owned-commit-/));
  expect(view.container.querySelector(".wiki-editor-wrapper")?.className).not.toContain("[&_.bn-visual-media]:invisible");
  expect(created.mock.calls.some(call => (call[0] as Blob).type === "image/gif" && (call[0] as Blob).size === gif.length)).toBe(true);
  expect(observed.resolverPhases).toContain("render"); expect(observed.requestPhases.length).toBeGreaterThan(0); expect(observed.requestPhases.every(phase => phase === "committed")).toBe(true);
  if (strict) expect(observed.commits).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(observed.current!.document)).toBe(observed.modelBefore); expect(JSON.stringify(content)).toBe(original); expect(observed.current!.document[0].id).toBe("owned-media"); expect(onChange).not.toHaveBeenCalled();
  view.unmount(); await act(async () => {}); for (const call of created.mock.results) expect(revoked).toHaveBeenCalledWith(call.value);
});
it("real core resolution refusal is visible and non-rendering without an unhandled SDK rejection or model write", async () => {
  observed.request.mockRejectedValue(Error("Owned media denied")); const content = input(), original = JSON.stringify(content), onChange = vi.fn(); const view = render(<Committed content={content} onChange={onChange} />);
  await waitFor(() => expect(view.getByRole("status").textContent).toContain("Owned media denied"));
  await waitFor(() => expect(view.container.querySelector<HTMLImageElement>('img[alt="Owned committed image"]')?.getAttribute("src")).toBe("about:blank"));
  expect(created).not.toHaveBeenCalled(); expect(JSON.stringify(content)).toBe(original); expect(observed.current!.document[0].props).toMatchObject({ url: source }); expect(onChange).not.toHaveBeenCalled();
});
