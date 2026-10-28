import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { Block } from "@blocknote/core";
import { useAuthStore } from "@/stores/auth-store";

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

interface WikiEditorProps {
  initialContent?: unknown;
  recoveredContent?: unknown;
  readOnly?: boolean;
  workspaceId?: string;
  spaceId?: string;
  onChange?: (content: Block[]) => void;
}

export function WikiEditor({
  initialContent,
  recoveredContent,
  readOnly = false,
  workspaceId,
  spaceId,
  onChange,
}: WikiEditorProps) {
  const isDark = useIsDark();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initialDocument = recoveredContent ?? initialContent;

  const editor = useCreateBlockNote({
    initialContent:
      Array.isArray(initialDocument) && initialDocument.length > 0
        ? (initialDocument as Block[])
        : undefined,
    uploadFile: async (file: File) => {
      const token = useAuthStore.getState().accessToken;
      const baseUrl = import.meta.env.VITE_API_BASE_URL || "/api";

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
    if (onChangeRef.current) {
      onChangeRef.current(editor.document);
    }
  }, [editor]);

  // Sync readOnly state
  useEffect(() => {
    editor.isEditable = !readOnly;
  }, [editor, readOnly]);

  return (
    <div className={`wiki-editor-wrapper${readOnly ? "" : " is-editing"}`}>
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        onChange={handleChange}
        theme={isDark ? "dark" : "light"}
      />
    </div>
  );
}
