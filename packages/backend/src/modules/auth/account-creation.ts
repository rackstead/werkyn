import type { Prisma } from "@prisma/client";
import { setTimeout } from "node:timers/promises";

export async function waitForAccountRetry(attempt: number) {
  // Give a competing transaction time to finish before taking a fresh snapshot.
  // Both callers permit at most three attempts, so total backoff is bounded.
  await setTimeout(25 * (attempt + 1));
}

export const accountUserSelect = {
  id: true,
  email: true,
  displayName: true,
  avatarUrl: true,
  jobTitle: true,
  phone: true,
  timezone: true,
  emailVerified: true,
} satisfies Prisma.UserSelect;

// Every automatic account-creation path must call this inside a SERIALIZABLE
// transaction and retry serialization failures with a fresh transaction. The
// empty-User predicate and INSERT then conflict across local and OIDC signups;
// only an eligible first account can receive automatic bootstrap privileges.
// Provider creation belongs in the same transaction, so a failed account does
// not consume bootstrap. Later explicit administrator promotion stays allowed.
export async function createAccount(
  tx: Prisma.TransactionClient,
  data: Prisma.UserCreateInput,
  options: { bootstrapAdminEligible: boolean },
) {
  // OIDC accounts remain ineligible, but must participate in the predicate read
  // so a concurrent local creator cannot bootstrap from a stale empty snapshot.
  const isFirstUser = (await tx.user.count({ take: 1 })) === 0;
  const isBootstrapAdmin = isFirstUser && options.bootstrapAdminEligible;
  const user = await tx.user.create({
    data: {
      ...data,
      isInstanceAdmin: isBootstrapAdmin,
      emailVerified: isBootstrapAdmin || data.emailVerified === true,
    },
    select: accountUserSelect,
  });
  return { user, isBootstrapAdmin };
}
