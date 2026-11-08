import assert from "node:assert/strict";
import test from "node:test";
import { isLegacyFileShareToken } from "@pm/shared";
import {
  decideLegacyShareLookup,
  scrubNestedShareLinkArgs,
} from "../src/modules/files/legacy-share-lookup.ts";

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
  assert.deepEqual(decideLegacyShareLookup({ NOT: [{ token: legacy }] }), {
    action: "pass",
  });
  assert.deepEqual(
    decideLegacyShareLookup({ NOT: { NOT: { token: legacy } } }),
    { action: "miss" },
  );
  assert.deepEqual(
    decideLegacyShareLookup({ NOT: { token: { not: legacy } } }),
    { action: "miss" },
  );
  assert.deepEqual(
    decideLegacyShareLookup({ NOT: { OR: [{ token: legacy }, { id: "keep" }] } }),
    { action: "pass" },
  );
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

  const doubleMixed = {
    NOT: { NOT: { token: { in: [legacy, current] }, enabled: true } },
  };
  const unwrapped = decideLegacyShareLookup(doubleMixed);
  assert.equal(unwrapped.action, "rewrite");
  assert.deepEqual(unwrapped.where, {
    NOT: { NOT: { token: { in: [current] }, enabled: true } },
  });
  assert.deepEqual(doubleMixed.NOT.NOT.token.in, [legacy, current]);
});

test("relation filters that require an 8-character token cannot match", () => {
  const direct = scrubNestedShareLinkArgs({
    where: { shareLink: { token: legacy }, fileId: "file" },
  });
  assert.equal(direct.changed, true);
  assert.deepEqual(direct.args, {
    where: { shareLink: { id: "" }, fileId: "file" },
  });

  const listed = scrubNestedShareLinkArgs({
    include: { fileShareLinks: { where: { token: legacy } } },
  });
  assert.deepEqual(listed.args, {
    include: { fileShareLinks: { where: { id: "" } } },
  });

  const modern = scrubNestedShareLinkArgs({
    where: { fileShareLinks: { some: { token: current } } },
  });
  assert.equal(modern.changed, false);
  assert.deepEqual(modern.args.where.fileShareLinks.some.token, current);
});
