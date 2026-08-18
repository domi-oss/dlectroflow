# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
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
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runner
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
#
# ⚠️ The manifest below carries its own `overrides`, and it MUST: because this
# prefix is isolated, npm reads THIS package.json as the project root, so the
# `overrides` in the repo's package.json do not apply here. Anything that has to
# be forced in the shipped image has to be forced twice — once for the repo (CI,
# local dev, and what the dependency scanner reads out of package-lock.json) and
# once here, for the copy that is actually grafted into /app/node_modules and
# runs in the cluster. `deepmerge-ts` is forced for CVE-2026-40345 (HIGH, stack
# exhaustion on recursive object graphs): `prisma` pulls `@prisma/config`, which
# depends on `deepmerge-ts` at an exact version, so no range bump reaches it, and
# naming the package on the install line below does not either — that leaves the
# forced copy hoisted with a nested @prisma/config/node_modules copy still on the
# vulnerable version, and the nested one is what @prisma/config loads. Only an
# override collapses it to a single copy.
#
# ⚠️ Pinned EXACTLY here, unlike the repo's own override, which is a range. That
# asymmetry is deliberate: there is no lockfile behind THIS manifest, so every
# image build re-resolves it and a range would silently graft a newer release
# than the one CI resolved and ran migrations against, with no MR behind it. The
# repo side stays a range because package-lock.json holds it still. The version
# must equal what the lockfile resolved — src/lib/dockerfile-hygiene.test.ts
# reads it from there rather than hard-coding one, so a bump reds until this line
# follows, exactly as it does for the pins on the install line below.
#
# This is the load-bearing half of that fix. Fixing only the repo's package.json
# turns the dependency scan green while the running image still carries the
# vulnerable copy, because the scanner reads the lockfile and the pod gets this
# install. Do not "simplify" the overrides block out, and do not relax the pin to
# a range; dockerfile-hygiene fails on either.
RUN mkdir -p /opt/tools \
  && printf '{"name":"dlectroflow-image-tools","private":true,"overrides":{"deepmerge-ts":"8.0.1"}}\n' > /opt/tools/package.json \
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

# ── Which commit this image is (#135) ────────────────────────────────────────
# /api/health reports the short form, so Instance A (Helm on Kubernetes) and
# Instance B (this Compose stack) can be ASSERTED to be on the same commit
# instead of assumed to be. It has to be baked in here: a running container
# cannot read the registry tag it was pulled under.
#
#   docker build -f docker/Dockerfile --build-arg BUILD_SHA=$(git rev-parse HEAD) \
#     -t dlectroflow:local .
#
# Optional — the default leaves the value empty and /api/health answers
# `"sha": null`, so a build without it still works. ENV, not just ARG: an ARG is
# build-time only and never reaches the process. LAST in the stage on purpose —
# the value changes every commit, so anything below it rebuilds on every build,
# and below it there is only metadata. src/lib/dockerfile-hygiene.test.ts asserts
# both Dockerfiles carry this pair, since one missing it silently makes the
# comparison impossible.
ARG BUILD_SHA=""
ENV BUILD_SHA=$BUILD_SHA

# Run as the non-root `node` user (uid 1000, present in node images).
USER node

EXPOSE 3000
CMD ["node", "server.js"]
