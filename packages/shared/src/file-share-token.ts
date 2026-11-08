/**
 * Drive share links issued before 256-bit tokens.
 * `randomBytes(6).toString("base64url")` is always 8 characters.
 * A current token is 43 characters and must not be treated as retired.
 */
export function isLegacyFileShareToken(token: unknown): boolean {
  return typeof token === "string" && token.length === 8;
}
