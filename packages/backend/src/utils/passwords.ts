import bcrypt from "bcrypt";
import * as argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { AppError, ValidationError } from "./errors.js";
import { logger } from "./logger.js";

const MAX_PASSWORD_BYTES = 512;
const MAX_ACTIVE = 2;
const PARAMETERS = { type: argon2.argon2id, version: 19, memoryCost: 19_456, timeCost: 2, parallelism: 1, hashLength: 32 } as const;
const BCRYPT_ALPHABET = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
let active = 0;

/** No replacement, normalization or truncation at the UTF8 boundary. */
function validPassword(password: string): boolean {
  if (typeof password !== "string" || password.length > MAX_PASSWORD_BYTES) return false;
  for (let i = 0; i < password.length; i++) {
    const c = password.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = password.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return Buffer.byteLength(password, "utf8") <= MAX_PASSWORD_BYTES;
}

function canonicalBase64(value: string, bytes: number): boolean {
  const decoded = Buffer.from(value, "base64");
  return decoded.length === bytes && decoded.toString("base64").replace(/=+$/, "") === value;
}

/** Costs and decoded lengths are fixed BEFORE native verification reads the PHC. */
function ownArgon2Hash(hash: string): boolean {
  const match = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/.exec(hash);
  return !!match && match[0] === hash && canonicalBase64(match[1]!, 16) && canonicalBase64(match[2]!, 32);
}

function legacyHash(hash: string): boolean {
  const match = /^\$2[ab]\$(0[4-9]|1[0-2])\$([./A-Za-z0-9]{22})([./A-Za-z0-9]{31})$/.exec(hash);
  return !!match && match[0] === hash &&
    BCRYPT_ALPHABET.indexOf(match[2]!.at(-1)!) % 16 === 0 &&
    BCRYPT_ALPHABET.indexOf(match[3]!.at(-1)!) % 4 === 0;
}

function unavailable() {
  return new AppError(503, "Service Unavailable", "Password checks are temporarily unavailable. Try again.");
}

/** No waiting native-job queue; keep the permit until the actual job settles. */
async function admitted<T>(operation: "argon2_hash" | "argon2_verify" | "bcrypt_verify", work: () => Promise<T>): Promise<T> {
  if (active >= MAX_ACTIVE) throw unavailable();
  active++;
  try { return await work(); }
  catch {
    // Native error text can contain inputs; keep the diagnostic fixed and local.
    logger.error({ event: "password_native_work_failed", operation }, "Password operation failed");
    throw unavailable();
  }
  finally { active--; }
}

export async function hashPassword(password: string): Promise<string> {
  if (!validPassword(password)) throw new ValidationError("Password cannot be encoded within the supported limit");
  return admitted("argon2_hash", async () => {
    const hash = await argon2.hash(Buffer.from(password, "utf8"), { ...PARAMETERS, salt: randomBytes(16) });
    if (!ownArgon2Hash(hash)) throw new Error("Unexpected password hash format");
    return hash;
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!validPassword(password) || typeof hash !== "string" || hash.length > 128) return false;
  if (ownArgon2Hash(hash))
    return admitted("argon2_verify", () => argon2.verify(hash, Buffer.from(password, "utf8")));
  // bcrypt cannot distinguish suffixes after72 bytes. Long legacy inputs need
  // the existing reset route; no login rewrite can recover their lost bytes.
  if (Buffer.byteLength(password, "utf8") <= 72 && legacyHash(hash))
    return admitted("bcrypt_verify", () => bcrypt.compare(password, hash));
  return false;
}
