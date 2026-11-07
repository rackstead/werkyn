import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Importing the module validates process.env once, so give this process a
// valid baseline before loading it. Table tests call the pure parser.
Object.assign(process.env, {
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/unused",
  JWT_SECRET: "env-validation-test-jwt",
  COOKIE_SECRET: "env-validation-test-cookie",
});
const { parseEnvironment } = await import("../src/config/env.ts");

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:db-password-value@127.0.0.1:5432/werkyn",
  JWT_SECRET: "test-jwt",
  COOKIE_SECRET: "test-cookie",
};
const production = {
  ...base,
  NODE_ENV: "production",
  JWT_SECRET: "operator-jwt-secret-at-least-32-characters",
  COOKIE_SECRET: "operator-cookie-secret-at-least-32-characters",
};

function rejects(overrides, field, pattern, source = base) {
  const result = parseEnvironment({ ...source, ...overrides });
  assert.equal(result.success, false, `${JSON.stringify(overrides)} was accepted`);
  assert.ok(result.errors[field], `${field} not reported: ${JSON.stringify(result.errors)}`);
  if (pattern) assert.match(result.errors[field].join("\n"), pattern);
  return result;
}

function accepts(overrides, source = base) {
  const result = parseEnvironment({ ...source, ...overrides });
  assert.equal(result.success, true, JSON.stringify(result.errors));
  return result;
}

test("numeric settings must be whole numbers in range", () => {
  for (const name of ["PORT", "SMTP_PORT", "DEX_INTERNAL_PORT"]) {
    for (const value of ["0", "-1", "65536", "3000.5", "abc", "12abc", "NaN"]) {
      rejects({ [name]: value }, name);
    }
    assert.equal(accepts({ [name]: "65535" }).data[name], 65535);
  }
  for (const value of ["0", "-5", "1.5", "lots", String(Number.MAX_SAFE_INTEGER + 2)]) {
    rejects({ MAX_FILE_SIZE: value }, "MAX_FILE_SIZE");
  }
  assert.equal(accepts({ MAX_FILE_SIZE: "1048576" }).data.MAX_FILE_SIZE, 1048576);
});

test("blank optional values keep documented defaults", () => {
  const { data } = accepts({
    PORT: "",
    SMTP_PORT: " ",
    MAX_FILE_SIZE: "",
    COOKIE_SECURE: "",
    SMTP_SECURE: "",
    COOKIE_DOMAIN: "",
    FRONTEND_URL: "",
    CORS_ORIGIN: " ",
    COOKIE_SAMESITE: "",
    LOG_LEVEL: "",
    STORAGE_DIR: "",
    DEX_CONFIG_DIR: "",
    DEX_CLIENT_SECRET: "",
  });
  assert.equal(data.FRONTEND_URL, "http://localhost:5173");
  assert.equal(data.CORS_ORIGIN, "http://localhost:5173");
  assert.equal(data.COOKIE_SAMESITE, "lax");
  assert.equal(data.LOG_LEVEL, "info");
  assert.equal(data.STORAGE_DIR, "./storage");
  assert.equal(data.DEX_CONFIG_DIR, "/app/data/dex");
  assert.equal(data.DEX_CLIENT_SECRET, base.JWT_SECRET);
  assert.equal(data.PORT, 3000);
  assert.equal(data.SMTP_PORT, 587);
  assert.equal(data.MAX_FILE_SIZE, 10737418240);
  assert.equal(data.COOKIE_SECURE, false);
  assert.equal(data.SMTP_SECURE, false);
  assert.equal(data.COOKIE_DOMAIN, "");
});

test("boolean flags accept only true or false", () => {
  for (const name of ["COOKIE_SECURE", "SMTP_SECURE"]) {
    for (const value of ["1", "yes", "TRUE", "on", "false "]) {
      rejects({ [name]: value }, name, /"true" or "false"/);
    }
    assert.equal(accepts({ [name]: "true" }).data[name], true);
    assert.equal(accepts({ [name]: "false" }).data[name], false);
  }
});

test("SMTP_FROM accepts only one mailbox and reports invalid settings without echoing them", () => {
  for (const value of ["sender@example.test\r\nBcc: other@example.test", "Team: sender@example.test;", "sender(comment)@example.test", "sender@example.test, other@example.test"]) {
    const result = rejects({ SMTP_FROM: value }, "SMTP_FROM", /single mailbox/);
    assert.equal(JSON.stringify(result.errors).includes(value), false);
  }
  for (const value of ["", "sender@example.test", '"Werkyn, Team" <sender@example.test>', "Équipe <sender@example.test>"]) accepts({ SMTP_FROM: value });
});

test("URL settings must be usable http(s) URLs and origins", () => {
  for (const value of ["localhost:5173", "ftp://example.com", "javascript:alert(1)", "https://user:pw@example.com", "https://example.com/?next=x", "not a url"]) {
    rejects({ FRONTEND_URL: value }, "FRONTEND_URL");
  }
  assert.equal(accepts({ FRONTEND_URL: "https://werkyn.example.com/" }).data.FRONTEND_URL, "https://werkyn.example.com");

  for (const value of ["*", "localhost:5173", "https://app.example.com/path", "https://a.example.com,ftp://b.example.com", ","]) {
    rejects({ CORS_ORIGIN: value }, "CORS_ORIGIN");
  }
  assert.equal(
    accepts({ CORS_ORIGIN: " https://App.Example.com/ , http://localhost:5173" }).data.CORS_ORIGIN,
    "https://app.example.com,http://localhost:5173",
  );

  for (const name of ["DATABASE_URL", "JWT_SECRET", "COOKIE_SECRET"]) {
    rejects({ [name]: "" }, name, /required/);
  }
  for (const value of ["mysql://u:p@h/db", "werkyn", "file:./dev.db", "postgresql:foo", "postgresql:///werkyn", "postgresql://db.internal:5432", "postgresql://db.internal/"]) {
    const result = rejects({ DATABASE_URL: value }, "DATABASE_URL", /PostgreSQL/);
    assert.equal(JSON.stringify(result.errors).includes(value), false);
  }
  accepts({ DATABASE_URL: "postgres://u:p@db:5432/werkyn?schema=public" });

  for (const value of ["https://example.com", "example.com:443", "example.com/app", "exa mple.com"]) {
    rejects({ COOKIE_DOMAIN: value }, "COOKIE_DOMAIN");
  }
  accepts({ COOKIE_DOMAIN: ".example.com" });
});

test("enumerated settings name their choices without repeating the value", () => {
  const pasted = "pasted-secret-in-the-wrong-variable";
  for (const name of ["NODE_ENV", "LOG_LEVEL", "COOKIE_SAMESITE", "DEX_STORAGE_TYPE"]) {
    const result = rejects({ [name]: pasted }, name, /must be one of/);
    assert.equal(JSON.stringify(result.errors).includes(pasted), false, JSON.stringify(result.errors));
  }
});

test("SameSite=None cookies require Secure in every mode", () => {
  rejects({ COOKIE_SAMESITE: "none" }, "COOKIE_SAMESITE", /COOKIE_SECURE=true/);
  rejects({ COOKIE_SAMESITE: "none", COOKIE_SECURE: "false" }, "COOKIE_SAMESITE", /COOKIE_SECURE=true/, production);
  accepts({ COOKIE_SAMESITE: "none", COOKIE_SECURE: "true" });
  // Production defaults to Secure, so None is usable without an explicit flag.
  assert.equal(accepts({ COOKIE_SAMESITE: "none" }, production).data.COOKIE_SECURE, true);
});

test("production keeps secure cookie defaults and the documented local HTTP mode", () => {
  assert.equal(accepts({}, production).data.COOKIE_SECURE, true);
  assert.equal(accepts({}, base).data.COOKIE_SECURE, false);

  // docker-compose.yml: local HTTP install explicitly opts out of Secure.
  const local = accepts({ COOKIE_SECURE: "false", FRONTEND_URL: "http://localhost:3000", CORS_ORIGIN: "http://localhost:3000" }, production);
  assert.equal(local.data.COOKIE_SECURE, false);
  assert.deepEqual(local.warnings, []);

  // HTTPS public URL with insecure cookies starts, but says why it is unsafe.
  const remote = accepts({ COOKIE_SECURE: "false", FRONTEND_URL: "https://werkyn.example.com" }, production);
  assert.match(remote.warnings.join("\n"), /COOKIE_SECURE=true/);

  // Required operator secrets (PR28) remain enforced alongside these checks.
  rejects({ JWT_SECRET: "short" }, "JWT_SECRET", /unique random secret/, production);
});

function startWith(env) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", "await import('./src/config/env.ts'); console.log('ENV-OK')"],
    {
      cwd: new URL("..", import.meta.url),
      env: { PATH: process.env.PATH, LOG_LEVEL: "error", ...env },
      encoding: "utf8",
    },
  );
}

test("startup exits with a clear message and never prints rejected values", () => {
  const result = startWith({
    ...base,
    PORT: "70000",
    DATABASE_URL: "mysql://user:hunter2-db-secret@db/werkyn",
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /ENV-OK/);
  assert.match(result.stdout, /Invalid environment variables/);
  assert.match(result.stdout, /PORT/);
  assert.match(result.stdout, /DATABASE_URL/);
  assert.equal((result.stdout + result.stderr).includes("hunter2-db-secret"), false);
});

test("an invalid LOG_LEVEL is reported instead of crashing the logger", () => {
  const result = startWith({ ...base, LOG_LEVEL: "verbose" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /LOG_LEVEL/);
  assert.doesNotMatch(result.stderr, /unknown level/);
});

test("login backoff settings have safe defaults, bounded ranges and a consistent order", () => {
  const { data } = accepts({});
  assert.equal(data.LOGIN_BACKOFF_THRESHOLD, 5);
  assert.equal(data.LOGIN_BACKOFF_BASE_SECONDS, 2);
  assert.equal(data.LOGIN_BACKOFF_MAX_SECONDS, 60);
  assert.equal(data.LOGIN_BACKOFF_RESET_SECONDS, 3600);
  assert.equal(data.LOGIN_BACKOFF_SLOTS, 65536);
  const blank = accepts({
    LOGIN_BACKOFF_THRESHOLD: "",
    LOGIN_BACKOFF_BASE_SECONDS: " ",
    LOGIN_BACKOFF_MAX_SECONDS: "",
    LOGIN_BACKOFF_RESET_SECONDS: "",
    LOGIN_BACKOFF_SLOTS: "",
  }).data;
  assert.equal(blank.LOGIN_BACKOFF_SLOTS, 65536);
  const ranges = {
    LOGIN_BACKOFF_THRESHOLD: ["0", "101", "2.5", "five"],
    LOGIN_BACKOFF_BASE_SECONDS: ["0", "901", "-1"],
    LOGIN_BACKOFF_MAX_SECONDS: ["0", "901"],
    LOGIN_BACKOFF_RESET_SECONDS: ["59", "604801"],
    LOGIN_BACKOFF_SLOTS: ["255", "16777217", "slots"],
  };
  for (const [name, values] of Object.entries(ranges))
    for (const value of values) rejects({ [name]: value }, name, /whole number/);
  const custom = accepts({
    LOGIN_BACKOFF_THRESHOLD: "3",
    LOGIN_BACKOFF_BASE_SECONDS: "1",
    LOGIN_BACKOFF_MAX_SECONDS: "30",
    LOGIN_BACKOFF_RESET_SECONDS: "900",
    LOGIN_BACKOFF_SLOTS: "1024",
  }).data;
  assert.deepEqual(
    [
      custom.LOGIN_BACKOFF_THRESHOLD,
      custom.LOGIN_BACKOFF_BASE_SECONDS,
      custom.LOGIN_BACKOFF_MAX_SECONDS,
      custom.LOGIN_BACKOFF_RESET_SECONDS,
      custom.LOGIN_BACKOFF_SLOTS,
    ],
    [3, 1, 30, 900, 1024],
  );
  rejects(
    { LOGIN_BACKOFF_BASE_SECONDS: "90", LOGIN_BACKOFF_MAX_SECONDS: "60" },
    "LOGIN_BACKOFF_BASE_SECONDS",
    /must not exceed LOGIN_BACKOFF_MAX_SECONDS/,
  );
  rejects(
    { LOGIN_BACKOFF_MAX_SECONDS: "900", LOGIN_BACKOFF_RESET_SECONDS: "600" },
    "LOGIN_BACKOFF_MAX_SECONDS",
    /must not exceed LOGIN_BACKOFF_RESET_SECONDS/,
  );
});

test("password-reset cooldown and per-process ceiling have safe defaults and bounded ranges", () => {
  const { data } = accepts({});
  assert.equal(data.PASSWORD_RESET_COOLDOWN_SECONDS, 60);
  assert.equal(data.PASSWORD_RESET_REQUESTS_PER_MINUTE, 6000);
  const blank = accepts({
    PASSWORD_RESET_COOLDOWN_SECONDS: "",
    PASSWORD_RESET_REQUESTS_PER_MINUTE: " ",
  }).data;
  assert.equal(blank.PASSWORD_RESET_REQUESTS_PER_MINUTE, 6000);
  assert.equal(accepts({ PASSWORD_RESET_COOLDOWN_SECONDS: "0" }).data.PASSWORD_RESET_COOLDOWN_SECONDS, 0);
  assert.equal(accepts({ PASSWORD_RESET_COOLDOWN_SECONDS: "3600" }).data.PASSWORD_RESET_COOLDOWN_SECONDS, 3600);
  // A link lives an hour; the cooldown is read from it, so it cannot be longer.
  for (const value of ["-1", "3601", "86400", "1.5", "soon"])
    rejects({ PASSWORD_RESET_COOLDOWN_SECONDS: value }, "PASSWORD_RESET_COOLDOWN_SECONDS", /whole number/);
  for (const value of ["59", "1000001", "lots"])
    rejects({ PASSWORD_RESET_REQUESTS_PER_MINUTE: value }, "PASSWORD_RESET_REQUESTS_PER_MINUTE", /whole number/);
});

test("backup upload minimum rate settings have safe defaults and bounded ranges", () => {
  const { data } = accepts({});
  assert.equal(data.BACKUP_UPLOAD_MIN_BYTES_PER_SECOND, 16384);
  assert.equal(data.BACKUP_UPLOAD_RATE_WINDOW_SECONDS, 60);
  assert.equal(data.BACKUP_UPLOAD_RATE_GRACE_SECONDS, 30);
  const blank = accepts({
    BACKUP_UPLOAD_MIN_BYTES_PER_SECOND: "",
    BACKUP_UPLOAD_RATE_WINDOW_SECONDS: " ",
    BACKUP_UPLOAD_RATE_GRACE_SECONDS: "",
  }).data;
  assert.equal(blank.BACKUP_UPLOAD_MIN_BYTES_PER_SECOND, 16384);
  assert.equal(blank.BACKUP_UPLOAD_RATE_WINDOW_SECONDS, 60);
  assert.equal(blank.BACKUP_UPLOAD_RATE_GRACE_SECONDS, 30);
  const ranges = {
    // The rate cannot be switched off: 1 byte a second is the lowest.
    BACKUP_UPLOAD_MIN_BYTES_PER_SECOND: ["0", "-1", "1073741825", "1.5", "fast"],
    BACKUP_UPLOAD_RATE_WINDOW_SECONDS: ["0", "3601", "2.5"],
    BACKUP_UPLOAD_RATE_GRACE_SECONDS: ["0", "3601", "soon"],
  };
  for (const [name, values] of Object.entries(ranges))
    for (const value of values) rejects({ [name]: value }, name, /whole number/);
  const custom = accepts({
    BACKUP_UPLOAD_MIN_BYTES_PER_SECOND: "1",
    BACKUP_UPLOAD_RATE_WINDOW_SECONDS: "3600",
    BACKUP_UPLOAD_RATE_GRACE_SECONDS: "1",
  }).data;
  assert.deepEqual(
    [
      custom.BACKUP_UPLOAD_MIN_BYTES_PER_SECOND,
      custom.BACKUP_UPLOAD_RATE_WINDOW_SECONDS,
      custom.BACKUP_UPLOAD_RATE_GRACE_SECONDS,
    ],
    [1, 3600, 1],
  );
  assert.equal(
    accepts({ BACKUP_UPLOAD_MIN_BYTES_PER_SECOND: "1073741824" }).data.BACKUP_UPLOAD_MIN_BYTES_PER_SECOND,
    1073741824,
  );
});

test("the backup upload cooldown defaults to two minutes and 0 turns it off", () => {
  assert.equal(accepts({}).data.BACKUP_UPLOAD_RATE_COOLDOWN_SECONDS, 120);
  assert.equal(accepts({ BACKUP_UPLOAD_RATE_COOLDOWN_SECONDS: "" }).data.BACKUP_UPLOAD_RATE_COOLDOWN_SECONDS, 120);
  assert.equal(accepts({ BACKUP_UPLOAD_RATE_COOLDOWN_SECONDS: "0" }).data.BACKUP_UPLOAD_RATE_COOLDOWN_SECONDS, 0);
  assert.equal(accepts({ BACKUP_UPLOAD_RATE_COOLDOWN_SECONDS: "3600" }).data.BACKUP_UPLOAD_RATE_COOLDOWN_SECONDS, 3600);
  for (const value of ["-1", "3601", "1.5", "later"])
    rejects({ BACKUP_UPLOAD_RATE_COOLDOWN_SECONDS: value }, "BACKUP_UPLOAD_RATE_COOLDOWN_SECONDS", /whole number from 0 to 3600/);
});
