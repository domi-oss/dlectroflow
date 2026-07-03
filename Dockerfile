# syntax=docker/dockerfile:1
# dlectroflow container. Single-user demo uses SQLite on a mounted volume;
# for production scale, point DATABASE_URL at Postgres (see README → Deploy).

# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
# Prisma engines need OpenSSL
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:22-slim AS runner
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# SQLite lives on a persistent volume; override for Postgres in production.
ENV DATABASE_URL="file:/data/dlectroflow.db"
COPY --from=build /app ./
VOLUME ["/data"]
EXPOSE 3000
# Apply migrations, then start. ANTHROPIC_API_KEY must be passed at runtime.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start -- -p 3000"]
