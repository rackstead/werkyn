import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { UnauthorizedError } from "./errors.js";
import type { AccessClaims } from "./authenticated-user.js";

const ISSUER = "werkyn:file-preview:v1";
const AUDIENCE = "werkyn:file-preview";
const PURPOSE = "file-preview";
const MAX_AGE_SECONDS = 5 * 60;
// A preview grant can never verify with the ordinary HTTP/WebSocket JWT key.
const signingKey = crypto
  .createHmac("sha256", env.JWT_SECRET)
  .update(ISSUER)
  .digest();
interface PreviewClaims extends AccessClaims {
  wid: string;
  fid: string;
  iat: number;
  authExp: number;
}
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value !== "";
const seconds = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

export function signFilePreviewGrant(
  claims: AccessClaims,
  wid: string,
  fid: string,
) {
  const iat = Math.floor(Date.now() / 1000);
  const authExp = Math.floor(claims.exp);
  if (!seconds(authExp) || authExp <= iat)
    throw new UnauthorizedError("Invalid or expired token");
  const exp = Math.min(authExp, iat + MAX_AGE_SECONDS);
  const token = jwt.sign(
    { ...claims, wid, fid, purpose: PURPOSE, iat, exp, authExp },
    signingKey,
    {
      algorithm: "HS256",
      issuer: ISSUER,
      audience: AUDIENCE,
    },
  );
  return { token, expiresAt: exp * 1000, sourceExpiresAt: authExp * 1000 };
}

export function verifyFilePreviewGrant(
  token: string,
  wid: string,
  fid: string,
): PreviewClaims {
  const claims = jwt.verify(token, signingKey, {
    algorithms: ["HS256"],
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  const now = Math.floor(Date.now() / 1000);
  if (
    typeof claims !== "object" ||
    claims === null ||
    Array.isArray(claims) ||
    claims.iss !== ISSUER ||
    claims.aud !== AUDIENCE ||
    claims.purpose !== PURPOSE ||
    !nonempty(claims.sub) ||
    !nonempty(claims.wid) ||
    !nonempty(claims.fid) ||
    claims.wid !== wid ||
    claims.fid !== fid ||
    !seconds(claims.iat) ||
    !seconds(claims.exp) ||
    !seconds(claims.authExp) ||
    claims.iat > now ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > MAX_AGE_SECONDS ||
    claims.exp > claims.authExp ||
    (Object.hasOwn(claims, "sid") && !nonempty(claims.sid))
  )
    throw new UnauthorizedError("Invalid or expired preview grant");
  return {
    sub: claims.sub,
    wid: claims.wid,
    fid: claims.fid,
    iat: claims.iat,
    exp: claims.exp,
    authExp: claims.authExp,
    ...(claims.sid === undefined ? {} : { sid: claims.sid }),
  };
}
