import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { Component, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { Block } from "@blocknote/core";
import { useAuthStore } from "@/stores/auth-store";
import { stripPastedStyleSheets } from "@/lib/pasted-html";
import { apiBase } from "@/lib/api-url";

function useIsDark() {
  return useSyncExternalStore(
    (cb) => {
      const observer = new MutationObserver(cb);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      return () => observer.disconnect();
    },
    () => document.documentElement.classList.contains("dark"),
  );
}

export interface WikiEditorProps {
  initialContent?: unknown;
  recoveredContent?: unknown;
  hasUnsavedChanges?: boolean;
  readOnly?: boolean;
  workspaceId?: string;
  spaceId?: string;
  onChange?: (content: Block[]) => void;
}

interface EditorBoundaryProps {
  documentSignature: string | undefined;
  children: ReactNode;
}
interface EditorBoundaryState {
  documentSignature: string | undefined;
  failed: boolean;
}

class EditorBoundary extends Component<EditorBoundaryProps, EditorBoundaryState> {
  state: EditorBoundaryState = { documentSignature: this.props.documentSignature, failed: false };

  static getDerivedStateFromProps(props: EditorBoundaryProps, state: EditorBoundaryState) {
    if (props.documentSignature !== state.documentSignature) {
      return { documentSignature: props.documentSignature, failed: false };
    }
    return null;
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="rounded-md border p-4 text-sm space-y-2">
        <p>We couldn’t open this content. It has not been changed.</p>
        <button type="button" className="underline" onClick={() => this.setState({ failed: false })}>
          Try again
        </button>
      </div>
    );
  }
}

export function WikiEditor(props: WikiEditorProps) {
  const documentSignature = JSON.stringify(props.recoveredContent ?? props.initialContent);
  // The signature resets a failed child; it is never a key for a healthy editor.
  return (
    <EditorBoundary documentSignature={documentSignature}>
      <WikiEditorInner {...props} />
    </EditorBoundary>
  );
}

function WikiEditorInner({
  initialContent,
  recoveredContent,
  hasUnsavedChanges = false,
  readOnly = false,
  workspaceId,
  spaceId,
  onChange,
}: WikiEditorProps) {
  const isDark = useIsDark();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const applyingContent = useRef(false);
  const initialDocument = recoveredContent ?? initialContent;
  const appliedSource = useRef(JSON.stringify(initialContent));
  const wasDirty = useRef(hasUnsavedChanges);

  const editor = useCreateBlockNote({
    selectAllBehavior: "document",
    initialContent:
      Array.isArray(initialDocument) && initialDocument.length > 0
        ? (initialDocument as Block[])
        : undefined,
    // BlockNote pastes its own blocknote/html clipboard type, and drops HTML,
    // straight into prosemirror-view without re-serializing it.
    _tiptapOptions: {
      editorProps: { transformPastedHTML: stripPastedStyleSheets },
    },
    uploadFile: async (file: File) => {
      const token = useAuthStore.getState().accessToken;
      const baseUrl = apiBase();

      const formData = new FormData();
      if (workspaceId) formData.append("workspaceId", workspaceId);
      formData.append("purpose", "wiki");
      if (spaceId) formData.append("spaceId", spaceId);
      formData.append("file", file);

      const response = await fetch(`${baseUrl}/uploads`, {
        method: "POST",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: "include",
        body: formData,
      });

      if (!response.ok) {
        throw new Error("Image upload failed");
      }

      const result = (await response.json()) as { data: { url: string } };
      return result.data.url;
    },
  });

  // Toggling editability (Start/Done Editing) makes BlockNote report a change
  // for an unchanged document. Only real edits may reach autosave, or opening
  // the editor would save (and mark as edited) the page as it was.
  const lastDocument = useRef<string | null>(null);
  if (lastDocument.current === null) {
    lastDocument.current = JSON.stringify(editor.document);
  }

  // BlockNote may normalize the document while mounting; compare against that.
  useEffect(() => {
    lastDocument.current = JSON.stringify(editor.document);
  }, [editor]);

  const handleChange = useCallback(() => {
    const serialized = JSON.stringify(editor.document);
    if (serialized === lastDocument.current) return;
    lastDocument.current = serialized;
    if (!applyingContent.current && onChangeRef.current) {
      onChangeRef.current(editor.document);
    }
  }, [editor]);

  useEffect(() => {
    const source = JSON.stringify(initialContent);
    if (hasUnsavedChanges) {
      wasDirty.current = true;
      return;
    }
    if (wasDirty.current) {
      wasDirty.current = false;
      appliedSource.current = source;
      return;
    }
    if (source === appliedSource.current) return;
    appliedSource.current = source;
    applyingContent.current = true;
    editor.replaceBlocks(
      editor.document,
      Array.isArray(initialContent) && initialContent.length > 0
        ? (initialContent as Block[])
        : [{ type: "paragraph" }],
    );
    // A change event for this replacement, even a late one, is not an edit.
    lastDocument.current = JSON.stringify(editor.document);
    queueMicrotask(() => {
      applyingContent.current = false;
    });
  }, [editor, initialContent, hasUnsavedChanges]);

  // Changing the view's editable prop remounts its editor DOM. Keep that view
  // stable and apply the public editability preference before paint instead.
  useLayoutEffect(() => {
    editor.isEditable = !readOnly;
  }, [editor, readOnly]);

  return (
    <div className={`wiki-editor-wrapper${readOnly ? "" : " is-editing"}`}>
      <BlockNoteView
        editor={editor}
        onChange={handleChange}
        theme={isDark ? "dark" : "light"}
      />
    </div>
  );
}
