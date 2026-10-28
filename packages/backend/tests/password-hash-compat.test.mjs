import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import bcrypt from "bcrypt";
import { hashPassword, verifyPassword } from "../src/utils/passwords.ts";

// Hashes and compare results recorded with bcrypt 5.1.1 before the move to
// bcrypt 6. Every stored account and share-link hash was written by that
// release, so the current bcrypt must reproduce its behaviour exactly.
const recorded = JSON.parse(
  readFileSync(
    new URL("./fixtures/bcrypt-5.1.1-hashes.json", import.meta.url),
    "utf8",
  ),
);

test("the recorded fixtures cover the stored hash shapes", () => {
  assert.equal(recorded.bcrypt, "5.1.1");
  const shapes = new Set(
    recorded.fixtures.map((f) => `${f.prefix}${f.rounds}`),
  );
  for (const shape of [
    "$2b$4",
    "$2b$10",
    "$2b$11",
    "$2b$12",
    "$2a$10",
    "$2a$12",
  ])
    assert(shapes.has(shape), shape);
  assert(recorded.fixtures.some((f) => f.passwordBytes > 72));
  assert(recorded.fixtures.some((f) => f.passwordBytes > 255));
});

for (const fixture of recorded.fixtures) {
  test(`bcrypt 5.1.1 hash still verifies identically: ${fixture.name}`, async () => {
    assert(
      fixture.hash.startsWith(
        `${fixture.prefix}${String(fixture.rounds).padStart(2, "0")}$`,
      ),
    );
    assert.equal(bcrypt.getRounds(fixture.hash), fixture.getRounds);
    // Same salt, same input: the hash must be byte-identical.
    assert.equal(
      await bcrypt.hash(fixture.password, fixture.hash.slice(0, 29)),
      fixture.rehashWithStoredSalt,
    );
    assert.equal(fixture.rehashWithStoredSalt, fixture.hash);
    const results = await Promise.all(
      fixture.compare.map(async ({ label, candidate }) => ({
        label,
        candidate,
        matches: await verifyPassword(candidate, fixture.hash),
      })),
    );
    assert.deepEqual(results, fixture.compare);
    assert.equal(
      await bcrypt.compare(fixture.password, fixture.hash),
      true,
      "share-link validation calls bcrypt.compare directly",
    );
  });
}

test("new hashes keep the $2b$ format and the account and share costs", async () => {
  const account = await hashPassword("Werkyn-new-account-password");
  assert.match(account, /^\$2b\$12\$[./A-Za-z0-9]{53}$/);
  assert.equal(
    await verifyPassword("Werkyn-new-account-password", account),
    true,
  );
  assert.equal(
    await verifyPassword("Werkyn-new-account-passwore", account),
    false,
  );
  const share = await bcrypt.hash("Werkyn-new-share-password", 10);
  assert.match(share, /^\$2b\$10\$[./A-Za-z0-9]{53}$/);
  assert.equal(await bcrypt.compare("Werkyn-new-share-password", share), true);
});
