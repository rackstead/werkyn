-- CreateTable
CREATE TABLE "RefreshTokenFamily" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "RefreshTokenFamily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RefreshTokenFamily_userId_idx" ON "RefreshTokenFamily"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshTokenFamily_id_userId_key" ON "RefreshTokenFamily"("id", "userId");

-- Backfill one family per existing family of active tokens, owned by the user
-- of its earliest token. Rotated-token records keep their familyId; a record
-- whose family has no active token has nothing left to mint or revoke.
INSERT INTO "RefreshTokenFamily" ("id", "userId", "createdAt")
SELECT DISTINCT ON ("familyId") "familyId", "userId", "createdAt"
FROM "RefreshToken"
ORDER BY "familyId", "createdAt", "id";

-- The application never mixes users in one family. A token that disagrees with
-- its family's owner cannot be attributed to one session and is not trusted.
DELETE FROM "RefreshToken" AS t
USING "RefreshTokenFamily" AS f
WHERE f."id" = t."familyId" AND f."userId" <> t."userId";

-- AddForeignKey
ALTER TABLE "RefreshTokenFamily" ADD CONSTRAINT "RefreshTokenFamily_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_familyId_userId_fkey" FOREIGN KEY ("familyId", "userId") REFERENCES "RefreshTokenFamily"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
