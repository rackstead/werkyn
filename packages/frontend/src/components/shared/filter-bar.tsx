import { useEffect, useState } from "react";
import { useStatuses, useLabels, useProjectMembers } from "@/features/projects/api";
import { committedDate } from "@/lib/date-input";
import { X, Filter } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchInput } from "@/components/shared/search-input";
import { ArchiveToggle } from "@/components/shared/archive-toggle";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface Filters {
  search?: string;
  priority?: string;
  assignee?: string;
  label?: string;
  status?: string;
  dueBefore?: string;
  dueAfter?: string;
  archived?: boolean;
}

interface FilterBarProps {
  projectId: string;
  filters: Filters;
  onFilterChange: (filters: Filters) => void;
  hideDateRange?: boolean;
}

const priorities = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;

/**
 * A due-date filter input. What is typed stays in the input, but the filter
 * only changes once it is a complete date or is cleared, so a year still being
 * typed (Chromium reports 0002-03-15, 0020-03-15, 0202-03-15) keeps the
 * current filter instead of dropping it.
 */
function DateFilterInput({
  value,
  onChange,
  title,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  title: string;
}) {
  const [local, setLocal] = useState(value ?? "");
  useEffect(() => setLocal(value ?? ""), [value]);
  return (
    <input
      type="date"
      value={local}
      onChange={(e) => {
        setLocal(e.target.value);
        const date = committedDate(e.target.value);
        if (date !== undefined) onChange(date ?? undefined);
      }}
      className="h-8 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
      title={title}
    />
  );
}

const ALL = "__all__";

export function FilterBar({ projectId, filters, onFilterChange, hideDateRange }: FilterBarProps) {
  const { data: statusData } = useStatuses(projectId);
  const { data: labelData } = useLabels(projectId);
  const { data: memberData } = useProjectMembers(projectId);

  const statuses = statusData?.data ?? [];
  const labels = labelData?.data ?? [];
  const members = memberData?.data ?? [];

  const updateFilter = (key: keyof Filters, value: string | boolean | undefined) => {
    const next = { ...filters };
    if (value === undefined || value === "" || value === false) {
      delete next[key];
    } else {
      (next as Record<string, unknown>)[key] = value;
    }
    onFilterChange(next);
  };

  const activeCount = Object.keys(filters).filter(
    (k) => k !== "search" && filters[k as keyof Filters] !== undefined,
  ).length;

  const clearAll = () => {
    onFilterChange({});
  };

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b bg-background/95">
      <SearchInput
        value={filters.search ?? ""}
        onChange={(v) => updateFilter("search", v || undefined)}
        placeholder="Search tasks..."
      />

      {/* Status */}
      <Select
        value={filters.status ?? ALL}
        onValueChange={(v) => updateFilter("status", v === ALL ? undefined : v)}
      >
        <SelectTrigger aria-label="Filter by status" className="h-8 w-auto min-w-[130px]">
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All statuses</SelectItem>
          {statuses.map((s) => (
            <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Priority */}
      <Select
        value={filters.priority ?? ALL}
        onValueChange={(v) => updateFilter("priority", v === ALL ? undefined : v)}
      >
        <SelectTrigger aria-label="Filter by priority" className="h-8 w-auto min-w-[130px]">
          <SelectValue placeholder="All priorities" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All priorities</SelectItem>
          {priorities.map((p) => (
            <SelectItem key={p} value={p}>{p.charAt(0) + p.slice(1).toLowerCase()}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Assignee */}
      <Select
        value={filters.assignee ?? ALL}
        onValueChange={(v) => updateFilter("assignee", v === ALL ? undefined : v)}
      >
        <SelectTrigger aria-label="Filter by assignee" className="h-8 w-auto min-w-[130px]">
          <SelectValue placeholder="All assignees" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All assignees</SelectItem>
          {members.map((m) => (
            <SelectItem key={m.user.id} value={m.user.id}>{m.user.displayName}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Label */}
      <Select
        value={filters.label ?? ALL}
        onValueChange={(v) => updateFilter("label", v === ALL ? undefined : v)}
      >
        <SelectTrigger aria-label="Filter by label" className="h-8 w-auto min-w-[130px]">
          <SelectValue placeholder="All labels" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All labels</SelectItem>
          {labels.map((l) => (
            <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Due date range */}
      {!hideDateRange && (
        <>
          <DateFilterInput
            value={filters.dueAfter}
            onChange={(value) => updateFilter("dueAfter", value)}
            title="Due after"
          />
          <DateFilterInput
            value={filters.dueBefore}
            onChange={(value) => updateFilter("dueBefore", value)}
            title="Due before"
          />
        </>
      )}

      <ArchiveToggle
        checked={filters.archived ?? false}
        onChange={(checked) => updateFilter("archived", checked || undefined)}
      />

      {/* Active filter count + clear */}
      {activeCount > 0 && (
        <button
          onClick={clearAll}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs",
            "bg-primary/10 text-primary hover:bg-primary/20 transition-colors",
          )}
        >
          <Filter className="h-3 w-3" />
          {activeCount} active
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
