import { Fragment, useState, useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getExpandedRowModel,
  createColumnHelper,
  flexRender,
  type ExpandedState,
} from "@tanstack/react-table";
import { ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TimeReportGroup } from "../api";
import { formatCostLines, formatEntryCost, formatUnratedHours } from "../money";

interface ReportTableProps {
  groups: TimeReportGroup[];
  groupBy: string;
}

function fmt(n: number): string {
  return n.toFixed(n % 1 === 0 ? 0 : 2);
}

const columnHelper = createColumnHelper<TimeReportGroup>();

export function ReportTable({ groups, groupBy }: ReportTableProps) {
  const [expanded, setExpanded] = useState<ExpandedState>({});

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: "expand",
        header: "",
        cell: ({ row }) => (
          <button
            onClick={(e) => {
              e.stopPropagation();
              row.getToggleExpandedHandler()();
            }}
            className="p-0.5"
          >
            {row.getIsExpanded() ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        ),
        size: 40,
      }),
      columnHelper.accessor("label", {
        header:
          groupBy === "user"
            ? "Member"
            : groupBy === "project"
              ? "Project"
              : "Date",
        cell: ({ getValue }) => (
          <span className="font-medium text-sm">{getValue()}</span>
        ),
        size: 260,
      }),
      columnHelper.accessor("totalHours", {
        header: "Hours",
        cell: ({ getValue }) => (
          <span className="font-semibold">{fmt(getValue())}h</span>
        ),
        size: 100,
      }),
      columnHelper.accessor("billableHours", {
        header: "Billable",
        cell: ({ getValue }) => <span>{fmt(getValue())}h</span>,
        size: 100,
      }),
      columnHelper.accessor("nonBillableHours", {
        header: "Non-Billable",
        cell: ({ getValue }) => (
          <span className="text-muted-foreground">{fmt(getValue())}h</span>
        ),
        size: 110,
      }),
      columnHelper.accessor("costByCurrency", {
        header: "Cost",
        // One line per currency: amounts in different currencies are not added.
        cell: ({ getValue, row }) => {
          const unrated = formatUnratedHours(row.original.unratedBillableHours);
          return (
            <>
              {formatCostLines(getValue()).map((line, index) => (
                <div key={index} className="font-semibold">
                  {line}
                </div>
              ))}
              {unrated && (
                <div className="text-xs text-muted-foreground">{unrated}</div>
              )}
            </>
          );
        },
        size: 120,
      }),
    ],
    [groupBy],
  );

  const table = useReactTable({
    data: groups,
    columns,
    state: { expanded },
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowId: (row) => row.key,
    getRowCanExpand: () => true,
  });

  if (groups.length === 0) {
    return (
      <div className="flex items-center justify-center p-12 text-muted-foreground text-sm border rounded-lg">
        No data for the selected filters.
      </div>
    );
  }

  const headerGroups = table.getHeaderGroups();

  return (
    <div className="flex-1 overflow-auto rounded-lg border">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-background border-b">
          {headerGroups.map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header, i) => (
                <th
                  key={header.id}
                  className={cn(
                    "px-3 py-2 text-left text-xs font-medium text-muted-foreground",
                    header.id !== "label" &&
                      header.id !== "expand" &&
                      "text-right",
                    i < headerGroup.headers.length - 1 &&
                      "border-r border-border",
                  )}
                  style={{ width: header.getSize() }}
                >
                  {flexRender(
                    header.column.columnDef.header,
                    header.getContext(),
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <Fragment key={row.id}>
              {/* Group header row */}
              <tr
                className="border-b hover:bg-accent/50 cursor-pointer transition-colors"
                onClick={row.getToggleExpandedHandler()}
              >
                {row.getVisibleCells().map((cell, i) => (
                  <td
                    key={cell.id}
                    className={cn(
                      "px-3 py-1.5",
                      cell.column.id !== "label" &&
                        cell.column.id !== "expand" &&
                        "text-right",
                      i < row.getVisibleCells().length - 1 &&
                        "border-r border-border",
                    )}
                    style={{ width: cell.column.getSize() }}
                  >
                    {flexRender(
                      cell.column.columnDef.cell,
                      cell.getContext(),
                    )}
                  </td>
                ))}
              </tr>

              {/* Expanded detail rows */}
              {row.getIsExpanded() &&
                row.original.entries.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-b bg-muted/30 hover:bg-muted/50 transition-colors"
                  >
                    <td className="border-r border-border" />
                    <td className="px-3 py-1.5 border-r border-border">
                      <div className="text-xs text-muted-foreground pl-2">
                        <span>{entry.date}</span>
                        {entry.projectName && (
                          <span> · {entry.projectName}</span>
                        )}
                        {entry.taskTitle && (
                          <span> · {entry.taskTitle}</span>
                        )}
                        {entry.description && (
                          <div className="text-muted-foreground/70 mt-0.5">
                            {entry.description}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right text-xs border-r border-border">
                      {fmt(entry.hours)}h
                    </td>
                    <td className="px-3 py-1.5 text-right text-xs border-r border-border">
                      {entry.billable ? "Yes" : "No"}
                    </td>
                    <td className="px-3 py-1.5 text-right text-xs border-r border-border">
                      –
                    </td>
                    <td className="px-3 py-1.5 text-right text-xs">
                      {formatEntryCost(entry.cost, entry.currency)}
                    </td>
                  </tr>
                ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
