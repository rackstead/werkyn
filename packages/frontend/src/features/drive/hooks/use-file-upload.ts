import { useState, useCallback, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { uploadSingleFile, type DriveFile } from "../api";
import type { UploadItem } from "../components/upload-progress";
import { toast } from "sonner";
import { identityGeneration } from "@/lib/identity";

interface UseFileUploadOptions {
  workspaceId: string;
  parentId?: string | null;
  teamFolderId?: string;
  onFileUploaded?: (file: DriveFile) => void;
  onAllComplete?: (files: DriveFile[]) => void;
  autoClearMs?: number;
}

export function useFileUpload({
  workspaceId,
  parentId,
  teamFolderId,
  onFileUploaded,
  onAllComplete,
  autoClearMs,
}: UseFileUploadOptions) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const mountedRef = useRef(true);
  const abortHandlesRef = useRef<Map<string, () => void>>(new Map());
  const qc = useQueryClient();

  // Store latest values in refs so the async upload callback always reads
  // current parentId/teamFolderId, even if the user navigates mid-upload.
  const parentIdRef = useRef(parentId);
  const teamFolderIdRef = useRef(teamFolderId);
  const onFileUploadedRef = useRef(onFileUploaded);
  const onAllCompleteRef = useRef(onAllComplete);

  useEffect(() => { parentIdRef.current = parentId; }, [parentId]);
  useEffect(() => { teamFolderIdRef.current = teamFolderId; }, [teamFolderId]);
  useEffect(() => { onFileUploadedRef.current = onFileUploaded; }, [onFileUploaded]);
  useEffect(() => { onAllCompleteRef.current = onAllComplete; }, [onAllComplete]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const abort of abortHandlesRef.current.values()) {
        abort();
      }
      abortHandlesRef.current.clear();
    };
  }, []);

  const handleUpload = useCallback(
    (fileList: File[]) => {
      // Snapshot the current folder context at the time the user drops/selects files.
      const uploadParentId = parentIdRef.current ?? null;
      const uploadTeamFolderId = teamFolderIdRef.current;
      // The files belong to the account that chose them: once the signed-in
      // account changes, queued files are not uploaded as the next one.
      const generation = identityGeneration();
      const sameAccount = () => identityGeneration() === generation;

      const items: UploadItem[] = fileList.map((f) => ({
        id: Math.random().toString(36).slice(2) + Date.now().toString(36),
        name: f.name,
        size: f.size,
        status: "uploading" as const,
        progress: 0,
        loaded: 0,
        speed: 0,
      }));

      setUploads((prev) => [...prev, ...items]);

      const uploadAll = async () => {
        const completed: DriveFile[] = [];

        const uploadOne = async (file: File, item: UploadItem) => {
          let lastLoaded = 0;
          let lastTime = Date.now();
          let prevSpeed = 0;

          try {
            const { promise, abort } = uploadSingleFile(
              workspaceId,
              file,
              uploadParentId,
              uploadTeamFolderId,
              (loaded, total) => {
                const now = Date.now();
                const elapsed = (now - lastTime) / 1000;
                const instantSpeed =
                  elapsed > 0
                    ? (loaded - lastLoaded) / Math.max(elapsed, 0.1)
                    : 0;
                const speed = prevSpeed === 0
                  ? instantSpeed
                  : 0.3 * instantSpeed + 0.7 * prevSpeed;
                prevSpeed = speed;
                lastLoaded = loaded;
                lastTime = now;

                if (mountedRef.current) {
                  setUploads((prev) =>
                    prev.map((u) =>
                      u.id === item.id
                        ? { ...u, progress: (loaded / total) * 100, loaded, speed }
                        : u,
                    ),
                  );
                }
              },
            );

            abortHandlesRef.current.set(item.id, abort);
            const uploaded = await promise;
            abortHandlesRef.current.delete(item.id);
            completed.push(uploaded);

            if (mountedRef.current) {
              setUploads((prev) =>
                prev.map((u) =>
                  u.id === item.id
                    ? { ...u, status: "done" as const, progress: 100, loaded: file.size, speed: 0 }
                    : u,
                ),
              );
              onFileUploadedRef.current?.(uploaded);
            }
          } catch (err) {
            abortHandlesRef.current.delete(item.id);
            if (err instanceof DOMException && err.name === "AbortError") return;

            if (mountedRef.current) {
              setUploads((prev) =>
                prev.map((u) =>
                  u.id === item.id ? { ...u, status: "error" as const, speed: 0 } : u,
                ),
              );
            }
            toast.error(err instanceof Error ? err.message : `Upload failed: ${file.name}`);
          }
        };

        const MAX_CONCURRENT = 3;
        let nextIndex = 0;
        const runNext = async (): Promise<void> => {
          const i = nextIndex++;
          if (i >= fileList.length) return;
          if (!sameAccount()) {
            if (mountedRef.current) {
              setUploads((prev) =>
                prev.map((u) =>
                  u.id === items[i].id ? { ...u, status: "error" as const, speed: 0 } : u,
                ),
              );
            }
            await runNext();
            return;
          }
          await uploadOne(fileList[i], items[i]);
          await runNext();
        };

        await Promise.all(
          Array.from({ length: Math.min(MAX_CONCURRENT, fileList.length) }, () => runNext()),
        );
        if (!sameAccount()) return;

        // Broad invalidation: sort params in the key mean we can't target
        // a specific sorted query, so invalidate all file queries.
        qc.invalidateQueries({ queryKey: ["files"] });

        if (mountedRef.current) {
          onAllCompleteRef.current?.(completed);

          if (autoClearMs != null) {
            setTimeout(() => {
              if (mountedRef.current) {
                setUploads((prev) => prev.filter((u) => u.status === "uploading"));
              }
            }, autoClearMs);
          }
        }
      };

      uploadAll();
    },
    [workspaceId, autoClearMs, qc],
  );

  const clearUploads = useCallback(
    () => setUploads((prev) => prev.filter((u) => u.status === "uploading")),
    [],
  );

  return { uploads, handleUpload, clearUploads };
}
