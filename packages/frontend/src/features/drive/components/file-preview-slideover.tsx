import type { DriveFile } from "../api";
import { useFilePreviewUrl, useFileTextContent } from "../api";
import { getPreviewType, getFileIcon, formatFileSize } from "@/lib/file-icons";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slideover } from "@/components/ui/slideover";
import { timeAgo } from "@/lib/time-ago";
import { usePdfPreview } from "../hooks/use-pdf-preview";

export interface FilePreviewSlideoverProps {
  file: DriveFile;
  workspaceId: string;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
  onDownload: (file: DriveFile) => void;
}

export function FilePreviewSlideover({
  file,
  workspaceId,
  onClose,
  onCloseAutoFocus,
  onDownload,
}: FilePreviewSlideoverProps) {
  const previewType = getPreviewType(file.mimeType);
  const isPdf = previewType === "pdf";
  const needsBlobUrl =
    !isPdf &&
    (previewType === "image" ||
      previewType === "video" ||
      previewType === "audio");
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

  const pdf = usePdfPreview(workspaceId, isPdf ? file.id : null);

  const Icon = getFileIcon(file.mimeType, false);

  return (
    <Slideover
      title={file.name}
      titleClassName="text-sm font-medium truncate mr-4"
      titleTooltip={file.name}
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus}
      className="max-w-2xl border-l"
      actions={
        <>
          {isPdf && !pdf.error && (
            <Button
              variant="ghost"
              size="sm"
              onClick={pdf.retry}
              disabled={pdf.isLoading}
            >
              Reload preview
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => onDownload(file)}>
            <Download className="h-4 w-4 mr-1" />
            Download
          </Button>
        </>
      }
    >
      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <PreviewContent
          previewType={previewType}
          blobUrl={blobUrl}
          pdfUrl={pdf.url}
          pdfError={pdf.error}
          retryPdf={pdf.retry}
          onPdfError={pdf.reportFrameError}
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
  pdfError,
  retryPdf,
  onPdfError,
  textContent,
  file,
  Icon,
}: {
  previewType: string;
  blobUrl: string | undefined;
  pdfUrl: string | undefined;
  pdfError: string | null;
  retryPdf: () => void;
  onPdfError: () => void;
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
    if (pdfError)
      return (
        <div className="flex flex-col items-center gap-3 py-8">
          <p role="alert" className="text-sm text-muted-foreground">
            {pdfError}
          </p>
          <Button variant="outline" size="sm" onClick={retryPdf}>
            Retry preview
          </Button>
        </div>
      );
    if (!pdfUrl) return <PreviewLoading />;
    return (
      <iframe
        src={pdfUrl}
        referrerPolicy="no-referrer"
        ref={(node) => {
          if (!node) return;
          // Listen directly: the native iframe error event does not bubble.
          node.addEventListener("error", onPdfError);
          return () => node.removeEventListener("error", onPdfError);
        }}
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
