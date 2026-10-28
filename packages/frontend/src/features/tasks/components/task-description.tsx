import { useCallback, useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import DOMPurify from "dompurify";
import { SafeHtml } from "@/components/safe-html";
import { useUpdateTask } from "../api";
import { useEntityAutosave } from "@/hooks/use-entity-autosave";
import { useAuthStore } from "@/stores/auth-store";
import { useRouter } from "@tanstack/react-router";
import { EditorNavigationGuard } from "@/components/shared/editor-navigation-guard";

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
      return updateTask({ ...patch, id: taskId, expectedUserId: userId });
    },
    [taskId, updateTask, userId],
  );
  const autosave = useEntityAutosave(
    `task-description:${userId}:${taskId}`,
    save,
  );

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: "Add a description..." }),
    ],
    content: DOMPurify.sanitize(
      (autosave.draft && "description" in autosave.draft
        ? autosave.draft.description
        : description) ?? "",
    ),
    editable: canEdit,
    onUpdate: ({ editor: e }) => {
      autosave.schedule({ description: e.getHTML() || null });
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
      <EditorContent editor={editor} className="text-sm" />
      <div className="mt-2 text-xs text-muted-foreground" aria-live="polite">
        {autosave.status === "error" ? (
          <span role="alert">
            Changes not saved.{" "}
            <button
              className="underline"
              onClick={() => {
                void autosave.flush().catch(() => {});
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
