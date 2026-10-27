import { useState } from "react";
import {
  useAttachments,
  useDeleteAttachment,
  useDownloadAttachment,
  useLinkAttachment,
} from "../api";
import { getFileIcon, formatFileSize } from "@/lib/file-icons";
import { Paperclip, Download, X, Plus, HardDrive, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { DriveFilePicker } from "@/features/drive/components/drive-file-picker";

interface AttachmentListProps {
  workspaceId: string;
  taskId: string;
  canEdit: boolean;
}

export function AttachmentList({
  workspaceId,
  taskId,
  canEdit,
}: AttachmentListProps) {
  const { data, isLoading } = useAttachments(workspaceId, "task", taskId);
  const deleteAttachment = useDeleteAttachment(workspaceId, "task", taskId);
  const linkAttachment = useLinkAttachment(workspaceId, "task", taskId);
  const downloadAttachment = useDownloadAttachment(workspaceId);
  const [showDrivePicker, setShowDrivePicker] = useState(false);

  const attachments = data?.data ?? [];

  const handleDownload = (attachmentId: string, name: string) => {
    downloadAttachment.mutate(
      { attachmentId, fileName: name },
      { onError: () => toast.error("Download failed") },
    );
  };

  const handleDelete = (attachmentId: string) => {
    deleteAttachment.mutate(attachmentId, {
      onError: (err) => toast.error(err.message || "Failed to delete"),
    });
  };

  // Hide section entirely if no attachments and user can't edit
  if (!canEdit && attachments.length === 0 && !isLoading) return null;

  return (
    <div>
      <h3 className="text-sm font-medium mb-2 text-muted-foreground flex items-center gap-1.5">
        <Paperclip className="h-3.5 w-3.5" />
        Attachments
        {attachments.length > 0 && (
          <span className="text-xs">({attachments.length})</span>
        )}
      </h3>

      {attachments.length > 0 && (
        <div className="space-y-1 mb-2">
          {attachments.map((att) => {
            const Icon = getFileIcon(att.mimeType, false);
            const unavailable = !att.file || !!att.file.trashedAt;
            return (
              <div
                key={att.id}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50 transition-colors group"
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate flex-1">{att.name}</span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {formatFileSize(att.size)}
                </span>
                {att.fileId && att.file?.trashedAt && (
                  <span title="Source file is in trash">
                    <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
                  </span>
                )}
                {!att.file && (
                  <span title="Source file is unavailable">
                    <AlertTriangle className="h-3 w-3 shrink-0 text-destructive" />
                  </span>
                )}
                {att.fileId && att.file && !att.file.trashedAt && (
                  <span title="Linked from Drive">
                    <HardDrive className="h-3 w-3 shrink-0 text-muted-foreground" />
                  </span>
                )}
                <button
                  onClick={() => handleDownload(att.id, att.name)}
                  disabled={unavailable}
                  className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-accent transition-all"
                  title={unavailable ? "Source file is unavailable" : "Download"}
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
                {canEdit && (
                  <button
                    onClick={() => handleDelete(att.id)}
                    className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-accent transition-all text-muted-foreground hover:text-destructive"
                    title="Remove"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {canEdit && (
        <button
          onClick={() => setShowDrivePicker(true)}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Attach file
        </button>
      )}

      <DriveFilePicker
        open={showDrivePicker}
        onClose={() => setShowDrivePicker(false)}
        workspaceId={workspaceId}
        isPending={linkAttachment.isPending}
        onSelect={(file) => {
          linkAttachment.mutate(file.id, {
            onSuccess: () => {
              setShowDrivePicker(false);
            },
            onError: (err) =>
              toast.error(err.message || "Failed to link file"),
          });
        }}
      />
    </div>
  );
}
