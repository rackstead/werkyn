import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { writeFileSync } from "node:fs";
import type { Block, BlockNoteEditor } from "@blocknote/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WikiEditor } from "./wiki-editor";
import persisted046Document from "./fixtures/blocknote046-valid-document.json";
import persisted046Schema from "./fixtures/blocknote046-schema.json";

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
    prosemirror: current?.prosemirrorState.doc.toJSON(),
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

it("NEW old-schema-valid exact emitted JSON preserves all14 types through current Mantine and wire reload", async () => {
  const initial = persisted046Document;
  const view = render(<WikiEditor initialContent={initial} />);
  await settle();
  checkpoint("new-valid-old-golden-loaded");
  expect(() => editor().prosemirrorState.doc.check()).not.toThrow();
  expect(JSON.parse(text())).toEqual(persisted046Document);
  for (const [kind, previous] of Object.entries(persisted046Schema.blocks)) {
    expect(editor().schema.blockSchema).toHaveProperty(kind);
    const current = editor().schema.blockSchema[kind as keyof ReturnType<typeof editor>["schema"]["blockSchema"]];
    for (const property of Object.keys(previous.propSchema)) expect(current.propSchema).toHaveProperty(property);
  }
  const schemaTypes = Object.keys(editor().schema.blockSchema);
  for (const block of initial) expect(schemaTypes).toContain(block.type);
  const snapshot = JSON.parse(text());
  expect(allIds(editor().document)).toEqual(initial.flatMap((block) => [block.id, ...(block.children?.map((child) => child.id) ?? [])]));
  expect(text()).toContain("Checked");
  expect(text()).toContain("Audio caption");
  expect(text()).toContain("Image caption");
  expect(text()).toContain("File caption");
  expect(text()).toContain("Video caption");
  expect(text()).toContain("let saved = 1;");
  expect(text()).toContain('"checked":true');
  expect(text()).toContain("tableContent");
  expect(text()).toContain("https://example.com/owned");
  for (const kind of ["audio", "image", "file", "video"]) {
    const saved = editor().document.find((block) => block.id === `saved-${kind}`)!;
    expect(saved.type).toBe(kind);
    expect(saved.props).toMatchObject({ url: "", caption: `${kind[0].toUpperCase()}${kind.slice(1)} caption` });
  }
  const table = editor().document.find((block) => block.id === "saved-table")!;
  const rows = (table.content as { rows: Array<{ cells: unknown[] }> }).rows;
  expect(rows).toHaveLength(2);
  for (const [rowIndex, expected] of [["A", "B"], ["C", "D"]].entries()) {
    expect(rows[rowIndex].cells).toHaveLength(2);
    expected.forEach((value, column) => expect(JSON.stringify(rows[rowIndex].cells[column])).toContain(`"text":"${value}"`));
  }
  view.unmount();
  render(<WikiEditor initialContent={snapshot} />);
  await settle();
  checkpoint("new-valid-old-golden-reload");
  expect(() => editor().prosemirrorState.doc.check()).not.toThrow();
  // Persistence uses JSON: absent properties and undefined array slots have
  // the JSON representation recorded in snapshot, rather than JS identity.
  expect(JSON.parse(text())).toEqual(snapshot);
});
