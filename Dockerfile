# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
# dlectroflow production image: standalone Next.js server + Prisma CLI/engines
# so the same image runs the app (node server.js) and migrations
# (npx prisma migrate deploy) from the Kubernetes migrate initContainer.
#
# Hardening notes:
#   - Runtime installs only openssl (required by the Prisma query engine),
#     with --no-install-recommends to avoid pulling in unnecessary packages.
#   - Non-root user (node, uid 1000) is preserved.
#   - Prisma CLI + schema stay in the final image because the migrate
#     initContainer reuses this same image to run `prisma migrate deploy`.

# ---- build ----
# alpine (musl) to match the runtime + the CI Dockerfile.ci image, so native
# binaries (Prisma engine) are built for the right libc.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runner
WORKDIR /app
RUN apk upgrade --no-cache && apk add --no-cache openssl
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone server (server.js at /app, minimal traced node_modules)
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Prisma CLI + engines + migrations for the migrate initContainer (same image).
# --no-save installs alongside the traced node_modules without touching lockfiles.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
RUN npm install --no-save prisma@6.19.3 dotenv@16.4.7

# Run as the non-root `node` user (uid 1000, present in node images).
RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "server.js"]
