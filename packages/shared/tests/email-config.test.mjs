import assert from "node:assert/strict";
import test from "node:test";
import { UpdateEmailConfigSchema } from "../dist/index.js";

test("sender accepts an empty fallback, one address or a named mailbox", () => {
  for (const fromAddress of ["", "person@example.test", "Werkyn Team <sender@example.test>", '"Werkyn, Team" <sender@example.test>', "Équipe Werkyn <sender+tag@example.test>"]) {
    assert.equal(UpdateEmailConfigSchema.safeParse({ fromAddress }).success, true, fromAddress);
  }
});

for (const [name, fromAddress] of Object.entries({
  CRLF: "sender@example.test\r\nBcc: other@example.test",
  newline: '"Werkyn\nTeam" <sender@example.test>',
  list: "sender@example.test, other@example.test",
  group: "Team: sender@example.test;",
  comment: "sender(comment)@example.test",
  nestedComment: "sender@example.test (a (b) other@example.test)",
  extraAngle: "Team <sender@example.test> <other@example.test>",
  suffix: "Team <sender@example.test> extra",
  invalidAddress: "not-an-address",
  control: "Team\u0000 <sender@example.test>",
})) {
  test(`sender rejects ${name} without echoing the supplied value`, () => {
    const result = UpdateEmailConfigSchema.safeParse({ fromAddress });
    assert.equal(result.success, false);
    assert.equal(JSON.stringify(result.error.issues).includes(fromAddress), false);
  });
}
