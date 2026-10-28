import { useNavigate } from "@tanstack/react-router";
import { isDateOnly } from "@pm/shared";
import { ArrowLeft, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useTimeReport, exportTimeReportCSV } from "../api";
import { ReportSummaryCards } from "./report-summary-cards";
import { ReportTable } from "./report-table";
import { RateManagementDialog } from "./rate-management-dialog";
import {
  formatDateISO,
  getMonday,
  getSunday,
  getMonthStart,
  getMonthEnd,
} from "../utils";

interface TimeReportsPageProps {
  workspaceId: string;
  workspaceSlug: string;
  membership: { role: "ADMIN" | "MEMBER" | "VIEWER" };
  filters: {
    startDate?: string;
    endDate?: string;
    userIds?: string;
    projectIds?: string;
    billable?: "true" | "false" | "all";
    groupBy?: "user" | "project" | "date";
  };
}

export function TimeReportsPage({
  workspaceId,
  workspaceSlug,
  membership,
  filters,
}: TimeReportsPageProps) {
  const navigate = useNavigate();
  const now = new Date();

  const startDate = filters.startDate ?? getMonthStart(now);
  const endDate = filters.endDate ?? getMonthEnd(now);
  const groupBy = filters.groupBy ?? "user";
  const billable = filters.billable ?? "all";

  const { data: report, isLoading } = useTimeReport(workspaceId, {
    startDate,
    endDate,
    userIds: filters.userIds,
    projectIds: filters.projectIds,
    billable,
    groupBy,
  });

  function updateFilters(patch: Record<string, string | undefined>) {
    navigate({
      to: "/$workspaceSlug/time/reports",
      params: { workspaceSlug },
      search: {
        startDate,
        endDate,
        groupBy,
        billable,
        userIds: filters.userIds,
        projectIds: filters.projectIds,
        ...patch,
      },
    });
  }

  function applyPreset(preset: string) {
    const today = new Date();
    let s: string;
    let e: string;

    switch (preset) {
      case "this-week": {
        const mon = getMonday(today);
        s = formatDateISO(mon);
        e = formatDateISO(getSunday(mon));
        break;
      }
      case "last-week": {
        const lastMon = getMonday(today);
        lastMon.setDate(lastMon.getDate() - 7);
        s = formatDateISO(lastMon);
        e = formatDateISO(getSunday(lastMon));
        break;
      }
      case "this-month": {
        s = getMonthStart(today);
        e = getMonthEnd(today);
        break;
      }
      case "last-month": {
        const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        s = getMonthStart(prev);
        e = getMonthEnd(prev);
        break;
      }
      default:
        return;
    }
    updateFilters({ startDate: s, endDate: e });
  }

  // Like the report itself, the export waits until both dates are complete:
  // a cleared date or a year still being typed would be rejected.
  const datesComplete = isDateOnly(startDate) && isDateOnly(endDate);

  async function handleExport() {
    if (!datesComplete) return;
    await exportTimeReportCSV(workspaceId, {
      startDate,
      endDate,
      groupBy,
      billable,
      ...(filters.userIds ? { userIds: filters.userIds } : {}),
      ...(filters.projectIds ? { projectIds: filters.projectIds } : {}),
    });
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              navigate({
                to: "/$workspaceSlug/time",
                params: { workspaceSlug },
              })
            }
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-2xl font-bold">Time Reports</h1>
        </div>
        <div className="flex items-center gap-2">
          <RateManagementDialog workspaceId={workspaceId} />
          <Button
            size="sm"
            variant="outline"
            onClick={handleExport}
            disabled={!datesComplete}
          >
            <Download className="h-4 w-4 mr-1" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3">
        {/* Preset selector */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Preset</label>
          <Select onValueChange={applyPreset}>
            <SelectTrigger className="w-36 h-8 text-sm">
              <SelectValue placeholder="Select range" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="this-week">This Week</SelectItem>
              <SelectItem value="last-week">Last Week</SelectItem>
              <SelectItem value="this-month">This Month</SelectItem>
              <SelectItem value="last-month">Last Month</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Date range */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Start Date</label>
          <Input
            type="date"
            value={startDate}
            onChange={(e) => updateFilters({ startDate: e.target.value })}
            className="h-8 text-sm w-36"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">End Date</label>
          <Input
            type="date"
            value={endDate}
            onChange={(e) => updateFilters({ endDate: e.target.value })}
            className="h-8 text-sm w-36"
          />
        </div>

        {/* Group by */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Group By</label>
          <Select
            value={groupBy}
            onValueChange={(val) => updateFilters({ groupBy: val })}
          >
            <SelectTrigger className="w-32 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="user">User</SelectItem>
              <SelectItem value="project">Project</SelectItem>
              <SelectItem value="date">Date</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Billable filter */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Billable</label>
          <Select
            value={billable}
            onValueChange={(val) => updateFilters({ billable: val })}
          >
            <SelectTrigger className="w-28 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="true">Billable</SelectItem>
              <SelectItem value="false">Non-Billable</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Summary cards */}
      {report && (
        <ReportSummaryCards
          totalHours={report.summary.totalHours}
          billableHours={report.summary.billableHours}
          nonBillableHours={report.summary.nonBillableHours}
          costByCurrency={report.summary.costByCurrency}
          unratedBillableHours={report.summary.unratedBillableHours}
          skippedEntries={report.summary.skippedEntries}
        />
      )}

      {/* Results table */}
      {isLoading ? (
        <div className="border rounded-lg p-8">
          <div className="h-32 animate-pulse bg-muted rounded" />
        </div>
      ) : report ? (
        <ReportTable groups={report.groups} groupBy={groupBy} />
      ) : null}
    </div>
  );
}
