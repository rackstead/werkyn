-- Stop all older application/worker instances before applying this migration.
-- Raw links already sent to users remain valid: hash each existing bearer
-- exactly once, including used/expired rows. No raw-token fallback is kept.
-- PostgreSQL's built-in SHA-256 uses the same UTF-8 bytes as utils/tokens.ts hashToken.
BEGIN;

ALTER TABLE "PasswordResetToken" ADD COLUMN "tokenHash" TEXT;
ALTER TABLE "EmailVerificationToken" ADD COLUMN "tokenHash" TEXT;

UPDATE "PasswordResetToken"
SET "tokenHash" = encode(sha256(convert_to("token", 'UTF8')), 'hex');
UPDATE "EmailVerificationToken"
SET "tokenHash" = encode(sha256(convert_to("token", 'UTF8')), 'hex');

ALTER TABLE "PasswordResetToken" ALTER COLUMN "tokenHash" SET NOT NULL;
ALTER TABLE "EmailVerificationToken" ALTER COLUMN "tokenHash" SET NOT NULL;
-- Dropping the old columns also drops their indexes. Build fresh unique
-- indexes after backfill so a legacy raw token equal to another token's
-- digest cannot cause a transient uniqueness conflict during an in-place UPDATE.
ALTER TABLE "PasswordResetToken" DROP COLUMN "token";
ALTER TABLE "EmailVerificationToken" DROP COLUMN "token";

CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_tokenHash_idx" ON "PasswordResetToken"("tokenHash");
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");
CREATE INDEX "EmailVerificationToken_tokenHash_idx" ON "EmailVerificationToken"("tokenHash");

COMMIT;
