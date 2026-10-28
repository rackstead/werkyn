import type { Prisma, PrismaClient } from "@prisma/client";
import type { SetUserRateInput } from "@pm/shared";
import { NotFoundError } from "../../utils/errors.js";

export async function setRate(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  data: SetUserRateInput,
) {
  const member = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { id: true },
  });
  if (!member) throw new NotFoundError("User is not a workspace member");

  const effectiveFrom =
    data.effectiveFrom ?? new Date().toISOString().slice(0, 10);
  // A new rate without an explicit currency keeps the member's currency in
  // force on that date, so editing an amount never silently switches currency.
  const currency = (
    data.currency ??
    (await getRate(prisma, workspaceId, userId, effectiveFrom))?.currency ??
    "USD"
  ).toUpperCase();

  return prisma.userRate.upsert({
    where: {
      workspaceId_userId_effectiveFrom: {
        workspaceId,
        userId,
        effectiveFrom,
      },
    },
    create: {
      workspaceId,
      userId,
      rate: data.rate,
      currency,
      effectiveFrom,
    },
    update: {
      rate: data.rate,
      ...(data.currency ? { currency: data.currency } : {}),
    },
  });
}

export async function getRate(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
  date?: string,
) {
  const asOfDate = date ?? new Date().toISOString().slice(0, 10);

  return prisma.userRate.findFirst({
    where: {
      workspaceId,
      userId,
      effectiveFrom: { lte: asOfDate },
    },
    orderBy: { effectiveFrom: "desc" },
  });
}

/**
 * Matches the Float values Prisma can read. PostgreSQL orders NaN above every
 * number, so the upper bound excludes NaN and Infinity and the lower bound
 * excludes -Infinity. The bound is 1e308 rather than Number.MAX_VALUE because
 * Prisma sends query numbers with 16 significant digits, which rounds
 * MAX_VALUE up past the largest double; the few finite values beyond 1e308
 * are treated like non-finite ones.
 */
export const FINITE_FLOAT: Prisma.FloatFilter = { gte: -1e308, lte: 1e308 };

/**
 * Rates for several members that start on or before `throughDate`, oldest
 * first per member. A stored rate that is not a finite number (only possible
 * through direct database writes) comes back with `rate: null`, so the dates
 * it covers count as unrated instead of failing the read or falling back to an
 * earlier rate.
 */
export async function listRateHistory(
  prisma: PrismaClient,
  workspaceId: string,
  userIds: string[],
  throughDate: string,
): Promise<Array<{ userId: string; rate: number | null; currency: string; effectiveFrom: string }>> {
  if (userIds.length === 0) return [];
  const where: Prisma.UserRateWhereInput = {
    workspaceId,
    userId: { in: userIds },
    effectiveFrom: { lte: throughDate },
  };
  const [finite, nonFinite] = await Promise.all([
    prisma.userRate.findMany({
      where: { ...where, rate: FINITE_FLOAT },
      select: { userId: true, rate: true, currency: true, effectiveFrom: true },
    }),
    // Prisma cannot read a non-finite Float, so the rate column is not selected.
    prisma.userRate.findMany({
      where: { ...where, NOT: { rate: FINITE_FLOAT } },
      select: { userId: true, currency: true, effectiveFrom: true },
    }),
  ]);
  return [...finite, ...nonFinite.map((row) => ({ ...row, rate: null }))].sort(
    (a, b) =>
      a.userId < b.userId ? -1
      : a.userId > b.userId ? 1
      : a.effectiveFrom < b.effectiveFrom ? -1
      : a.effectiveFrom > b.effectiveFrom ? 1
      : 0,
  );
}

/**
 * The rate in force on `date` from one member's oldest-first history: the
 * latest rate whose effectiveFrom is on or before that date (same semantics as
 * getRate). Dates are YYYY-MM-DD strings, so string order is date order.
 */
export function rateInEffect<T extends { effectiveFrom: string }>(
  history: readonly T[],
  date: string,
): T | null {
  let low = 0;
  let high = history.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (history[mid].effectiveFrom <= date) low = mid + 1;
    else high = mid;
  }
  return low === 0 ? null : history[low - 1];
}

export async function listRates(
  prisma: PrismaClient,
  workspaceId: string,
  userId?: string,
) {
  return prisma.userRate.findMany({
    where: {
      workspaceId,
      ...(userId ? { userId } : {}),
    },
    include: {
      user: { select: { id: true, displayName: true, avatarUrl: true } },
    },
    orderBy: [{ userId: "asc" }, { effectiveFrom: "desc" }],
  });
}
