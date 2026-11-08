import assert from "node:assert/strict";
import test from "node:test";
import { isLegacyFileShareToken } from "@pm/shared";
import { decideLegacyShareLookup } from "../src/modules/files/legacy-share-lookup.ts";

const legacy = "abcdefgh";
const current = "A".repeat(43);

test("only an 8-character drive share token is the retired shape", () => {
  assert.equal(isLegacyFileShareToken(legacy), true);
  assert.equal(isLegacyFileShareToken(current), false);
  assert.equal(isLegacyFileShareToken("token-1"), false);
  assert.equal(isLegacyFileShareToken(""), false);
  assert.equal(isLegacyFileShareToken(null), false);
});

test("a lookup that requires an 8-character token misses, and other reads pass", () => {
  assert.deepEqual(decideLegacyShareLookup(undefined), { action: "pass" });
  assert.deepEqual(decideLegacyShareLookup({ id: "link" }), { action: "pass" });
  assert.deepEqual(decideLegacyShareLookup({ token: current, enabled: true }), {
    action: "pass",
  });
  assert.deepEqual(decideLegacyShareLookup({ NOT: { token: legacy } }), {
    action: "pass",
  });
  assert.deepEqual(decideLegacyShareLookup({ token: legacy }), { action: "miss" });
  assert.deepEqual(decideLegacyShareLookup({ token: { equals: legacy } }), {
    action: "miss",
  });
  assert.deepEqual(decideLegacyShareLookup({ token: { in: [legacy] } }), {
    action: "miss",
  });
  assert.deepEqual(
    decideLegacyShareLookup({ AND: [{ workspaceId: "w" }, { token: legacy }] }),
    { action: "miss" },
  );
  assert.deepEqual(decideLegacyShareLookup({ OR: [{ token: legacy }] }), {
    action: "miss",
  });

  const mixed = { token: { in: [legacy, current] }, enabled: true };
  const rewritten = decideLegacyShareLookup(mixed);
  assert.equal(rewritten.action, "rewrite");
  assert.deepEqual(rewritten.where, { token: { in: [current] }, enabled: true });
  assert.deepEqual(mixed.token.in, [legacy, current]);

  const either = { OR: [{ token: legacy }, { id: "keep" }] };
  const kept = decideLegacyShareLookup(either);
  assert.equal(kept.action, "rewrite");
  assert.deepEqual(kept.where, { OR: [{ id: "keep" }] });
  assert.equal(either.OR.length, 2);
});
