# Base images are pinned by digest so a rebuild starts from the same bytes.
# To update one, change the tag and its digest together, for example from
# `docker buildx imagetools inspect node:20-alpine`.

# ── Stage 0: Dex binary source ───────────────────────────────────
FROM ghcr.io/dexidp/dex:v2.41.1-alpine@sha256:bc7cfce7c17f52864e2bb2a4dc1d2f86a41e3019f6d42e81d92a301fad0c8a1d AS dex-source

# ── Stage 1: base ────────────────────────────────────────────────
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS base
RUN apk add --no-cache libc6-compat openssl
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app

# ── Stage 2: deps ────────────────────────────────────────────────
FROM base AS deps
# Copy package manifests and lockfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
# Copy tsconfig files needed for build
COPY tsconfig.base.json ./
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/backend/tsconfig.json packages/backend/
COPY packages/frontend/tsconfig.json packages/frontend/
# Copy Prisma schema (needed for postinstall generate)
COPY packages/backend/prisma packages/backend/prisma/
# Install all dependencies (including devDependencies for building)
RUN pnpm install --frozen-lockfile

# ── Stage 3: build ───────────────────────────────────────────────
FROM deps AS build
# Copy all source code
COPY packages/shared/src packages/shared/src/
COPY packages/backend/src packages/backend/src/
COPY packages/frontend/ packages/frontend/
# Build: shared → backend → frontend
RUN pnpm build

# ── Stage 4: production ─────────────────────────────────────────
FROM base AS production
ENV NODE_ENV=production
# The Prisma CLI runs migrations at every start; it must not check for
# updates over the network.
ENV CHECKPOINT_DISABLE=1

# The server, its migrations and Dex run as this unprivileged user. su-exec
# lets docker-entrypoint.sh drop root privileges when the container is started
# as root to hand over data left by older images, which ran as root.
RUN apk add --no-cache su-exec \
    && addgroup -S -g 10001 werkyn \
    && adduser -S -D -u 10001 -G werkyn -h /home/werkyn -s /sbin/nologin werkyn

# Copy package manifests and lockfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/

# Copy Prisma schema and migrations (needed for generate + migrate deploy)
COPY packages/backend/prisma packages/backend/prisma/

# Install production dependencies. @prisma/client brings the Prisma CLI that
# the lockfile pins, so no other copy is installed. Scripts wait until that CLI
# is on PATH, because the backend's postinstall runs `prisma generate`.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Put that CLI on PATH, failing the build unless it is the locked version
COPY docker/link-locked-prisma-cli.mjs /tmp/link-locked-prisma-cli.mjs
RUN node /tmp/link-locked-prisma-cli.mjs && rm /tmp/link-locked-prisma-cli.mjs

# Now run the install scripts: native addons like bcrypt and sharp, the Prisma
# engines, and the backend's postinstall, which generates the Prisma client for
# linux-musl (Alpine) with the linked CLI
RUN pnpm --recursive rebuild

# Copy built artifacts from build stage
COPY --from=build /app/packages/shared/dist packages/shared/dist/
COPY --from=build /app/packages/backend/dist packages/backend/dist/
COPY --from=build /app/packages/frontend/dist packages/frontend/dist/

# Copy Dex binary from dex-source stage
COPY --from=dex-source /usr/local/bin/dex /usr/local/bin/dex
RUN chmod 0755 /usr/local/bin/dex

# The application stays owned by root and read-only to werkyn. Only the storage
# and Dex directories (the Compose volumes) belong to werkyn; Docker copies this
# ownership into a new named volume. The legacy uploads path is only read.
RUN install -d -o werkyn -g werkyn -m 0755 /app/storage /app/storage/avatars /app/data \
    && install -d -o werkyn -g werkyn -m 0700 /app/data/dex \
    && mkdir -p /app/packages/backend/uploads

# Copy and set up entrypoint
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 0755 /app/docker-entrypoint.sh

# Numeric, so platforms that require a non-root user can verify it
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
