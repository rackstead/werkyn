import { useMemo } from "react";
import type { DriveFile } from "../api";
import { useFilePreviewUrl, useFileTextContent } from "../api";
import { getPreviewType, getFileIcon, formatFileSize } from "@/lib/file-icons";
import { useAuthStore } from "@/stores/auth-store";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slideover } from "@/components/ui/slideover";
import { timeAgo } from "@/lib/time-ago";
import { apiBase } from "@/lib/api-url";

interface FilePreviewSlideoverProps {
  file: DriveFile;
  workspaceId: string;
  onClose: () => void;
  onDownload: (file: DriveFile) => void;
}

export function FilePreviewSlideover({
  file,
  workspaceId,
  onClose,
  onDownload,
}: FilePreviewSlideoverProps) {
  const previewType = getPreviewType(file.mimeType);
  const isPdf = previewType === "pdf";
  const needsBlobUrl = !isPdf && (previewType === "image" || previewType === "video" || previewType === "audio");
  const needsText = previewType === "text";

  // This component owns blobUrl: the hook revokes it when the file changes or
  // the preview closes.
  const { data: blobUrl } = useFilePreviewUrl(
    workspaceId,
    needsBlobUrl ? file.id : null,
    file.mimeType,
  );
  const { data: textContent } = useFileTextContent(
    workspaceId,
    needsText ? file.id : null,
  );

  // Direct URL for PDF — lets the browser's native PDF viewer handle it
  const pdfUrl = useMemo(() => {
    if (!isPdf) return undefined;
    const token = useAuthStore.getState().accessToken;
    const baseUrl = apiBase();
    const params = new URLSearchParams({ inline: "true" });
    if (token) params.set("token", token);
    return `${baseUrl}/workspaces/${workspaceId}/files/${file.id}/download?${params.toString()}`;
  }, [isPdf, workspaceId, file.id]);

  const Icon = getFileIcon(file.mimeType, false);

  return (
    <Slideover
      title={file.name}
      titleClassName="text-sm font-medium truncate mr-4"
      titleTooltip={file.name}
      onClose={onClose}
      className="max-w-2xl border-l"
      actions={
        <Button variant="ghost" size="sm" onClick={() => onDownload(file)}>
          <Download className="h-4 w-4 mr-1" />
          Download
        </Button>
      }
    >
      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <PreviewContent
          previewType={previewType}
          blobUrl={blobUrl}
          pdfUrl={pdfUrl}
          textContent={textContent}
          file={file}
          Icon={Icon}
        />

        {/* Metadata section */}
        <div className="mt-6 space-y-2 border-t pt-4">
          <MetadataRow label="Name" value={file.name} />
          <MetadataRow label="Size" value={formatFileSize(file.size)} />
          <MetadataRow label="Type" value={file.mimeType ?? "Unknown"} />
          <MetadataRow
            label="Uploaded by"
            value={file.uploadedBy?.displayName ?? "Unknown"}
          />
          <MetadataRow label="Modified" value={timeAgo(file.updatedAt)} />
        </div>
      </div>
    </Slideover>
  );
}

function PreviewContent({
  previewType,
  blobUrl,
  pdfUrl,
  textContent,
  file,
  Icon,
}: {
  previewType: string;
  blobUrl: string | undefined;
  pdfUrl: string | undefined;
  textContent: string | undefined;
  file: DriveFile;
  Icon: React.ComponentType<{ className?: string }>;
}) {
  if (previewType === "image") {
    if (!blobUrl) return <PreviewLoading />;
    return (
      <div className="flex items-center justify-center">
        <img
          src={blobUrl}
          alt={file.name}
          className="max-h-[60vh] max-w-full rounded-md object-contain"
        />
      </div>
    );
  }

  if (previewType === "video") {
    if (!blobUrl) return <PreviewLoading />;
    return (
      <div className="flex items-center justify-center">
        <video
          src={blobUrl}
          controls
          className="max-h-[60vh] max-w-full rounded-md"
        />
      </div>
    );
  }

  if (previewType === "audio") {
    if (!blobUrl) return <PreviewLoading />;
    return (
      <div className="flex items-center justify-center py-8">
        <audio src={blobUrl} controls className="w-full max-w-md" />
      </div>
    );
  }

  if (previewType === "pdf") {
    if (!pdfUrl) return <PreviewLoading />;
    return (
      <iframe
        src={pdfUrl}
        title={file.name}
        className="h-[60vh] w-full rounded-md border"
      />
    );
  }

  if (previewType === "text") {
    if (textContent === undefined) return <PreviewLoading />;
    return (
      <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted/50 p-4 text-sm font-mono whitespace-pre-wrap break-words">
        {textContent}
      </pre>
    );
  }

  // Unsupported
  return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
      <Icon className="h-16 w-16 mb-4" />
      <p className="text-sm font-medium">{file.name}</p>
      <p className="text-xs mt-1">Preview not available for this file type</p>
    </div>
  );
}

function PreviewLoading() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="text-muted-foreground w-24 shrink-0">{label}</span>
      <span className="truncate">{value}</span>
    </div>
  );
}
