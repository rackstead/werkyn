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
  test(`raw bcrypt5 fixture and bounded application legacy handling: ${fixture.name}`, async () => {
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
    // Application legacy verification deliberately refuses candidates over72
    // bytes. Keep recorded raw-library outcomes immutable and test them below.
    const results = [];
    for (const { label, candidate } of fixture.compare) {
      results.push({ label, candidate, matches: await verifyPassword(candidate, fixture.hash) });
    }
    assert.deepEqual(results, fixture.compare.map((row) => ({
      ...row, matches: Buffer.byteLength(row.candidate, "utf8") <= 72 && row.matches,
    })));
    assert.equal(
      await bcrypt.compare(fixture.password, fixture.hash),
      true,
      "raw bcrypt library compatibility remains distinct from bounded application policy",
    );
  });
}

test("new account and share helpers use explicit Argon2id parameters", async () => {
  for (const password of ["Werkyn-new-account-password", "Werkyn-new-share-password"]) {
    const hash = await hashPassword(password);
    assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    assert.equal(await verifyPassword(password, hash), true);
    assert.equal(await verifyPassword(password + "!", hash), false);
  }
});
