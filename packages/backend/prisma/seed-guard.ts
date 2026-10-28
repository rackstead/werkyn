// Safety checks for prisma/seed.ts. The seed creates an instance admin and
// other accounts with a published password, so it may only populate an empty
// development database, and SEED_FORCE may only replace data it created.

export const SEED_USER_EMAILS = [
  "alice@test.com",
  "bob@test.com",
  "charlie@test.com",
  "diana@test.com",
  "eve@test.com",
] as const;

export const SEED_WORKSPACE_SLUGS = ["acme-corp", "side-project"] as const;

/** The published sample password every seed account is created with. */
export const SEED_PASSWORD = "password123";

/**
 * Counts accounts that are verifiably seed-created: a seed address alone is
 * not proof, so the account must still have the published seed password.
 * Anyone can register such an address, and a real user may have changed it.
 */
export async function countVerifiedSeedUsers(
  users: { passwordHash: string | null }[],
  compare: (password: string, hash: string) => Promise<boolean>,
): Promise<number> {
  let verified = 0;
  for (const user of users) {
    if (user.passwordHash && (await compare(SEED_PASSWORD, user.passwordHash))) verified += 1;
  }
  return verified;
}

export interface SeedInventory {
  users: number;
  /** Seed-address accounts that still have the seed password. */
  seedUsers: number;
  workspaces: number;
  seedWorkspaces: number;
}

export type SeedDecision =
  | { action: "seed" }
  | { action: "reseed" }
  | { action: "skip"; reason: string }
  | { action: "refuse"; reason: string };

export function environmentRefusal(nodeEnv: string | undefined): string | undefined {
  if (nodeEnv === "production") {
    return (
      "NODE_ENV is production. The seed creates accounts with a published password; " +
      "run it only against a disposable development database."
    );
  }
  return undefined;
}

export function decideSeed(inventory: SeedInventory, force: boolean): SeedDecision {
  const otherUsers = inventory.users - inventory.seedUsers;
  const otherWorkspaces = inventory.workspaces - inventory.seedWorkspaces;
  if (otherUsers > 0 || otherWorkspaces > 0) {
    return {
      action: "refuse",
      reason:
        `the database contains ${otherUsers} account(s) and ${otherWorkspaces} workspace(s) ` +
        "that the seed did not create. Seed only an empty development database; " +
        "SEED_FORCE never deletes data the seed did not create.",
    };
  }
  if (inventory.seedUsers > 0 || inventory.seedWorkspaces > 0) {
    return force
      ? { action: "reseed" }
      : { action: "skip", reason: "Seed data already exists. Set SEED_FORCE=true to replace it." };
  }
  return { action: "seed" };
}
