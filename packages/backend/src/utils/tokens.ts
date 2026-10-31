import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { env } from "../config/env.js";

interface AccessTokenPayload {
  sub: string;
  email: string;
  // The refresh-token family (sign-in session) the token was issued for.
  // HTTP checks it on use; realtime sockets end when it is revoked.
  sid: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "15m" });
}

/**
 * Verifies signature and expiry. `sid` is absent on tokens issued before
 * access tokens named their session; HTTP still accepts those until they
 * expire, realtime does not (see realtime.service authenticate).
 */
export function verifyAccessToken(
  token: string,
): Omit<AccessTokenPayload, "sid"> & { sid?: unknown; iat: number; exp: number } {
  return jwt.verify(token, env.JWT_SECRET) as Omit<AccessTokenPayload, "sid"> & {
    sid?: unknown;
    iat: number;
    exp: number;
  };
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function generateSecureToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
