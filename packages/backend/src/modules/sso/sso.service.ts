import type { PrismaClient, Prisma } from "@prisma/client";
import {
  ConnectorConfigByType,
  type SsoConnectorType,
  type UpdateSsoConfigInput,
  type CreateSsoConnectorInput,
  type UpdateSsoConnectorInput,
} from "@pm/shared";
import { validationDetails } from "../../utils/validation-details.js";
import { ValidationError, NotFoundError } from "../../utils/errors.js";

const SECRET_FIELDS = ["clientSecret", "bindPW"];

function maskSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...config };
  for (const key of SECRET_FIELDS) {
    if (typeof masked[key] === "string" && (masked[key] as string).length > 0) {
      masked[key] = "••••••••";
    }
  }
  return masked;
}

export async function getSsoConfig(prisma: PrismaClient) {
  let config = await prisma.ssoConfig.findUnique({
    where: { id: "singleton" },
  });

  if (!config) {
    config = await prisma.ssoConfig.create({
      data: { id: "singleton" },
    });
  }

  return config;
}

export async function updateSsoConfig(
  prisma: PrismaClient,
  data: UpdateSsoConfigInput,
) {
  return prisma.ssoConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...data },
    update: data,
  });
}

export async function getConnectors(prisma: PrismaClient) {
  const connectors = await prisma.ssoConnector.findMany({
    where: { ssoConfigId: "singleton" },
    orderBy: { position: "asc" },
  });

  return connectors.map((c) => ({
    ...c,
    config: maskSecrets(c.config as Record<string, unknown>),
  }));
}

export async function createConnector(
  prisma: PrismaClient,
  data: CreateSsoConnectorInput,
) {
  // Validate connector-specific config
  const schema = ConnectorConfigByType[data.type as SsoConnectorType];
  if (schema) {
    const result = schema.safeParse(data.config);
    if (!result.success) {
      throw new ValidationError(
        "Invalid connector configuration",
        validationDetails(result.error.issues),
      );
    }
  }

  // Ensure SsoConfig exists
  await prisma.ssoConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton" },
    update: {},
  });

  const connector = await prisma.ssoConnector.create({
    data: {
      ssoConfigId: "singleton",
      connectorId: data.connectorId,
      name: data.name,
      type: data.type,
      config: data.config as Prisma.InputJsonValue,
      enabled: data.enabled ?? true,
      position: data.position ?? 0,
    },
  });

  return {
    ...connector,
    config: maskSecrets(connector.config as Record<string, unknown>),
  };
}

export async function updateConnector(
  prisma: PrismaClient,
  connectorId: string,
  data: UpdateSsoConnectorInput,
) {
  const existing = await prisma.ssoConnector.findUnique({
    where: { connectorId },
  });

  if (!existing) {
    throw new NotFoundError("Connector not found");
  }

  // If config is being updated, merge with existing config (preserve secrets that aren't being changed)
  let finalConfig = existing.config as Record<string, unknown>;
  if (data.config) {
    const mergedConfig = { ...finalConfig, ...data.config };
    // Restore masked secrets from existing config
    for (const key of SECRET_FIELDS) {
      if (mergedConfig[key] === "••••••••") {
        mergedConfig[key] = finalConfig[key];
      }
    }
    finalConfig = mergedConfig;

    // Validate merged config
    const schema =
      ConnectorConfigByType[existing.type as SsoConnectorType];
    if (schema) {
      const result = schema.safeParse(finalConfig);
      if (!result.success) {
        throw new ValidationError(
          "Invalid connector configuration",
          validationDetails(result.error.issues),
        );
      }
    }
  }

  const connector = await prisma.ssoConnector.update({
    where: { connectorId },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.config !== undefined && { config: finalConfig as Prisma.InputJsonValue }),
      ...(data.enabled !== undefined && { enabled: data.enabled }),
      ...(data.position !== undefined && { position: data.position }),
    },
  });

  return {
    ...connector,
    config: maskSecrets(connector.config as Record<string, unknown>),
  };
}

export async function deleteConnector(
  prisma: PrismaClient,
  connectorId: string,
) {
  const existing = await prisma.ssoConnector.findUnique({
    where: { connectorId },
  });

  if (!existing) {
    throw new NotFoundError("Connector not found");
  }

  await prisma.ssoConnector.delete({ where: { connectorId } });
}
