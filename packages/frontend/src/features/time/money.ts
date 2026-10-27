import type { CurrencyAmount } from "./api";

/** Format an amount in its currency; codes Intl rejects fall back to "12.50 XYZ". */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * One display line per currency. Totals in different currencies are never
 * combined into a single figure.
 */
export function formatCostLines(costByCurrency: CurrencyAmount[]): string[] {
  if (costByCurrency.length === 0) return [(0).toFixed(2)];
  return costByCurrency.map(({ amount, currency }) =>
    formatMoney(amount, currency),
  );
}

/** Cost of a single report entry, which is null when no rate applied. */
export function formatEntryCost(
  cost: number | null,
  currency: string | null,
): string {
  if (cost === null) return "No rate";
  return currency ? formatMoney(cost, currency) : cost.toFixed(2);
}

export function formatUnratedHours(hours: number): string | null {
  if (hours <= 0) return null;
  const value = hours.toFixed(hours % 1 === 0 ? 0 : 2);
  return `${value}h billable without a rate`;
}
