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
#
# CI does NOT use this file — it builds the compiled output in build_app and
# assembles the image with Dockerfile.ci. Keep the runtime stage below in
# lock-step with Dockerfile.ci; src/lib/dockerfile-hygiene.test.ts guards both
# against the regressions that produced the 893 MB image (#71).

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

# ── Cluster-invoked CLIs: prisma + tsx (+ dotenv for prisma.config.ts) ───────
# The migrate initContainer runs `npx prisma migrate deploy`, the review-only
# seed runs `npx tsx prisma/seed.ts`, and the purge CronJob runs
# `npx tsx prisma/scheduled-purge.ts` — all from THIS image with /app as the
# working directory, so those binaries must resolve from /app/node_modules.
#
# They are installed into an ISOLATED prefix and grafted in afterwards. Run in
# /app, `npm install` treats the standalone output's package.json as the project
# manifest and reinstalls the app's ENTIRE dependency tree on top of the minimal
# traced node_modules (+392 packages: next, typescript, playwright, @next/swc,
# …). That, plus npm's 885 MB tarball cache, was the bulk of the 893 MB image
# whose cold pull timed out Autopilot deploys (#71).
#
# One RUN, so the npm cache never survives into a layer; first in the stage, so
# it stays a cache hit on every app-only change. Versions are pinned to
# package-lock.json (guarded by src/lib/dockerfile-hygiene.test.ts) so the
# container never runs migrations on a different Prisma than the app was built
# against.
RUN mkdir -p /opt/tools \
  && printf '{"name":"dlectroflow-image-tools","private":true}\n' > /opt/tools/package.json \
  && cd /opt/tools \
  && npm install --no-audit --no-fund --cache /tmp/npm-cache \
       prisma@6.19.3 dotenv@16.6.1 tsx@4.23.1 \
  && mkdir -p /app/node_modules \
  && cp -a /opt/tools/node_modules/. /app/node_modules/ \
  && rm -rf /opt/tools /tmp/npm-cache /root/.npm \
  && chown -R node:node /app

# Schema + migrations for the migrate initContainer, then the rarely-changing
# assets, then the per-commit build output: cheapest layer churn for node-level
# image caches.
#
# COPY --chown replaces the trailing `RUN chown -R node:node /app` this stage
# used to end with: chown rewrites every file it touches, so that single line
# wrote a second full copy of /app into its own layer (+854 MB) (#71).
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --chown=node:node --from=build /app/public ./public

# Standalone server (server.js at /app, minimal traced node_modules). Copied
# after the tooling so the app's traced dependencies win any name collision.
COPY --chown=node:node --from=build /app/.next/standalone ./
COPY --chown=node:node --from=build /app/.next/static ./.next/static

# Run as the non-root `node` user (uid 1000, present in node images).
USER node

EXPOSE 3000
CMD ["node", "server.js"]
