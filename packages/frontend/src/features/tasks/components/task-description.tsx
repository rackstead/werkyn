import { useCallback, useEffect, useRef } from "react";
import { stripDisallowedControlCharacters } from "@pm/shared";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { SafeHtml } from "@/components/safe-html";
import { sanitizeDescriptionHtml } from "@/lib/description-html";
import { stripPastedStyleSheets } from "@/lib/pasted-html";
import { useUpdateTask } from "../api";
import { useEntityAutosave } from "@/hooks/use-entity-autosave";
import { useAuthStore } from "@/stores/auth-store";
import { useRouter } from "@tanstack/react-router";
import { EditorNavigationGuard } from "@/components/shared/editor-navigation-guard";

// The server rejects control characters other than tab, line feed and carriage
// return in a description. A plain-text paste keeps them (Word's manual line
// break is U+000B, a page break U+000C), and descriptions saved before that
// rule may still hold them, so they are removed from pasted text and from
// every description sent to the server. Pasted breaks start a new paragraph;
// in HTML they become a space.
function pastedText(text: string) {
  return stripDisallowedControlCharacters(text, "\n");
}
function pastedHtml(html: string) {
  return stripPastedStyleSheets(stripDisallowedControlCharacters(html, " "));
}
function savableDescription(html: string | null) {
  return html === null ? null : stripDisallowedControlCharacters(html, " ");
}

interface TaskDescriptionProps {
  taskId: string;
  description: string | null;
  canEdit: boolean;
}

export function TaskDescription({
  taskId,
  description,
  canEdit,
}: TaskDescriptionProps) {
  const userId = useAuthStore((s) => s.user?.id ?? "anonymous");
  return (
    <TaskDescriptionEditor
      key={`${userId}:${taskId}`}
      taskId={taskId}
      description={description}
      canEdit={canEdit}
    />
  );
}

function TaskDescriptionEditor({
  taskId,
  description,
  canEdit,
}: TaskDescriptionProps) {
  const { mutateAsync: updateTask } = useUpdateTask();
  const userId = useAuthStore((s) => s.user?.id ?? "anonymous");
  const router = useRouter({ warn: false });
  const save = useCallback(
    (patch: { description: string | null }) => {
      if (useAuthStore.getState().user?.id !== userId) {
        return Promise.reject(
          new Error("Sign in as the author to save these changes"),
        );
      }
      return updateTask({
        description: savableDescription(patch.description),
        id: taskId,
        expectedUserId: userId,
      });
    },
    [taskId, updateTask, userId],
  );
  const autosave = useEntityAutosave(
    `task-description:${userId}:${taskId}`,
    save,
    {
      author: userId,
      // Tasks have no edit lock, so a description that failed to save is only
      // sent again when the user asks; it could otherwise replace a newer one.
      retryFailedAutomatically: false,
    },
  );
  const appliedSource = useRef(description);
  const wasDirty = useRef(autosave.hasUnsavedChanges);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: "Add a description..." }),
    ],
    content: sanitizeDescriptionHtml(
      (autosave.draft && "description" in autosave.draft
        ? autosave.draft.description
        : description) ?? "",
    ),
    editable: canEdit,
    editorProps: {
      transformPastedHTML: pastedHtml,
      transformPastedText: pastedText,
    },
    onUpdate: ({ editor: e }) => {
      autosave.schedule({ description: savableDescription(e.getHTML() || null) });
    },
    onBlur: () => {
      void autosave.flush().catch(() => {});
    },
  });

  // Update editable state if canEdit changes
  useEffect(() => {
    if (editor) {
      editor.setEditable(canEdit, false);
    }
  }, [editor, canEdit]);

  useEffect(() => {
    if (!editor) return;
    if (autosave.hasUnsavedChanges) {
      wasDirty.current = true;
      return;
    }
    if (wasDirty.current) {
      // The last save may finish before its invalidated detail GET. Do not
      // replace the saved local document with a source seen while it was dirty.
      wasDirty.current = false;
      appliedSource.current = description;
      return;
    }
    if (appliedSource.current === description) return;
    appliedSource.current = description;
    const next = sanitizeDescriptionHtml(description ?? "");
    // The detail refetch after a save usually returns the text already shown;
    // replacing an identical document would move the caret to the end.
    if (editor.getHTML() === next) return;
    editor.commands.setContent(next, { emitUpdate: false });
  }, [editor, description, autosave.hasUnsavedChanges]);

  if (!canEdit && !description) {
    return (
      <p className="text-sm text-muted-foreground italic">No description</p>
    );
  }

  if (!canEdit && description) {
    return (
      <SafeHtml
        className="prose prose-sm dark:prose-invert max-w-none"
        html={description}
      />
    );
  }

  return (
    <div className="rounded-md border p-3 min-h-[100px] [&_.tiptap]:outline-none [&_.tiptap_p.is-editor-empty:first-child::before]:text-muted-foreground [&_.tiptap_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.tiptap_p.is-editor-empty:first-child::before]:float-left [&_.tiptap_p.is-editor-empty:first-child::before]:h-0 [&_.tiptap_p.is-editor-empty:first-child::before]:pointer-events-none">
      {router && (
        <EditorNavigationGuard
          beforeLeave={autosave.flush}
          hasUnsavedChanges={autosave.hasUnsavedChanges}
        />
      )}
      {autosave.parked && (
        <div
          role="status"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-1.5 text-xs text-amber-800 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-200"
        >
          <span className="flex-1">
            Earlier changes to this description were not saved.
          </span>
          <button
            className="underline"
            onClick={() => {
              const restored = autosave.parked?.description ?? "";
              editor?.commands.setContent(sanitizeDescriptionHtml(restored), {
                emitUpdate: false,
              });
              void autosave.restoreParked().catch(() => {});
            }}
          >
            Restore changes
          </button>
          <button className="underline" onClick={autosave.discardParked}>
            Discard
          </button>
        </div>
      )}
      <EditorContent editor={editor} className="text-sm" />
      <div className="mt-2 text-xs text-muted-foreground" aria-live="polite">
        {autosave.status === "error" ? (
          <span role="alert">
            Changes not saved.{" "}
            <button
              className="underline"
              onClick={() => {
                void autosave.retry().catch(() => {});
              }}
            >
              Retry save
            </button>
          </span>
        ) : autosave.hasUnsavedChanges ? (
          "Saving changes…"
        ) : null}
      </div>
    </div>
  );
}
