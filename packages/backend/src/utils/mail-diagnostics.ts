// SMTP peers and thrown objects may put credentials or content in any string
// field. Retain only known labels and a bounded numeric SMTP reply code.
const CODES = new Set([
  "EAUTH",
  "ESOCKET",
  "ETIMEDOUT",
  "EENVELOPE",
  "EMESSAGE",
  "ECONNECTION",
  "EDNS",
  "ESTREAM",
  "EFILE",
  "EURL",
  "EOPTIONS",
  "EPROTOCOL",
  "ETLS",
  "ENOAUTH",
  "EADDRESS",
]);
const COMMANDS = new Set([
  "CONN",
  "AUTH",
  "EHLO",
  "HELO",
  "MAIL",
  "RCPT",
  "DATA",
  "STARTTLS",
  "RSET",
  "QUIT",
  "NOOP",
]);

const DATABASE_CATEGORIES = new Map([
  ["P1000", "authentication"],
  ["P1001", "unavailable"],
  ["P1002", "timeout"],
  ["P1003", "database_missing"],
  ["P1008", "timeout"],
  ["P1010", "authorization"],
  ["P1011", "tls"],
  ["P1012", "configuration"],
  ["P1013", "configuration"],
  ["P1014", "schema"],
  ["P1015", "configuration"],
  ["P1016", "query"],
  ["P1017", "unavailable"],
  ["P2021", "schema"],
  ["P2022", "schema"],
  ["P2024", "timeout"],
  ["P2037", "capacity"],
]);

/** Database failures have their own fixed vocabulary; no query, URL or params. */
export function describeMailConfigFailure(error: unknown) {
  try {
    const code = (error as { code?: unknown } | null)?.code;
    const category = typeof code === "string" ? DATABASE_CATEGORIES.get(code) : undefined;
    if (category) return { category, code: code as string };
  } catch {
    // Do not let a hostile thrown object's getter mask the original failure.
  }
  return { category: "unknown" };
}

export function describeMailFailure(error: unknown) {
  const failure = (error ?? {}) as Record<string, unknown>;
  try {
    const code = failure.code;
    const responseCode = failure.responseCode;
    const command =
      typeof failure.command === "string"
        ? failure.command.split(" ")[0]
        : undefined;
    return {
      code: typeof code === "string" && CODES.has(code) ? code : undefined,
      responseCode:
        typeof responseCode === "number" &&
        Number.isInteger(responseCode) &&
        responseCode >= 200 &&
        responseCode <= 599
          ? responseCode
          : undefined,
      command: command && COMMANDS.has(command) ? command : undefined,
    };
  } catch {
    // A thrown object can even have throwing property getters.
    return {};
  }
}

export function testMailFailureMessage(error: unknown): string {
  const failure = describeMailFailure(error);
  if (failure.code === "EADDRESS") {
    return "Failed to send test email. Check From Address: use one mailbox, optionally with a display name, without line breaks, comments or groups. Save corrected settings before trying again.";
  }
  let guidance =
    "Check SMTP host, port, TLS, credentials and sender settings, then try again.";
  if (failure.code === "EAUTH")
    guidance =
      "Check SMTP username and password, and the server's authentication requirements.";
  else if (failure.code === "EENVELOPE")
    guidance =
      "Check From Address and whether your SMTP server permits this sender and recipient.";
  else if (failure.code === "EMESSAGE")
    guidance = "Check the SMTP server's message policy and sender permissions.";
  const metadata = [
    failure.code,
    failure.responseCode ? `SMTP ${failure.responseCode}` : undefined,
    failure.command,
  ]
    .filter(Boolean)
    .join(", ");
  return `Failed to send test email. ${guidance}${metadata ? ` (${metadata})` : ""}`;
}
