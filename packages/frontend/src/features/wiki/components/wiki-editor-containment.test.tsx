import { useState } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { writeFileSync } from "node:fs";
import type { Block, BlockNoteEditor } from "@blocknote/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WikiEditor } from "./wiki-editor";
import persisted046Document from "./fixtures/blocknote046-document.json";

// Capture the actual public editor returned by the real hook. The hook, core,
// Mantine view and editor DOM all execute; no editor or view is substituted.
const { observed } = vi.hoisted(() => ({
  observed: { current: null as BlockNoteEditor | null, attempts: 0, editors: new Set<BlockNoteEditor>() },
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
      observed.attempts++;
      const editor = actual.useCreateBlockNote(...args);
      observed.current = editor;
      observed.editors.add(editor);
      return editor;
    },
  };
});

beforeEach(() => {
  observed.attempts = 0;
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

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const valid = () => [
  { id: "identity-first", type: "paragraph", content: "Owned first text" },
  { id: "identity-last", type: "paragraph", content: "Owned last text" },
];
function Host({ source, recovered, dirty = false, marker = 0, onChange }: {
  source: unknown; recovered?: unknown; dirty?: boolean; marker?: number;
  onChange: (value: Block[]) => void;
}) {
  const [clicks, setClicks] = useState(0);
  return <div><button onClick={() => setClicks(value => value + 1)}>Owned sibling {clicks}</button>
    <span data-testid="owned-marker">{marker}</span>
    <WikiEditor initialContent={source} recoveredContent={recovered} hasUnsavedChanges={dirty} onChange={onChange} />
  </div>;
}
async function settle() { await act(async () => {}); }
function actual() { expect(observed.current).not.toBeNull(); return observed.current!; }
function recordSources(label: string, source: unknown, recovered?: unknown) {
  if (!process.env.BLOCKNOTE_COMPAT_FACTS_PATH) return;
  facts.push({test: expect.getState().currentTestName, label, source: clone(source), recovered: recovered === undefined ? undefined : clone(recovered)});
  writeFileSync(process.env.BLOCKNOTE_COMPAT_FACTS_PATH, JSON.stringify(facts, null, 2));
}

it("constructor failure stays inside the editor without changing stored input or sibling controls", async () => {
  const source = clone(persisted046Document); const onChange = vi.fn(); recordSources("before-invalid-constructor", source);
  const view = render(<Host source={source} onChange={onChange} />); await settle();
  expect(view.getByRole("alert").textContent).toMatch(/couldn.t open|cannot open|could not be opened/i);
  expect(view.container.querySelector(".bn-editor")).toBeNull();
  fireEvent.click(view.getByRole("button", {name: "Owned sibling 0"}));
  expect(view.getByRole("button", {name: "Owned sibling 1"})).toBeTruthy();
  expect(source).toEqual(persisted046Document); expect(onChange).not.toHaveBeenCalled();
  recordSources("after-contained-constructor", source);
});

it("only a failed editor retries identical content explicitly or resets on actual selected JSON change", async () => {
  const onChange = vi.fn(); const view = render(<Host source={clone(persisted046Document)} onChange={onChange} />); await settle();
  const sibling = view.getByRole("button", {name: "Owned sibling 0"}); const attempts = observed.attempts;
  expect(view.getByRole("alert")).toBeTruthy();
  view.rerender(<Host source={clone(persisted046Document)} marker={1} onChange={onChange} />); await settle();
  expect(observed.attempts).toBe(attempts); expect(view.getByRole("button", {name: "Owned sibling 0"})).toBe(sibling);
  fireEvent.click(view.getByRole("button", {name: /try again|retry|try opening/i})); await settle();
  expect(observed.attempts).toBeGreaterThan(attempts); expect(view.getByRole("alert")).toBeTruthy(); expect(onChange).not.toHaveBeenCalled();
  view.rerender(<Host source={valid()} marker={2} onChange={onChange} />); await settle();
  expect(view.queryByRole("alert")).toBeNull(); expect(actual().document.map(block => block.id)).toEqual(["identity-first", "identity-last"]);
  expect(() => actual().prosemirrorState.doc.check()).not.toThrow(); expect(view.getByRole("button", {name: "Owned sibling 0"})).toBe(sibling);
  expect(onChange).not.toHaveBeenCalled();
});

it("healthy editor identity and cursor survive identical refetch and unrelated caller renders", async () => {
  const onChange = vi.fn(); const source = valid(); const view = render(<Host source={source} onChange={onChange} />); await settle();
  const instance = actual(); act(() => instance.setTextCursorPosition("identity-last", "end"));
  const snapshot = clone(instance.document); const cursor = instance.getTextCursorPosition().block.id; onChange.mockClear();
  view.rerender(<Host source={clone(source)} marker={1} onChange={onChange} />); await settle();
  expect(actual()).toBe(instance); expect(actual().getTextCursorPosition().block.id).toBe(cursor); expect(clone(actual().document)).toEqual(snapshot);
  view.rerender(<Host source={[{id:"identity-first",type:"paragraph",content:"Owned newer first text"},{id:"identity-last",type:"paragraph",content:"Owned last text"}]} marker={2} onChange={onChange} />); await settle();
  expect(actual()).toBe(instance); expect(JSON.stringify(actual().document)).toContain("Owned newer first text"); expect(onChange).not.toHaveBeenCalled();
});

it("invalid recovered input stays owned by the caller until an explicit source change removes it", async () => {
  const source = valid(); const recovered = clone(persisted046Document); const original = clone(recovered); const onChange = vi.fn(); recordSources("before-invalid-recovered-source", source, recovered);
  const view = render(<Host source={source} recovered={recovered} dirty onChange={onChange} />); await settle();
  expect(view.getByRole("alert")).toBeTruthy(); expect(source).toEqual(valid()); expect(recovered).toEqual(original); expect(onChange).not.toHaveBeenCalled();
  const sibling = view.getByRole("button", {name:"Owned sibling 0"});
  // This is caller-prop ownership, not proof of the real page queue/Discard protocol.
  view.rerender(<Host source={source} onChange={onChange} />); await settle();
  expect(view.queryByRole("alert")).toBeNull(); expect(actual().document.map(block => block.id)).toEqual(["identity-first","identity-last"]);
  expect(view.getByRole("button", {name:"Owned sibling 0"})).toBe(sibling); expect(recovered).toEqual(original); expect(onChange).not.toHaveBeenCalled();
  recordSources("after-owned-recovered-source-kept", source, recovered);
});
