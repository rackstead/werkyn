import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { afterEach, test } from "node:test";
import { startSmtpCapture, parseMessage, decodeWords } from "./fixtures/smtp-capture.mjs";
import { describeMailFailure } from "../src/utils/mail-diagnostics.ts";

const to = "mail-policy-person@example.test";
const from = "mail-policy-sender@example.test";
const user = "mail-policy-user@example.test";
const pass = "mail-policy-password-marker";
const token = "mail-policy-verification-marker";
const invite = "mail-policy-invitation-marker";
const privateText = `${to} ${from} ${user} ${pass} ${token} ${invite} https://private.example.test/message-content`;
const servers = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });
async function smtp(options) {
  const server = await startSmtpCapture(options);
  servers.push(server);
  return server;
}
async function run(fixture) {
  const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/mail-policy-worker.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, NODE_ENV: "production", LOG_LEVEL: "warn", DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/unused", JWT_SECRET: "mail-policy-jwt-at-least-32-characters", COOKIE_SECRET: "mail-policy-cookie-at-least-32-characters", SMTP_HOST: "", SMTP_FROM: "", MAIL_POLICY_FIXTURE: JSON.stringify({ to, token, invite, ...fixture }) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => stdout += chunk);
  child.stderr.on("data", (chunk) => stderr += chunk);
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  const code = await new Promise((resolve) => child.on("exit", resolve));
  clearTimeout(timer);
  assert.equal(code, 0, stdout + stderr);
  const lines = stdout.trim().split("\n");
  const result = JSON.parse(lines.find((line) => line.startsWith("RESULT ")).slice(7));
  const logs = lines.filter((line) => !line.startsWith("RESULT ")).join("\n");
  return { ...result, logs, serialized: stdout + stderr };
}
const environment = (port, overrides = {}) => ({ SMTP_HOST: "127.0.0.1", SMTP_PORT: port, SMTP_SECURE: false, SMTP_FROM: from, SMTP_USER: "", SMTP_PASS: "", ...overrides });
function privateFree(value) {
  for (const secret of [to, from, user, pass, token, invite, "private.example.test", "message-content"]) assert.equal(value.includes(secret), false, `private marker leaked: ${secret}`);
}

test("stored ambiguous sender fails before any SMTP command instead of rewriting the envelope", async () => {
  const server = await smtp();
  const result = await run({ environment: environment(server.port), stored: { host: "127.0.0.1", port: server.port, secure: false, user: "", pass: "", fromAddress: `${from}\r\nBcc: other@example.test` } });
  assert.equal(result.result.status, "failed", JSON.stringify(server.messages.map(({ envelope }) => envelope)));
  assert.equal(result.result.code, "EADDRESS");
  assert.equal(server.sessions.length, 0);
  privateFree(result.serialized);
});

test("account mail and admin test reject invalid legacy senders over their actual send paths", async () => {
  const server = await smtp();
  for (const fromAddress of ["Team: sender@example.test;", "sender(comment)@example.test", "sender@example.test, other@example.test"]) {
    const stored = { host: "127.0.0.1", port: server.port, secure: false, user: "", pass: "", fromAddress };
    const account = await run({ environment: environment(server.port), stored });
    assert.equal(account.result.status, "failed");
    const admin = await run({ environment: environment(server.port), stored, admin: true });
    assert.equal(admin.status, 400);
    assert.match(admin.body.message, /[Ff]rom [Aa]ddress|sender/);
  }
  assert.equal(server.sessions.length, 0);
});

test("named Unicode and quoted-comma senders retain their exact envelope and visible name", async () => {
  const server = await smtp();
  for (const [name, fromAddress] of [["Équipe Werkyn", `Équipe Werkyn <${from}>`], ["Werkyn, Team", `"Werkyn, Team" <${from}>`]]) {
    const result = await run({ environment: environment(server.port, { SMTP_FROM: fromAddress }) });
    assert.equal(result.result.status, "sent");
    const message = server.messages.at(-1);
    assert.equal(message.envelope.from, `<${from}>`);
    assert.ok(decodeWords(parseMessage(message.data).get("From")).includes(name));
  }
});

for (const [name, options, auth, expected] of [
  ["recipient", { rejectRecipient: `550 5.1.1 ${privateText}` }, false, ["EENVELOPE", 550, "RCPT"]],
  ["authentication", { rejectAuth: true, authFailure: `535 5.7.8 ${privateText}` }, true, ["EAUTH", 535, "AUTH"]],
  ["message", { rejectMessage: `554 5.7.1 ${privateText}` }, false, ["EMESSAGE", 554, "DATA"]],
]) {
  test(`real SMTP ${name} refusal keeps only bounded diagnostic metadata in serialized logs and API responses`, async () => {
    const server = await smtp(options);
    const settings = environment(server.port, auth ? { SMTP_USER: user, SMTP_PASS: pass } : {});
    const result = await run({ environment: settings });
    assert.equal(result.result.status, "failed");
    assert.equal(result.stats.lastFailureCode, expected[0]);
    const log = JSON.parse(result.logs.split("\n").at(-1));
    assert.deepEqual(log.smtp, { code: expected[0], responseCode: expected[1], command: expected[2] });
    privateFree(result.serialized);
    const admin = await run({ environment: settings, admin: true });
    assert.equal(admin.status, 400);
    assert.match(admin.body.message, /[Cc]heck/);
    privateFree(admin.serialized);
  });
}

test("untrusted non-Error fields cannot enter serialized logs, counters or returned outcomes", async () => {
  const result = await run({ environment: environment(1), failure: { message: privateText, code: privateText, command: privateText, responseCode: 550.5, response: privateText } });
  assert.equal(result.result.status, "failed");
  assert.equal(result.stats.lastFailureCode, null);
  privateFree(result.serialized);
});

test("database-read failures use the same safe diagnostics while preserving env fallback", async () => {
  const server = await smtp();
  const result = await run({ environment: environment(server.port), readFailure: { message: privateText, code: privateText } });
  assert.equal(result.result.status, "sent");
  privateFree(result.serialized);
});

test("admin SMTP rejection returns safe actionable guidance over HTTP", async () => {
  const server = await smtp({ rejectAuth: true, authFailure: `535 5.7.8 ${privateText}` });
  const result = await run({ environment: environment(server.port, { SMTP_USER: user, SMTP_PASS: pass }), admin: true });
  assert.equal(result.status, 400);
  assert.match(result.body.message, /Check SMTP username and password/);
  privateFree(result.serialized);
});

test("diagnostic fields accept only known labels and integer SMTP reply codes", () => {
  assert.deepEqual(describeMailFailure({ code: "EENVELOPE", responseCode: 550, command: `RCPT TO:<${to}>`, message: privateText }), { code: "EENVELOPE", responseCode: 550, command: "RCPT" });
  for (const error of [null, privateText, 1, { code: privateText, responseCode: Infinity, command: privateText }, { code: "EAUTH " + token, responseCode: 1000, command: "AUTH" + token }]) {
    assert.equal(JSON.stringify(describeMailFailure(error)), "{}");
  }
  assert.deepEqual(describeMailFailure({ get code() { throw new Error(privateText); } }), {});
});
