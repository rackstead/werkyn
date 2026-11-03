import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { writeFileSync } from "node:fs";
import type { Block, BlockNoteEditor } from "@blocknote/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WikiEditor } from "./wiki-editor";
import persisted046Document from "./fixtures/blocknote046-document.json";

// Capture the actual public editor returned by the real hook. The hook, core,
// Mantine view and editor DOM all execute; no editor or view is substituted.
const { observed } = vi.hoisted(() => ({
  observed: { current: null as BlockNoteEditor | null, editors: new Set<BlockNoteEditor>() },
}));
const geometryDescriptors: Array<[string, PropertyDescriptor | undefined]> = [];
const facts: unknown[] = [];
function checkpoint(label: string) {
  if (!process.env.BLOCKNOTE_COMPAT_FACTS_PATH) return;
  const current = observed.current;
  facts.push({
    test: expect.getState().currentTestName, label,
    document: current ? JSON.parse(JSON.stringify(current.document)) : null,
    schema: current ? {
      blocks: current.schema.blockSchema,
      inline: current.schema.inlineContentSchema,
      styles: current.schema.styleSchema,
    } : null,
    selectedText: current?.getSelectedText(),
  });
  writeFileSync(process.env.BLOCKNOTE_COMPAT_FACTS_PATH, JSON.stringify(facts, null, 2));
}
vi.mock("@blocknote/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@blocknote/react")>();
  return {
    ...actual,
    useCreateBlockNote: (...args: Parameters<typeof actual.useCreateBlockNote>) => {
      const editor = actual.useCreateBlockNote(...args);
      observed.current = editor;
      observed.editors.add(editor);
      return editor;
    },
  };
});

beforeEach(() => {
  // Layout-only jsdom prerequisites, not replacements for editor behavior.
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {},
    removeEventListener() {}, dispatchEvent: () => true,
  }));
  vi.stubGlobal("ClipboardEvent", class extends Event {
    readonly clipboardData = null;
  });
  // jsdom omits Range geometry used when ProseMirror scrolls a selection.
  for (const name of ["getClientRects", "getBoundingClientRect"]) {
    geometryDescriptors.push([name, Object.getOwnPropertyDescriptor(Range.prototype, name)]);
    Object.defineProperty(Range.prototype, name, {
      configurable: true,
      value: () => name === "getClientRects" ? [] : new DOMRect(0, 0, 0, 0),
    });
  }
});

afterEach(async () => {
  checkpoint("before-cleanup");
  cleanup();
  for (const editor of observed.editors) editor.unmount();
  // Settle genuine close/focus callbacks while this DOM and its globals live.
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  observed.current = null;
  observed.editors.clear();
  for (const [name, descriptor] of geometryDescriptors.splice(0)) {
    if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
    else Reflect.deleteProperty(Range.prototype, name);
  }
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
});

const stored = () => [
  { id: "kept-heading", type: "heading", props: { level: 2 }, content: "Title" },
  { id: "kept-list", type: "bulletListItem", content: "Parent", children: [
    { id: "kept-child", type: "bulletListItem", content: "Child" },
  ] },
  { id: "kept-end", type: "paragraph", content: "Ending" },
];
function editor() {
  expect(observed.current).not.toBeNull();
  return observed.current!;
}
function allIds(blocks: Block[]): string[] {
  return blocks.flatMap((block) => [block.id, ...allIds(block.children)]);
}
function text() { return JSON.stringify(editor().document); }
function editable(container: HTMLElement) {
  const element = container.querySelector<HTMLElement>(".bn-editor");
  expect(element).not.toBeNull();
  return element!;
}
async function settle() { await act(async () => {}); }

it("real Mantine editor preserves supplied IDs and nested content through JSON reload", async () => {
  const first = render(<WikiEditor initialContent={stored()} />);
  await settle();
  expect(first.container.querySelector(".bn-mantine")).not.toBeNull();
  const snapshot = JSON.parse(text());
  expect(allIds(editor().document)).toEqual(["kept-heading", "kept-list", "kept-child", "kept-end"]);
  first.unmount();
  render(<WikiEditor initialContent={snapshot} />);
  await settle();
  expect(editor().document).toEqual(snapshot);
});

it("real Mantine editor gives a new block one distinct ID retained on reload", async () => {
  const first = render(<WikiEditor initialContent={stored()} />);
  await settle();
  checkpoint("before-insert");
  const before = JSON.parse(text());
  act(() => { editor().insertBlocks([{ type: "paragraph", content: "New block" }], "kept-end", "after"); });
  const ids = allIds(editor().document);
  checkpoint("after-insert");
  // Current trailing input is a decoration; only the inserted block is new data.
  expect(ids).toHaveLength(5);
  expect(new Set(ids).size).toBe(5);
  expect(ids.slice(0, 4)).toEqual(["kept-heading", "kept-list", "kept-child", "kept-end"]);
  expect(ids[4]).toBeTruthy();
  expect(editor().document.slice(0, 3)).toEqual(before);
  expect(editor().document[3]).toMatchObject({
    type: "paragraph", content: [{ type: "text", text: "New block", styles: {} }],
  });
  expect(editor().document).toHaveLength(4);
  const snapshot = JSON.parse(text());
  first.unmount();
  render(<WikiEditor initialContent={snapshot} />);
  await settle();
  expect(editor().document).toEqual(snapshot);
});

it("real Mantine idle replacement updates content without reporting an edit", async () => {
  const onChange = vi.fn();
  const view = render(<WikiEditor initialContent={stored()} onChange={onChange} />);
  await settle();
  onChange.mockClear();
  checkpoint("before-replace");
  const next = [{ id: "replacement", type: "paragraph", content: "Remote replacement" }];
  view.rerender(<WikiEditor initialContent={next} onChange={onChange} />);
  await settle();
  checkpoint("after-replace");
  expect(text()).toContain("Remote replacement");
  expect(allIds(editor().document)).toEqual(["replacement"]);
  expect(editor().document[0].id).toBe("replacement");
  expect(editor().document[0].content).toEqual([{ type: "text", text: "Remote replacement", styles: {} }]);
  expect(editor().document[0].children).toEqual([]);
  expect(onChange).not.toHaveBeenCalled();
});

it("real Mantine recovered and dirty blocks survive an incoming source refresh", async () => {
  const recovered = [{ id: "draft-id", type: "paragraph", content: "Recovered draft" }];
  const view = render(<WikiEditor initialContent={stored()} recoveredContent={recovered} hasUnsavedChanges />);
  await settle();
  expect(text()).toContain("Recovered draft");
  checkpoint("before-local-edit");
  act(() => { editor().updateBlock("draft-id", { content: "Locally edited draft" }); });
  const snapshot = JSON.parse(text());
  checkpoint("after-local-edit");
  view.rerender(<WikiEditor initialContent={[{ type: "paragraph", content: "New remote" }]} hasUnsavedChanges />);
  await settle();
  expect(editor().document).toEqual(snapshot);
  expect(allIds(editor().document)).toEqual(["draft-id"]);
  expect(editor().document[0].id).toBe("draft-id");
  expect(editor().document[0].content).toEqual([{ type: "text", text: "Locally edited draft", styles: {} }]);
  expect(editor().document[0].children).toEqual([]);
});

it("real Mantine readonly DOM refuses user paste and toggling does not manufacture edits", async () => {
  const onChange = vi.fn();
  const view = render(<WikiEditor initialContent={stored()} readOnly onChange={onChange} />);
  await settle();
  onChange.mockClear();
  const snapshot = JSON.parse(text());
  expect(editable(view.container).getAttribute("contenteditable")).toBe("false");
  expect(editor().isEditable).toBe(false);
  fireEvent.keyDown(editable(view.container), { key: "x" });
  fireEvent.paste(editable(view.container), { clipboardData: { getData: () => "User paste" } });
  await settle();
  expect(editor().document).toEqual(snapshot);
  view.rerender(<WikiEditor initialContent={stored()} onChange={onChange} />);
  await settle();
  expect(editor().isEditable).toBe(true);
  expect(editable(view.container).getAttribute("contenteditable")).toBe("true");
  expect(editor().document).toEqual(snapshot);
  expect(onChange).not.toHaveBeenCalled();
});

it("real Mantine ordinary rich paste keeps heading, emphasis, list and link text", async () => {
  render(<WikiEditor initialContent={[{ id: "paste-id", type: "paragraph", content: "" }]} />);
  await settle();
  act(() => {
    editor().pasteHTML('<h2>Heading</h2><p><strong>Bold</strong> and <em>italic</em> <a href="https://example.com">Link</a></p><ul><li>Item</li></ul>', true);
  });
  expect(text()).toContain("Heading");
  expect(text()).toContain("Bold");
  expect(text()).toContain('"bold":true');
  expect(text()).toContain('"italic":true');
  expect(text()).toContain("https://example.com");
  expect(text()).toContain("bulletListItem");
  const snapshot = JSON.parse(text());
  expect(new Set(allIds(editor().document)).size).toBe(allIds(editor().document).length);
  act(() => { editor().replaceBlocks(editor().document, snapshot); });
  expect(editor().document).toEqual(snapshot);
});

it("real Mantine nested-list Backspace and undo preserve text and original IDs", async () => {
  const view = render(<WikiEditor initialContent={stored()} />);
  await settle();
  const snapshot = JSON.parse(text());
  checkpoint("before-backspace");
  act(() => { editor().setTextCursorPosition("kept-child", "start"); editor().focus(); });
  fireEvent.keyDown(editable(view.container), { key: "Backspace", code: "Backspace", keyCode: 8, which: 8 });
  checkpoint("after-backspace");
  expect(text()).toContain("Parent");
  expect(text()).toContain("Child");
  expect(text()).toContain("Ending");
  act(() => { expect(editor().undo()).toBe(true); });
  checkpoint("after-backspace-undo");
  expect(editor().document.slice(0, 3)).toEqual(snapshot);
  expect(editor().document).toHaveLength(3);
  expect(editor().document).toEqual(snapshot);
  expect(allIds(editor().document)).toEqual(["kept-heading", "kept-list", "kept-child", "kept-end"]);
  expect(new Set(allIds(editor().document)).size).toBe(4);
});

it("known old-constructor-accepted but schema-invalid marks refuse locally without rewriting input", async () => {
  const initial = JSON.parse(JSON.stringify(persisted046Document));
  const before = JSON.parse(JSON.stringify(initial));
  const onChange = vi.fn();
  const view = render(<WikiEditor initialContent={initial} onChange={onChange} />);
  await settle();
  checkpoint("known-invalid-old-document-contained");
  expect(view.getByRole("alert").textContent).toMatch(/couldn.t open/i);
  expect(view.container.querySelector(".bn-editor")).toBeNull();
  expect(initial).toEqual(before);
  expect(initial).toEqual(persisted046Document);
  expect(onChange).not.toHaveBeenCalled();
});
