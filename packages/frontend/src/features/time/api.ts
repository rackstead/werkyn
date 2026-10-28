import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "sonner";
import type {
  CreateTimeEntryInput,
  UpdateTimeEntryInput,
  SetUserRateInput,
} from "@pm/shared";

// ─── Types ──────────────────────────────────────────────

export interface TimeEntry {
  id: string;
  workspaceId: string;
  userId: string;
  taskId: string | null;
  projectId: string | null;
  date: string;
  hours: number;
  description: string | null;
  billable: boolean;
  createdAt: string;
  updatedAt: string;
  user: { id: string; displayName: string; avatarUrl: string | null };
  task: { id: string; title: string } | null;
  project: { id: string; name: string; color: string | null } | null;
}

export interface UserRate {
  id: string;
  workspaceId: string;
  userId: string;
  rate: number;
  currency: string;
  effectiveFrom: string;
  user?: { id: string; displayName: string; avatarUrl: string | null };
}

export interface CurrencyAmount {
  currency: string;
  amount: number;
}

/**
 * Report cost totals. Amounts in different currencies are never added:
 * costByCurrency has one total per currency, and totalCost/currency are only
 * set when every priced amount shares one currency (totalCost is null when
 * currencies are mixed). Billable hours without a rate on their date add no
 * cost and are counted in unratedBillableHours.
 */
export interface TimeReportCostTotals {
  totalCost: number | null;
  currency: string | null;
  costByCurrency: CurrencyAmount[];
  unratedBillableHours: number;
}

export interface TimeReportGroup extends TimeReportCostTotals {
  key: string;
  label: string;
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  entries: Array<{
    id: string;
    date: string;
    hours: number;
    billable: boolean;
    description: string | null;
    userName: string;
    projectName: string | null;
    taskTitle: string | null;
    /** Rate in effect on the entry's date; null when the member had none. */
    rate: number | null;
    currency: string | null;
    /** null when the entry is billable but has no rate. */
    cost: number | null;
  }>;
}

export interface TimeReport {
  groups: TimeReportGroup[];
  summary: TimeReportCostTotals & {
    totalHours: number;
    billableHours: number;
    nonBillableHours: number;
  };
}

// ─── Queries ────────────────────────────────────────────

export function useTimeEntries(
  workspaceId: string,
  startDate: string,
  endDate: string,
  userId?: string,
) {
  return useQuery({
    queryKey: queryKeys.timeEntries(workspaceId, startDate, endDate, userId),
    queryFn: () => {
      const searchParams: Record<string, string> = { startDate, endDate };
      if (userId) searchParams.userId = userId;
      return api
        .get(`workspaces/${workspaceId}/time/entries`, { searchParams })
        .json<{ data: TimeEntry[] }>();
    },
    select: (res) => res.data,
    enabled: !!workspaceId && !!startDate && !!endDate,
  });
}

export function useTimeReport(
  workspaceId: string,
  filters: {
    startDate: string;
    endDate: string;
    userIds?: string;
    projectIds?: string;
    billable?: string;
    groupBy?: string;
  },
) {
  return useQuery({
    queryKey: queryKeys.timeReport(workspaceId, filters),
    queryFn: () =>
      api
        .get(`workspaces/${workspaceId}/time/reports`, {
          searchParams: filters as Record<string, string>,
        })
        .json<{ data: TimeReport }>(),
    select: (res) => res.data,
    enabled: !!workspaceId && !!filters.startDate && !!filters.endDate,
  });
}

export function useUserRates(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.userRates(workspaceId),
    queryFn: () =>
      api
        .get(`workspaces/${workspaceId}/time/rates`)
        .json<{ data: UserRate[] }>(),
    select: (res) => res.data,
    enabled: !!workspaceId,
  });
}

export function useUserRate(workspaceId: string, userId: string) {
  return useQuery({
    queryKey: queryKeys.userRate(workspaceId, userId),
    queryFn: () =>
      api
        .get(`workspaces/${workspaceId}/time/rates/${userId}`)
        .json<{ data: UserRate | null }>(),
    select: (res) => res.data,
    enabled: !!workspaceId && !!userId,
  });
}

// ─── Mutations ──────────────────────────────────────────

export function useCreateTimeEntry(workspaceId: string) {
  return useMutation({
    mutationFn: (data: CreateTimeEntryInput) =>
      api
        .post(`workspaces/${workspaceId}/time/entries`, { json: data })
        .json<{ data: TimeEntry }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["time-entries"],
      });
    },
    onError: () => {
      toast.error("Failed to create time entry");
    },
  });
}

export function useUpdateTimeEntry() {
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateTimeEntryInput }) =>
      api
        .patch(`time/entries/${id}`, { json: data })
        .json<{ data: TimeEntry }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["time-entries"],
      });
    },
    onError: () => {
      toast.error("Failed to update time entry");
    },
  });
}

export function useDeleteTimeEntry() {
  return useMutation({
    mutationFn: (id: string) => api.delete(`time/entries/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["time-entries"],
      });
    },
    onError: () => {
      toast.error("Failed to delete time entry");
    },
  });
}

export function useSetUserRate(workspaceId: string) {
  return useMutation({
    mutationFn: ({
      userId,
      data,
    }: {
      userId: string;
      data: SetUserRateInput;
    }) =>
      api
        .post(`workspaces/${workspaceId}/time/rates/${userId}`, { json: data })
        .json<{ data: UserRate }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-rates"] });
      toast.success("Rate updated");
    },
    onError: () => {
      toast.error("Failed to set rate");
    },
  });
}

// ─── CSV Export ─────────────────────────────────────────

export async function exportTimeReportCSV(
  workspaceId: string,
  filters: Record<string, string>,
) {
  const response = await api.get(
    `workspaces/${workspaceId}/time/reports/export`,
    { searchParams: filters },
  );
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "time-report.csv";
  a.click();
  URL.revokeObjectURL(url);
}
