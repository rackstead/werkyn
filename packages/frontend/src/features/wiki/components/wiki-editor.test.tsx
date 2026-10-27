import { act, cleanup, fireEvent, render } from "@testing-library/react";
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

it("replaces an idle same-page document after restore without resaving the programmatic update", async () => {
  const onChange = vi.fn();
  const initial = [{ type: "paragraph", content: "old" }],
    restored = [{ type: "paragraph", content: "restored" }];
  const screen = render(
    <WikiEditor initialContent={initial} onChange={onChange} />,
  );
  screen.rerender(<WikiEditor initialContent={restored} onChange={onChange} />);
  await act(async () => {});
  expect(state.editor.document).toEqual(restored);
  expect(onChange).not.toHaveBeenCalled();
  const edited = [{ type: "paragraph", content: "restored and edited" }];
  state.editor.document = edited;
  fireEvent.click(screen.getByText("Local edit"));
  expect(onChange).toHaveBeenCalledWith(edited);
});

it("does not replace unsaved local blocks when a query refresh arrives", async () => {
  const old = [{ type: "paragraph", content: "old" }],
    remote = [{ type: "paragraph", content: "remote" }];
  const screen = render(<WikiEditor initialContent={old} hasUnsavedChanges />);
  const local = [{ type: "paragraph", content: "local draft" }];
  state.editor.document = local;
  screen.rerender(<WikiEditor initialContent={remote} hasUnsavedChanges />);
  await act(async () => {});
  expect(state.editor.document).toEqual(local);
  expect(state.editor.replaceBlocks).not.toHaveBeenCalled();
  screen.rerender(
    <WikiEditor initialContent={remote} hasUnsavedChanges={false} />,
  );
  await act(async () => {});
  expect(state.editor.document).toEqual(local);
  const later = [{ type: "paragraph", content: "later idle update" }];
  screen.rerender(<WikiEditor initialContent={later} />);
  await act(async () => {});
  expect(state.editor.document).toEqual(later);
});

it("initializes from the session's unsaved draft instead of the stored document", () => {
  const recovered = [{ type: "paragraph", content: "recovered draft" }];
  render(
    <WikiEditor
      initialContent={[{ type: "paragraph", content: "server" }]}
      recoveredContent={recovered}
      hasUnsavedChanges
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
