import { useMemo, useState, useCallback } from "react";
import { useSharedWithMe, useDownloadFile, type DriveFile } from "../api";
import { FilePreviewSlideover } from "./lazy-drive-panels";
import { UserAvatar } from "@/components/shared/user-avatar";
import { getFileIcon, formatFileSize } from "@/lib/file-icons";
import { timeAgo } from "@/lib/time-ago";
import { Loader2 } from "lucide-react";

interface SharedWithMeViewProps {
  workspaceId: string;
  workspaceSlug: string;
}

export function SharedWithMeView({
  workspaceId,
  workspaceSlug,
}: SharedWithMeViewProps) {
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useSharedWithMe(workspaceId);
  const downloadFile = useDownloadFile(workspaceId);
  const [previewFile, setPreviewFile] = useState<DriveFile | null>(null);

  const entries = useMemo(
    () => (data?.pages ?? []).flatMap((p) => p.data),
    [data],
  );

  const handleDownload = useCallback(
    (file: DriveFile) => {
      downloadFile.mutate({ fileId: file.id, fileName: file.name });
    },
    [downloadFile],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-6 pb-4">
        <h1 className="text-2xl font-bold">Shared with me</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Files that others have shared with you
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <p className="text-sm">No files shared with you yet</p>
          </div>
        ) : (
          <div>
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-4 py-2 font-medium">File</th>
                  <th scope="col" className="px-4 py-2 font-medium w-24">Size</th>
                  <th scope="col" className="px-4 py-2 font-medium w-40">Shared by</th>
                  <th scope="col" className="px-4 py-2 font-medium w-28">Date shared</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const file = entry.file;
                  const Icon = getFileIcon(file.mimeType, file.isFolder);
                  return (
                    <tr
                      key={entry.id}
                      className="border-b hover:bg-accent/50 transition-colors cursor-pointer"
                      onClick={() => {
                        if (!file.isFolder) setPreviewFile(file);
                      }}
                    >
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="truncate text-sm">{file.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2 text-sm text-muted-foreground whitespace-nowrap">
                        {file.isFolder ? "\u2014" : formatFileSize(file.size)}
                      </td>
                      <td className="px-4 py-2">
                        {entry.sharedBy && (
                          <div className="flex items-center gap-2">
                            <UserAvatar
                              displayName={entry.sharedBy.displayName}
                              avatarUrl={entry.sharedBy.avatarUrl}
                              size="sm"
                            />
                            <span className="text-sm truncate">
                              {entry.sharedBy.displayName}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-sm text-muted-foreground whitespace-nowrap">
                        {timeAgo(entry.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {hasNextPage && (
              <div className="flex justify-center py-4">
                {isFetchingNextPage ? (
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                ) : (
                  <button
                    onClick={() => fetchNextPage()}
                    className="text-sm text-muted-foreground hover:text-foreground"
                  >
                    Load more
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {previewFile && (
        <FilePreviewSlideover
          file={previewFile}
          workspaceId={workspaceId}
          onClose={() => setPreviewFile(null)}
          onDownload={handleDownload}
        />
      )}
    </div>
  );
}
