-- CreateTable
CREATE TABLE "RegistrationConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "privacyPreserving" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistrationConfig_pkey" PRIMARY KEY ("id")
);

-- Default off: hosts without email delivery keep immediate sign-in.
INSERT INTO "RegistrationConfig" ("id", "privacyPreserving", "createdAt", "updatedAt")
VALUES ('singleton', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
