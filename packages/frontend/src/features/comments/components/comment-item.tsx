import { useState } from "react";
import { stripDisallowedControlCharacters } from "@pm/shared";
import { UserAvatar } from "@/components/shared/user-avatar";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { useUpdateComment, useDeleteComment, type Comment } from "../api";
import { timeAgo } from "@/lib/time-ago";
import { Pencil, Trash2 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";

interface CommentItemProps {
  comment: Comment;
  taskId: string;
  currentUserId?: string;
  isAdmin: boolean;
  memberMap?: Map<string, string>;
}

function renderBody(body: string, memberMap?: Map<string, string>) {
  if (!memberMap || memberMap.size === 0) return body;
  const parts = body.split(/(@\[[^\]]+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^@\[([^\]]+)\]$/);
    if (match) {
      const name = memberMap.get(match[1]) ?? "Unknown";
      return (
        <span key={i} className="font-medium text-primary">
          @{name}
        </span>
      );
    }
    return part;
  });
}

export function CommentItem({
  comment,
  taskId,
  currentUserId,
  isAdmin,
  memberMap,
}: CommentItemProps) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body);
  const [showDelete, setShowDelete] = useState(false);

  const updateMutation = useUpdateComment(taskId);
  const deleteMutation = useDeleteComment(taskId);

  const canModify = isAdmin || comment.authorId === currentUserId;

  const handleSave = () => {
    const trimmed = stripDisallowedControlCharacters(editBody).trim();
    if (!trimmed || trimmed === comment.body) {
      setEditing(false);
      setEditBody(comment.body);
      return;
    }
    updateMutation.mutate(
      { id: comment.id, body: trimmed },
      { onSuccess: () => setEditing(false) },
    );
  };

  return (
    <>
      <div className="group flex gap-3">
        {comment.author ? (
          <UserAvatar
            displayName={comment.author.displayName}
            avatarUrl={comment.author.avatarUrl}
            size="sm"
          />
        ) : (
          <div className="h-6 w-6 shrink-0 rounded-full bg-muted" />
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              {comment.author?.displayName ?? "Deleted user"}
            </span>
            <span className="text-xs text-muted-foreground">
              {timeAgo(comment.createdAt)}
            </span>
            {comment.createdAt !== comment.updatedAt && (
              <span className="text-xs text-muted-foreground">(edited)</span>
            )}

            {canModify && !editing && (
              <div className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => {
                    setEditBody(comment.body);
                    setEditing(true);
                  }}
                  className="rounded p-0.5 hover:bg-accent text-muted-foreground hover:text-foreground"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  onClick={() => setShowDelete(true)}
                  className="rounded p-0.5 hover:bg-accent text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>

          {editing ? (
            <div className="mt-1 space-y-2">
              <Textarea
                autoFocus
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    handleSave();
                  }
                  if (e.key === "Escape") {
                    setEditing(false);
                    setEditBody(comment.body);
                  }
                }}
                rows={3}
                className="resize-none"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={updateMutation.isPending}
                  className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setEditing(false);
                    setEditBody(comment.body);
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-0.5 text-sm whitespace-pre-wrap break-words">
              {renderBody(comment.body, memberMap)}
            </p>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={showDelete}
        onClose={() => setShowDelete(false)}
        onConfirm={() => {
          deleteMutation.mutate(comment.id, {
            onSuccess: () => setShowDelete(false),
          });
        }}
        title="Delete comment"
        description="Are you sure you want to delete this comment? This action cannot be undone."
        confirmLabel="Delete"
        loading={deleteMutation.isPending}
      />
    </>
  );
}
