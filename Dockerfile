# syntax=docker/dockerfile:1
# dlectroflow production image: standalone Next.js server + Prisma CLI/engines
# so the same image runs the app (node server.js) and migrations
# (npx prisma migrate deploy) from the Kubernetes migrate initContainer.
#
# Security hardening (AppSec review 2026-07):
#   - Runtime stage installs ONLY openssl (required by Prisma query engine).
#     This eliminates the ImageMagick + media-processing dependency tree that
#     was responsible for 140+ container CVEs on the previous image.
#   - Non-root user (node, uid 1000) is preserved.
#   - The migrate stage retains the full node:22-slim toolchain so npx/prisma
#     remain available for the Kubernetes init container.

# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build

# ---- migrate (init container) ----
# Kept on node:22-slim so npx + prisma CLI are available.
# This stage is used by the Kubernetes migrate initContainer only.
FROM node:22-slim AS migrate
WORKDIR /app
# openssl is required by the Prisma query engine binary.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
RUN chown -R node:node /app
USER node

# ---- runtime ----
# Minimal layer: only openssl added on top of node:22-slim.
# No apt packages that pull in ImageMagick, binutils, HDF5, or other
# media-processing libraries — those were the source of 140+ CVEs.
FROM node:22-slim AS runner
WORKDIR /app
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone server (server.js at /app, minimal traced node_modules)
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Run as the non-root `node` user (uid 1000, present in node images).
RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "server.js"]
