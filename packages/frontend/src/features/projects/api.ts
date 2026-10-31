import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "sonner";
import type {
  CreateProjectInput,
  UpdateProjectInput,
  ArchiveInput,
  AddProjectMemberInput,
  CreateStatusColumnInput,
  UpdateStatusColumnInput,
  ReorderInput,
  CreateLabelInput,
  UpdateLabelInput,
  CreateCustomFieldInput,
  UpdateCustomFieldInput,
  ReorderCustomFieldsInput,
  SetCustomFieldValueInput,
} from "@pm/shared";

// ─── Types ───────────────────────────────────────────────

interface Project {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  statuses?: StatusColumn[];
  _count?: { members: number; tasks: number };
}

interface ProjectMember {
  id: string;
  projectId: string;
  userId: string;
  addedAt: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
  };
}

interface StatusColumn {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
  position: number;
  isCompletion: boolean;
}

interface Label {
  id: string;
  projectId: string;
  name: string;
  color: string;
  _count?: { tasks: number };
}

export interface CustomField {
  id: string;
  projectId: string;
  name: string;
  type: "TEXT" | "NUMBER" | "DATE" | "SELECT" | "MULTI_SELECT" | "CHECKBOX" | "URL";
  options: Array<{ value: string; color?: string }> | null;
  required: boolean;
  position: number;
  _count?: { values: number };
}

interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ─── Projects ────────────────────────────────────────────

export function useProjects(wid: string) {
  return useQuery({
    queryKey: queryKeys.projects(wid),
    queryFn: () =>
      api
        .get(`workspaces/${wid}/projects`)
        .json<PaginatedResponse<Project>>(),
    enabled: !!wid,
  });
}

export function useProject(pid: string) {
  return useQuery({
    queryKey: queryKeys.project(pid),
    queryFn: () =>
      api.get(`projects/${pid}`).json<{ data: Project }>(),
    enabled: !!pid,
  });
}

export function useCreateProject(wid: string) {
  return useMutation({
    mutationFn: (data: CreateProjectInput) =>
      api
        .post(`workspaces/${wid}/projects`, { json: data })
        .json<{ data: Project }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects(wid) });
      toast.success("Project created");
    },
  });
}

export function useUpdateProject(pid: string, wid: string) {
  return useMutation({
    mutationFn: (data: UpdateProjectInput) =>
      api
        .patch(`projects/${pid}`, { json: data })
        .json<{ data: Project }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.project(pid) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects(wid) });
      toast.success("Project updated");
    },
  });
}

export function useDeleteProject(pid: string, wid: string) {
  return useMutation({
    mutationFn: () => api.delete(`projects/${pid}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects(wid) });
      toast.success("Project deleted");
    },
  });
}

export function useArchiveProject(pid: string, wid: string) {
  return useMutation({
    mutationFn: (data: ArchiveInput) =>
      api
        .patch(`projects/${pid}/archive`, { json: data })
        .json<{ data: Project }>(),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.project(pid) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects(wid) });
      toast.success(res.data.archived ? "Project archived" : "Project unarchived");
    },
  });
}

// ─── Project Members ─────────────────────────────────────

export function useProjectMembers(pid: string) {
  return useQuery({
    queryKey: queryKeys.projectMembers(pid),
    queryFn: () =>
      api
        .get(`projects/${pid}/members`)
        .json<{ data: ProjectMember[] }>(),
    enabled: !!pid,
  });
}

export function useAddProjectMember(pid: string) {
  return useMutation({
    mutationFn: (data: AddProjectMemberInput) =>
      api
        .post(`projects/${pid}/members`, { json: data })
        .json<{ data: ProjectMember }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectMembers(pid),
      });
      toast.success("Member added");
    },
  });
}

export function useRemoveProjectMember(pid: string) {
  return useMutation({
    mutationFn: (userId: string) =>
      api.delete(`projects/${pid}/members/${userId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectMembers(pid),
      });
      toast.success("Member removed");
    },
  });
}

// ─── Status Columns ──────────────────────────────────────

export function useStatuses(pid: string) {
  return useQuery({
    queryKey: queryKeys.statuses(pid),
    queryFn: () =>
      api
        .get(`projects/${pid}/statuses`)
        .json<{ data: StatusColumn[] }>(),
    enabled: !!pid,
  });
}

export function useCreateStatus(pid: string) {
  return useMutation({
    mutationFn: (data: CreateStatusColumnInput) =>
      api
        .post(`projects/${pid}/statuses`, { json: data })
        .json<{ data: StatusColumn }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.statuses(pid) });
      toast.success("Status column created");
    },
  });
}

export function useUpdateStatus(pid: string) {
  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: UpdateStatusColumnInput & { id: string }) =>
      api
        .patch(`projects/${pid}/statuses/${id}`, { json: data })
        .json<{ data: StatusColumn }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.statuses(pid) });
      toast.success("Status column updated");
    },
  });
}

export function useDeleteStatus(pid: string) {
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`projects/${pid}/statuses/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.statuses(pid) });
      toast.success("Status column deleted");
    },
  });
}

export function useReorderStatuses(pid: string) {
  return useMutation({
    mutationFn: (data: ReorderInput) =>
      api
        .patch(`projects/${pid}/statuses/reorder`, { json: data })
        .json<{ data: StatusColumn[] }>(),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.statuses(pid) });
    },
  });
}

// ─── Labels ──────────────────────────────────────────────

export function useLabels(pid: string) {
  return useQuery({
    queryKey: queryKeys.labels(pid),
    queryFn: () =>
      api
        .get(`projects/${pid}/labels`)
        .json<{ data: Label[] }>(),
    enabled: !!pid,
  });
}

export function useCreateLabel(pid: string) {
  return useMutation({
    mutationFn: (data: CreateLabelInput) =>
      api
        .post(`projects/${pid}/labels`, { json: data })
        .json<{ data: Label }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.labels(pid) });
      toast.success("Label created");
    },
  });
}

export function useUpdateLabel(pid: string) {
  return useMutation({
    mutationFn: ({ id, ...data }: UpdateLabelInput & { id: string }) =>
      api
        .patch(`projects/${pid}/labels/${id}`, { json: data })
        .json<{ data: Label }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.labels(pid) });
      toast.success("Label updated");
    },
  });
}

export function useDeleteLabel(pid: string) {
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`projects/${pid}/labels/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.labels(pid) });
      toast.success("Label deleted");
    },
  });
}

// ─── Custom Fields ──────────────────────────────────────

export function useCustomFields(pid: string) {
  return useQuery({
    queryKey: queryKeys.customFields(pid),
    queryFn: () =>
      api
        .get(`projects/${pid}/custom-fields`)
        .json<{ data: CustomField[] }>(),
    enabled: !!pid,
  });
}

export function useCreateCustomField(pid: string) {
  return useMutation({
    mutationFn: (data: CreateCustomFieldInput) =>
      api
        .post(`projects/${pid}/custom-fields`, { json: data })
        .json<{ data: CustomField }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customFields(pid) });
      toast.success("Custom field created");
    },
  });
}

export function useUpdateCustomField(pid: string) {
  return useMutation({
    mutationFn: ({ id, ...data }: UpdateCustomFieldInput & { id: string }) =>
      api
        .patch(`projects/${pid}/custom-fields/${id}`, { json: data })
        .json<{ data: CustomField }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customFields(pid) });
      toast.success("Custom field updated");
    },
  });
}

export function useDeleteCustomField(pid: string) {
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`projects/${pid}/custom-fields/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customFields(pid) });
      toast.success("Custom field deleted");
    },
  });
}

export function useReorderCustomFields(pid: string) {
  return useMutation({
    mutationFn: (data: ReorderCustomFieldsInput) =>
      api
        .patch(`projects/${pid}/custom-fields/reorder`, { json: data })
        .json<{ data: CustomField[] }>(),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.customFields(pid) });
    },
  });
}

export function useSetCustomFieldValue(taskId: string, projectId: string) {
  return useMutation({
    mutationFn: ({ fieldId, ...data }: SetCustomFieldValueInput & { fieldId: string }) =>
      api
        .put(`projects/${projectId}/tasks/${taskId}/custom-fields/${fieldId}`, { json: data })
        .json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks(projectId),
        exact: false,
      });
    },
  });
}
