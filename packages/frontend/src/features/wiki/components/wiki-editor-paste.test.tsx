import { act, cleanup, render } from "@testing-library/react";
import type { BlockNoteEditor } from "@blocknote/core";
import { afterEach, expect, it, vi } from "vitest";
import { WikiEditor } from "./wiki-editor";

// A real BlockNote editor built from the options WikiEditor passes, without
// the Mantine view around it.
const { state } = vi.hoisted(() => ({
  state: { editor: null as BlockNoteEditor | null },
}));
vi.mock("@blocknote/react", async () => {
  const React = await import("react");
  const { BlockNoteEditor } = await import("@blocknote/core");
  return {
    useCreateBlockNote: (
      options: Parameters<typeof BlockNoteEditor.create>[0],
    ) => {
      const [editor] = React.useState(() => {
        const created = BlockNoteEditor.create(options);
        const host = document.createElement("div");
        document.body.appendChild(host);
        created.mount(host);
        return created;
      });
      state.editor = editor as unknown as BlockNoteEditor;
      return editor;
    },
  };
});
vi.mock("@blocknote/mantine", () => ({ BlockNoteView: () => null }));

afterEach(() => {
  cleanup();
  state.editor?.unmount();
  state.editor = null;
  document.body.innerHTML = "";
});

// jsdom has no ClipboardEvent; EditorView.pasteHTML creates one.
class TestClipboardEvent extends Event {
  readonly clipboardData = null;
}

function captureClipboardDocuments() {
  vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
  const created: Document[] = [];
  const createHTMLDocument = document.implementation.createHTMLDocument.bind(
    document.implementation,
  );
  const spy = vi
    .spyOn(document.implementation, "createHTMLDocument")
    .mockImplementation((title?: string) => {
      const doc = createHTMLDocument(title);
      created.push(doc);
      return doc;
    });
  return {
    created,
    restore: () => {
      spy.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

function documentText(editor: BlockNoteEditor) {
  return JSON.stringify(editor.document);
}

it("a raw BlockNote clipboard paste drops style sheets before prosemirror-view reads it", () => {
  render(<WikiEditor initialContent={[]} />);
  const editor = state.editor!;
  const clipboard = captureClipboardDocuments();
  act(() => {
    // The blocknote/html clipboard type is pasted without re-serializing.
    editor.pasteHTML(
      '<style>.cb{font-weight:bold}</style><link rel="stylesheet" href="https://attacker.example/x.css">' +
        '<p><span class="cb">Raw</span> paste</p><svg><style>p{color:red}</style></svg>',
      true,
    );
  });
  clipboard.restore();
  expect(clipboard.created.length).toBeGreaterThan(0);
  for (const doc of clipboard.created) {
    expect(doc.querySelectorAll("style, link, meta")).toHaveLength(0);
  }
  expect(documentText(editor)).toContain('"text":"Raw paste"');
  expect(documentText(editor)).not.toContain("font-weight");
  expect(documentText(editor)).not.toContain("color:red");
});

it("an ordinary raw BlockNote paste keeps its blocks and formatting", () => {
  render(<WikiEditor initialContent={[]} />);
  const editor = state.editor!;
  const clipboard = captureClipboardDocuments();
  act(() => {
    editor.pasteHTML(
      "<meta charset='utf-8'><h2>Title</h2><p><strong>Bold</strong> and <em>italic</em></p>" +
        "<ul><li><p>Item</p></li></ul>",
      true,
    );
  });
  clipboard.restore();
  const blocks = editor.document.map((block) => ({
    type: block.type,
    content: block.content,
  }));
  expect(blocks.slice(0, 3)).toEqual([
    {
      type: "heading",
      content: [{ type: "text", text: "Title", styles: {} }],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Bold", styles: { bold: true } },
        { type: "text", text: " and ", styles: {} },
        { type: "text", text: "italic", styles: { italic: true } },
      ],
    },
    {
      type: "bulletListItem",
      content: [{ type: "text", text: "Item", styles: {} }],
    },
  ]);
});
