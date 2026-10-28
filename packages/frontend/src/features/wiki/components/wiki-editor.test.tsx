import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WikiEditor } from "./wiki-editor";

const { state } = vi.hoisted(() => ({
  state: { editor: null as any, changed: null as (() => void) | null },
}));
vi.mock("@blocknote/react", async () => {
  const React = await import("react");
  return {
    useCreateBlockNote: (options: { initialContent?: unknown[] }) => {
      const [editor] = React.useState(() => ({
        document: options.initialContent ?? [{ type: "paragraph" }],
        isEditable: true,
        replaceBlocks: vi.fn((_old: unknown, next: unknown[]) => {
          editor.document = next;
          state.changed?.();
        }),
      }));
      state.editor = editor;
      return editor;
    },
  };
});
vi.mock("@blocknote/mantine", () => ({
  BlockNoteView: ({ onChange }: { onChange: () => void }) => {
    state.changed = onChange;
    return <button onClick={onChange}>Local edit</button>;
  },
}));

afterEach(() => {
  cleanup();
  state.editor = null;
  state.changed = null;
});

it("initializes from the session's unsaved draft instead of the stored document", () => {
  const recovered = [{ type: "paragraph", content: "recovered draft" }];
  render(
    <WikiEditor
      initialContent={[{ type: "paragraph", content: "server" }]}
      recoveredContent={recovered}
    />,
  );
  expect(state.editor.document).toEqual(recovered);
});

it("an editability toggle that leaves the document unchanged is not reported as an edit", () => {
  const onChange = vi.fn();
  const screen = render(
    <WikiEditor
      initialContent={[{ type: "paragraph", content: "stored" }]}
      readOnly
      onChange={onChange}
    />,
  );
  screen.rerender(
    <WikiEditor
      initialContent={[{ type: "paragraph", content: "stored" }]}
      onChange={onChange}
    />,
  );
  // BlockNote reports a change when editability flips, with the same document.
  state.changed?.();
  expect(onChange).not.toHaveBeenCalled();
  const edited = [{ type: "paragraph", content: "typed" }];
  state.editor.document = edited;
  state.changed?.();
  expect(onChange).toHaveBeenCalledWith(edited);
});
