import { DATE_ONLY_MAX_YEAR } from "@pm/shared";
import { formatDateISO, parseDateISO } from "@/features/time/utils";
import type { DateInputContent } from "@/lib/date-input";

/** The last date an expiry input offers (the API's last calendar year). */
export const LAST_EXPIRY_DATE = `${DATE_ONLY_MAX_YEAR}-12-31`;

/**
 * The instant a link set to expire on `date` (YYYY-MM-DD) stops working: the
 * end of that day in the browser's time zone.
 */
export function endOfLocalDay(date: string): string {
  return new Date(`${date}T23:59:59`).toISOString();
}

/** The local calendar date of a stored expiry. */
export function localExpiryDate(expiresAt: string): string {
  return formatDateISO(new Date(expiresAt));
}

/**
 * Why an expiry input's content may not be sent, or null. An incomplete date
 * is never read as "no expiry", and a day before today is refused here as it
 * is by the API.
 */
export function expiryProblem(
  content: DateInputContent,
  today = formatDateISO(new Date()),
): string | null {
  if (content.kind === "incomplete") return "Enter a complete date.";
  if (content.kind === "date" && content.date < today) return "Choose today or a later date.";
  return null;
}

/** A stored expiry as the dialog states it: "never expires", "expires on …". */
export function describeExpiry(expiresAt: string | null, now = new Date()): string {
  if (!expiresAt) return "never expires";
  const at = new Date(expiresAt);
  return `${at <= now ? "expired" : "expires"} on ${at.toLocaleDateString()}`;
}

/** What an expiry input holding `date` means, for the note under it. */
export function describeExpiryDate(date: string): string {
  return `The link stops working at the end of ${parseDateISO(date)?.toLocaleDateString() ?? date}.`;
}
