import { Clock, DollarSign, CircleDot, CircleOff } from "lucide-react";
import type { CurrencyAmount } from "../api";
import { formatCostLines, formatUnratedHours } from "../money";

interface ReportSummaryCardsProps {
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  costByCurrency: CurrencyAmount[];
  unratedBillableHours: number;
}

function fmt(n: number): string {
  return n.toFixed(n % 1 === 0 ? 0 : 2);
}

export function ReportSummaryCards({
  totalHours,
  billableHours,
  nonBillableHours,
  costByCurrency,
  unratedBillableHours,
}: ReportSummaryCardsProps) {
  const cards: Array<{
    label: string;
    value: string[];
    detail?: string | null;
    icon: typeof Clock;
    color: string;
  }> = [
    {
      label: "Total Hours",
      value: [`${fmt(totalHours)}h`],
      icon: Clock,
      color: "text-blue-500",
    },
    {
      label: "Billable Hours",
      value: [`${fmt(billableHours)}h`],
      icon: CircleDot,
      color: "text-green-500",
    },
    {
      label: "Non-Billable",
      value: [`${fmt(nonBillableHours)}h`],
      icon: CircleOff,
      color: "text-orange-500",
    },
    {
      label: "Total Cost",
      // One line per currency: amounts in different currencies are not added.
      value: formatCostLines(costByCurrency),
      detail: formatUnratedHours(unratedBillableHours),
      icon: DollarSign,
      color: "text-emerald-500",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => (
        <div key={card.label} className="rounded-lg border p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-1">
            <card.icon className={`h-4 w-4 ${card.color}`} />
            <span className="text-xs font-medium">{card.label}</span>
          </div>
          {card.value.map((line, index) => (
            <div key={index} className="text-2xl font-bold">
              {line}
            </div>
          ))}
          {card.detail && (
            <div className="text-xs text-muted-foreground mt-1">
              {card.detail}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
