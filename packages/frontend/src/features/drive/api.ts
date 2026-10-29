import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryClient } from "@/lib/query-client";
import { useObjectUrl } from "@/lib/use-object-url";
import { queryKeys } from "@/lib/query-keys";
import { settleWithConcurrency } from "@/lib/settle-with-concurrency";
import { useAuthStore } from "@/stores/auth-store";
import { apiBase } from "@/lib/api-url";

export interface DriveFile {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  isFolder: boolean;
  mimeType: string | null;
  size: number | null;
  storagePath: string | null;
  uploadedById: string;
  ownerId: string | null;
  teamFolderId: string | null;
  thumbnailPath: string | null;
  trashedAt: string | null;
  starred?: boolean;
  createdAt: string;
  updatedAt: string;
  uploadedBy: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
  };
}

export interface BreadcrumbItem {
  id: string;
  name: string;
}

export interface TeamFolder {
  id: string;
  workspaceId: string;
  folderId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  folder: { id: string; name: string };
  _count: { members: number };
}

export interface TeamFolderMember {
  id: string;
  teamFolderId: string;
  userId: string;
  addedAt: string;
  user: {
    id: string;
    displayName: string;
    email: string;
    avatarUrl: string | null;
  };
}

export interface TeamFolderGroup {
  id: string;
  teamFolderId: string;
  groupId: string;
  group: {
    id: string;
    name: string;
    color: string | null;
    _count: { members: number };
  };
}

export interface TeamFolderDetail extends TeamFolder {
  members: TeamFolderMember[];
  groups: TeamFolderGroup[];
}

interface FilesResponse {
  data: DriveFile[];
  nextCursor: string | null;
}

// ── File Queries ──

export type SortBy = "name" | "size" | "updatedAt" | "uploadedBy";
export type SortOrder = "asc" | "desc";

export function useFiles(
  wid: string,
  parentId?: string | null,
  teamFolderId?: string,
  search?: string,
  options?: { enabled?: boolean; sortBy?: SortBy; sortOrder?: SortOrder },
) {
  const isSearching = !!search;
  const sortBy = options?.sortBy ?? "name";
  const sortOrder = options?.sortOrder ?? "asc";
  return useInfiniteQuery({
    queryKey: isSearching
      ? queryKeys.fileSearch(wid, search, sortBy, sortOrder)
      : queryKeys.files(wid, parentId, teamFolderId, sortBy, sortOrder),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const params = new URLSearchParams();
      if (isSearching) {
        params.set("search", search);
      } else {
        if (parentId) params.set("parentId", parentId);
        if (teamFolderId) params.set("teamFolderId", teamFolderId);
      }
      if (pageParam) params.set("cursor", pageParam);
      params.set("limit", "50");
      params.set("sortBy", sortBy);
      params.set("sortOrder", sortOrder);

      const qs = params.toString();
      return api
        .get(`workspaces/${wid}/files${qs ? `?${qs}` : ""}`)
        .json<FilesResponse>();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: options?.enabled ?? true,
  });
}

export function useTrashedFiles(wid: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.trashedFiles(wid),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const params = new URLSearchParams();
      params.set("trashed", "true");
      params.set("limit", "50");
      if (pageParam) params.set("cursor", pageParam);

      return api
        .get(`workspaces/${wid}/files?${params.toString()}`)
        .json<FilesResponse>();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useBreadcrumbs(wid: string, folderId?: string) {
  return useQuery({
    queryKey: queryKeys.fileBreadcrumbs(wid, folderId!),
    queryFn: () =>
      api
        .get(`workspaces/${wid}/files/${folderId}/breadcrumbs`)
        .json<{ data: BreadcrumbItem[] }>(),
    enabled: !!folderId,
  });
}

// ── Team Folder Queries ──

export function useTeamFolders(wid: string) {
  return useQuery({
    queryKey: queryKeys.teamFolders(wid),
    queryFn: () =>
      api
        .get(`workspaces/${wid}/team-folders`)
        .json<{ data: TeamFolder[] }>(),
    enabled: !!wid,
  });
}

export function useTeamFolder(wid: string, tfid: string) {
  return useQuery({
    queryKey: queryKeys.teamFolder(wid, tfid),
    queryFn: () =>
      api
        .get(`workspaces/${wid}/team-folders/${tfid}`)
        .json<{ data: TeamFolderDetail }>(),
    enabled: !!wid && !!tfid,
  });
}

// ── File Mutations ──

export function useCreateFolder(wid: string, parentId?: string | null, teamFolderId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api
        .post(`workspaces/${wid}/files/folder`, {
          json: {
            name,
            parentId: parentId || undefined,
            teamFolderId: teamFolderId || undefined,
          },
        })
        .json<{ data: DriveFile }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

export function uploadSingleFile(
  wid: string,
  file: File,
  parentId?: string | null,
  teamFolderId?: string,
  onProgress?: (loaded: number, total: number) => void,
): { promise: Promise<DriveFile>; abort: () => void } {
  let xhrRef: XMLHttpRequest | null = null;

  const promise = new Promise<DriveFile>((resolve, reject) => {
    const token = useAuthStore.getState().accessToken;
    const baseUrl = apiBase();

    const formData = new FormData();
    if (parentId) formData.append("parentId", parentId);
    if (teamFolderId) formData.append("teamFolderId", teamFolderId);
    formData.append("file", file);

    const xhr = new XMLHttpRequest();
    xhrRef = xhr;
    xhr.open("POST", `${baseUrl}/workspaces/${wid}/files/upload`);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.withCredentials = true;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(e.loaded, e.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const json = JSON.parse(xhr.responseText) as { data: DriveFile };
          resolve(json.data);
        } catch {
          reject(new Error(`Invalid response for: ${file.name}`));
        }
      } else {
        try {
          const body = JSON.parse(xhr.responseText);
          reject(new Error((body as { message?: string }).message || `Upload failed: ${file.name}`));
        } catch {
          reject(new Error(`Upload failed: ${file.name}`));
        }
      }
    };

    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    xhr.onerror = () => reject(new Error(`Upload failed: ${file.name}`));
    xhr.send(formData);
  });

  return { promise, abort: () => xhrRef?.abort() };
}

export function useInvalidateFiles(wid: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["files"] });
}

export function useRenameFile(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ fileId, name }: { fileId: string; name: string }) =>
      api
        .patch(`workspaces/${wid}/files/${fileId}`, { json: { name } })
        .json<{ data: DriveFile }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

export function useStarredFiles(wid: string) {
  return useQuery({
    queryKey: queryKeys.starredFiles(wid),
    queryFn: () =>
      api
        .get(`workspaces/${wid}/files/starred`)
        .json<{ data: DriveFile[] }>(),
    enabled: !!wid,
  });
}

export function useStarFile(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      api.post(`workspaces/${wid}/files/${fileId}/star`).then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

export function useUnstarFile(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      api.delete(`workspaces/${wid}/files/${fileId}/star`).then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

export function useCopyFile(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      fileId,
      parentId,
      teamFolderId,
    }: {
      fileId: string;
      parentId: string | null;
      teamFolderId?: string | null;
    }) =>
      api
        .post(`workspaces/${wid}/files/${fileId}/copy`, {
          json: { parentId, ...(teamFolderId !== undefined ? { teamFolderId } : {}) },
        })
        .json<{ data: DriveFile }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

interface MoveTarget {
  parentId: string | null;
  teamFolderId?: string | null;
}

function moveFileRequest(wid: string, fileId: string, { parentId, teamFolderId }: MoveTarget) {
  return api
    .patch(`workspaces/${wid}/files/${fileId}`, {
      json: { parentId, ...(teamFolderId !== undefined ? { teamFolderId } : {}) },
    })
    .json<{ data: DriveFile }>();
}

function trashFileRequest(wid: string, fileId: string, trashedAt = new Date().toISOString()) {
  return api
    .patch(`workspaces/${wid}/files/${fileId}`, { json: { trashedAt } })
    .json<{ data: DriveFile }>();
}

export function useMoveFile(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ fileId, ...target }: { fileId: string } & MoveTarget) =>
      moveFileRequest(wid, fileId, target),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

export function useTrashFile(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => trashFileRequest(wid, fileId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

/** File requests a bulk action keeps in flight at once. */
export const BULK_FILE_CONCURRENCY = 4;

/** Which files of a bulk action were changed and which failed, in selection order. */
export interface BulkFileResult {
  succeeded: string[];
  failed: Array<{ fileId: string; error: unknown }>;
}

async function runBulkFileAction(
  fileIds: readonly string[],
  request: (fileId: string) => Promise<unknown>,
): Promise<BulkFileResult> {
  const results = await settleWithConcurrency(fileIds, BULK_FILE_CONCURRENCY, request);
  const outcome: BulkFileResult = { succeeded: [], failed: [] };
  results.forEach((result, i) => {
    if (result.status === "fulfilled") outcome.succeeded.push(fileIds[i]);
    else outcome.failed.push({ fileId: fileIds[i], error: result.reason });
  });
  return outcome;
}

/** Identifies a workspace's running bulk trash to every component that asks. */
export const bulkTrashMutationKey = (wid: string) => ["files", "bulk-trash", wid] as const;

/**
 * Trashes many files as one mutation. Each file is its own request, so one
 * failure never hides the others: the result says which files were trashed
 * and which failed, and the file lists refresh once for the whole batch.
 */
export function useBulkTrashFiles(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: bulkTrashMutationKey(wid),
    mutationFn: (fileIds: readonly string[]) => {
      const trashedAt = new Date().toISOString();
      return runBulkFileAction(fileIds, (fileId) => trashFileRequest(wid, fileId, trashedAt));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

/** Moves many files to one target as one mutation; see useBulkTrashFiles. */
export function useBulkMoveFiles(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ fileIds, ...target }: { fileIds: readonly string[] } & MoveTarget) =>
      runBulkFileAction(fileIds, (fileId) => moveFileRequest(wid, fileId, target)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

export function useRestoreFile(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      api
        .patch(`workspaces/${wid}/files/${fileId}`, {
          json: { trashedAt: null },
        })
        .json<{ data: DriveFile }>(),
    onSuccess: () => {
      // Broad invalidation: restored file's original parent folder is unknown.
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

export function useDeleteFilePermanently(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      api.delete(`workspaces/${wid}/files/${fileId}`).then(() => {}),
    onSuccess: () => {
      // Broad invalidation: permanently deleted file may have been in any folder.
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

export function useFileAttachmentCount(wid: string, fileId: string | null) {
  return useQuery({
    queryKey: queryKeys.fileAttachmentCount(wid, fileId!),
    queryFn: () =>
      api
        .get(`workspaces/${wid}/files/${fileId}/attachments-count`)
        .json<{ data: { count: number } }>(),
    enabled: !!fileId,
  });
}

/**
 * The thumbnail of a file as an object URL owned by the calling component.
 * The query caches the Blob; each observer makes and revokes its own URL.
 */
export function useThumbnailUrl(wid: string, fileId: string | null, hasThumbnail?: boolean) {
  const { data: blob } = useQuery({
    queryKey: ["file-thumbnail", { wid, fileId }],
    queryFn: async () => {
      const token = useAuthStore.getState().accessToken;
      const baseUrl = apiBase();

      const response = await fetch(
        `${baseUrl}/workspaces/${wid}/files/${fileId}/thumbnail`,
        {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          credentials: "include",
        },
      );

      if (!response.ok) throw new Error("Thumbnail fetch failed");

      return response.blob();
    },
    enabled: !!fileId && !!hasThumbnail,
    staleTime: 10 * 60 * 1000,
  });
  return { data: useObjectUrl(blob) };
}

/**
 * The content of a file for an inline preview as an object URL owned by the
 * calling component; see useThumbnailUrl. A closed preview's Blob is dropped
 * soon after, since whole files can be large.
 */
export function useFilePreviewUrl(wid: string, fileId: string | null, mimeType?: string | null) {
  const { data: blob } = useQuery({
    queryKey: ["file-preview", { wid, fileId }],
    queryFn: async () => {
      const token = useAuthStore.getState().accessToken;
      const baseUrl = apiBase();

      const response = await fetch(
        `${baseUrl}/workspaces/${wid}/files/${fileId}/download?inline=true`,
        {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          credentials: "include",
        },
      );

      if (!response.ok) throw new Error("Preview failed");

      const rawBlob = await response.blob();
      // Ensure the blob has the correct MIME type (needed for PDF viewer in iframes)
      return mimeType ? new Blob([rawBlob], { type: mimeType }) : rawBlob;
    },
    enabled: !!fileId,
    staleTime: 5 * 60 * 1000,
    gcTime: 60 * 1000,
  });
  return { data: useObjectUrl(blob) };
}

/** Query keys of cached file contents: thumbnails, previews and text previews. */
const FILE_CONTENT_QUERY_KEYS = [["file-thumbnail"], ["file-preview"], ["file-text"]];

/**
 * Drops every cached file content (thumbnail and preview Blobs, preview text)
 * so the next viewer downloads them again with its own credentials. Object
 * URLs belong to mounted components, which revoke them when they unmount, so
 * there is nothing to revoke here. Run it whenever the signed-in identity
 * changes (logout or switching accounts).
 */
export function clearFileContentCache(qc: QueryClient = queryClient) {
  for (const queryKey of FILE_CONTENT_QUERY_KEYS) qc.removeQueries({ queryKey });
}

export function useFileTextContent(wid: string, fileId: string | null) {
  return useQuery({
    queryKey: ["file-text", { wid, fileId }],
    queryFn: async () => {
      const token = useAuthStore.getState().accessToken;
      const baseUrl = apiBase();

      const response = await fetch(
        `${baseUrl}/workspaces/${wid}/files/${fileId}/download?inline=true`,
        {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          credentials: "include",
        },
      );

      if (!response.ok) throw new Error("Preview failed");

      return response.text();
    },
    enabled: !!fileId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useDownloadFile(wid: string) {
  return useMutation({
    mutationFn: async ({ fileId, fileName }: { fileId: string; fileName: string }) => {
      const token = useAuthStore.getState().accessToken;
      const baseUrl = apiBase();

      const response = await fetch(
        `${baseUrl}/workspaces/${wid}/files/${fileId}/download`,
        {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          credentials: "include",
        },
      );

      if (!response.ok) throw new Error("Download failed");

      const blob = await response.blob();
      // Force generic type so the browser respects the filename extension
      // instead of inferring one from the MIME type (e.g. .qt for video/quicktime)
      const downloadBlob = new Blob([blob], { type: "application/octet-stream" });
      const url = URL.createObjectURL(downloadBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
  });
}

export function useArchiveFiles(wid: string) {
  return useMutation({
    mutationFn: async ({ fileIds, archiveName }: { fileIds: string[]; archiveName: string }) => {
      const token = useAuthStore.getState().accessToken;
      const baseUrl = apiBase();

      const response = await fetch(
        `${baseUrl}/workspaces/${wid}/files/archive`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          credentials: "include",
          body: JSON.stringify({ fileIds }),
        },
      );

      if (!response.ok) throw new Error("Archive download failed");

      const blob = await response.blob();
      const downloadBlob = new Blob([blob], { type: "application/zip" });
      const url = URL.createObjectURL(downloadBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = archiveName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
  });
}

// ── Team Folder Mutations ──

export function useCreateTeamFolder(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description?: string; memberIds?: string[] }) =>
      api
        .post(`workspaces/${wid}/team-folders`, { json: input })
        .json<{ data: TeamFolder }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.teamFolders(wid) });
    },
  });
}

export function useUpdateTeamFolder(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      tfid,
      ...input
    }: {
      tfid: string;
      name?: string;
      description?: string | null;
    }) =>
      api
        .patch(`workspaces/${wid}/team-folders/${tfid}`, { json: input })
        .json<{ data: TeamFolder }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.teamFolders(wid) });
    },
  });
}

export function useDeleteTeamFolder(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tfid: string) =>
      api.delete(`workspaces/${wid}/team-folders/${tfid}`).then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.teamFolders(wid) });
    },
  });
}

export function useAddTeamFolderMember(wid: string, tfid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api
        .post(`workspaces/${wid}/team-folders/${tfid}/members`, {
          json: { userId },
        })
        .json<{ data: TeamFolderMember }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.teamFolder(wid, tfid) });
      qc.invalidateQueries({ queryKey: queryKeys.teamFolders(wid) });
    },
  });
}

// ── File Share Types ──

export interface FileShareMember {
  id: string;
  sharedWith: { id: string; displayName: string; avatarUrl: string | null; email: string };
  sharedBy: { id: string; displayName: string; avatarUrl: string | null };
  createdAt: string;
}

export interface FileShareLinkDetail {
  id: string;
  token: string;
  hasPassword: boolean;
  expiresAt: string | null;
  enabled: boolean;
  files: { file: { id: string; name: string; mimeType: string | null; size: number | null } }[];
  createdBy: { id: string; displayName: string; avatarUrl: string | null };
  createdAt: string;
}

export interface SharedFileEntry {
  id: string;
  file: DriveFile;
  sharedBy?: { id: string; displayName: string; avatarUrl: string | null };
  sharedWith?: { id: string; displayName: string; avatarUrl: string | null; email: string } | null;
  shareType?: "member" | "link";
  createdAt: string;
}

interface AuthorizedPublicShareData {
  authorized: true;
  files: { file: { id: string; name: string; mimeType: string | null; size: number | null } }[];
  createdBy: { id: string; displayName: string; avatarUrl: string | null };
  hasPassword: boolean;
  createdAt: string;
}

type PublicShareData = AuthorizedPublicShareData | {
  authorized: false;
  hasPassword: true;
  files: [];
  createdBy: null;
  createdAt: null;
};

// ── File Share Queries ──

export function useFileShares(wid: string, fileId: string | null) {
  return useQuery({
    queryKey: queryKeys.fileShares(wid, fileId!),
    queryFn: () =>
      api
        .get(`workspaces/${wid}/files/${fileId}/shares`)
        .json<{ data: FileShareMember[] }>(),
    enabled: !!fileId,
  });
}

export function useFileShareLinks(wid: string, fileId: string | null) {
  return useQuery({
    queryKey: queryKeys.fileShareLinks(wid, fileId!),
    queryFn: () =>
      api
        .get(`workspaces/${wid}/files/${fileId}/share-links`)
        .json<{ data: FileShareLinkDetail[] }>(),
    enabled: !!fileId,
  });
}

export function useFileShareStatus(wid: string, fileIds: string[]) {
  return useQuery({
    queryKey: queryKeys.fileShareStatus(wid, fileIds),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("fileIds", fileIds.join(","));
      return api
        .get(`workspaces/${wid}/files/share-status?${params.toString()}`)
        .json<{ data: string[] }>();
    },
    enabled: fileIds.length > 0,
  });
}

export function useSharedWithMe(wid: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.sharedWithMe(wid),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (pageParam) params.set("cursor", pageParam);
      return api
        .get(`workspaces/${wid}/files/shared-with-me?${params.toString()}`)
        .json<{ data: SharedFileEntry[]; nextCursor: string | null }>();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useSharedByMe(wid: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.sharedByMe(wid),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (pageParam) params.set("cursor", pageParam);
      return api
        .get(`workspaces/${wid}/files/shared-by-me?${params.toString()}`)
        .json<{ data: SharedFileEntry[]; nextCursor: string | null }>();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

// ── File Share Mutations ──

export function useCreateFileShares(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { fileIds: string[]; userIds: string[] }) =>
      api
        .post(`workspaces/${wid}/files/shares`, { json: input })
        .json<{ data: { count: number } }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["file-shares"] });
      qc.invalidateQueries({ queryKey: ["file-share-status"] });
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

export function useRemoveFileShare(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ fileId, userId }: { fileId: string; userId: string }) =>
      api.delete(`workspaces/${wid}/files/${fileId}/shares/${userId}`).then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["file-shares"] });
      qc.invalidateQueries({ queryKey: ["file-share-status"] });
      qc.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

export function useCreateFileShareLink(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { fileIds: string[]; password?: string; expiresAt?: string }) =>
      api
        .post(`workspaces/${wid}/files/share-links`, { json: input })
        .json<{ data: FileShareLinkDetail }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["file-share-links"] });
      qc.invalidateQueries({ queryKey: ["file-share-status"] });
      qc.invalidateQueries({ queryKey: queryKeys.sharedByMe(wid) });
    },
  });
}

export function useUpdateFileShareLink(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      linkId,
      ...input
    }: {
      linkId: string;
      enabled?: boolean;
      password?: string | null;
      expiresAt?: string | null;
    }) =>
      api
        .patch(`workspaces/${wid}/file-share-links/${linkId}`, { json: input })
        .json<{ data: FileShareLinkDetail }>(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["file-share-links"] });
    },
  });
}

export function useDeleteFileShareLink(wid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) =>
      api.delete(`workspaces/${wid}/file-share-links/${linkId}`).then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["file-share-links"] });
      qc.invalidateQueries({ queryKey: ["file-share-status"] });
      qc.invalidateQueries({ queryKey: queryKeys.sharedByMe(wid) });
    },
  });
}

export function usePublicFileShare(token: string) {
  return useQuery({
    queryKey: ["public-file-share", token],
    queryFn: () =>
      api
        .get(`public/files/${token}`)
        .json<{ data: PublicShareData }>(),
    enabled: !!token,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });
}

export function useValidateFileShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ token, password }: { token: string; password: string }) =>
      api
        .post(`public/files/${token}/validate`, { json: { password } })
        .json<{ data: { valid: boolean } }>(),
    onSuccess: (_result, { token }) => qc.invalidateQueries({ queryKey: ["public-file-share", token] }),
  });
}

export function useRemoveTeamFolderMember(wid: string, tfid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api
        .delete(`workspaces/${wid}/team-folders/${tfid}/members/${userId}`)
        .then(() => {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.teamFolder(wid, tfid) });
      qc.invalidateQueries({ queryKey: queryKeys.teamFolders(wid) });
    },
  });
}
