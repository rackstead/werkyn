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

// If no committed existing account was observed before starting the transaction,
// every automatic creation path must use SERIALIZABLE and retry conflicts with a
// fresh transaction. The empty-User predicate and INSERT then conflict across
// local and OIDC signups; only an eligible first account can bootstrap.
// Once an account exists, local creation can use READ COMMITTED without the
// predicate: serializing ordinary registrations would cause needless conflicts.
// Runtime account deletion is not supported; destructive seeds/manual deletion
// must not run concurrently with signup.
// Provider creation belongs in the same transaction, so a failed account does
// not consume bootstrap. Later explicit administrator promotion stays allowed.
export async function createAccount(
  tx: Prisma.TransactionClient,
  data: Prisma.UserCreateInput,
  options: {
    bootstrapAdminEligible: boolean;
    existingAccountObserved: boolean;
  },
) {
  // On a potentially empty installation, ineligible OIDC creators must also
  // predicate-read so a local creator cannot bootstrap from a stale snapshot.
  const isFirstUser =
    !options.existingAccountObserved &&
    (await tx.user.count({ take: 1 })) === 0;
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
