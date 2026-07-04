# syntax=docker/dockerfile:1
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
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:22-slim AS runner
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
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
