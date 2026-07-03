# dlectroflow Live Deployment (GitLab CI + GKE Autopilot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take dlectroflow from a local SQLite app to a live GitLab-CI/CD deployment on GKE Autopilot, with per-MR review apps and a stable production environment at https://dlectroflow.dlectronique.dev.

**Architecture:** One GKE Autopilot cluster reached through the GitLab agent (`agentk`). A single Helm chart renders each environment into its own namespace (app + in-namespace Postgres + Secret). CI builds one image per commit (kaniko → GitLab Container Registry) and deploys it: review apps on MR events (sslip.io hosts, ephemeral Postgres, Spot), production on `main` (real host, persistent Postgres). Secrets come from GitLab Secrets Manager; TLS from cert-manager (Let's Encrypt HTTP-01).

**Tech Stack:** Next.js 16.2 (standalone output), Prisma 6 + PostgreSQL 16, Docker/kaniko, Helm 3, Kubernetes (GKE Autopilot), ingress-nginx, cert-manager, GitLab CI/CD + agent + Secrets Manager.

**Spec:** `docs/superpowers/specs/2026-07-03-dlectroflow-k8s-deployment-design.md`

## Global Constraints

- **Next.js 16.2** — past training cutoff; read `node_modules/next/dist/docs/` before changing Next config/behavior.
- **Prisma 6** pinned (NOT 7). SQLite→Postgres is a provider swap only; keep `String` columns (no enums) — do NOT touch `src/lib/constants.ts` or app code.
- **No secrets in the repo.** App reads `process.env`. Secrets live in GitLab Secrets Manager; injected at deploy time.
- **Region:** `europe-west2`. **Static ingress IP:** `35.246.93.255` (reserved as `dlectroflow-ingress`). **Prod host:** `dlectroflow.dlectronique.dev`. **Group:** `gl-demo-ultimate-dtop`. **Agent name:** `dlectroflow`. **Registry image:** `registry.gitlab.com/gl-demo-ultimate-dtop/dlectroflow`.
- **Resource requests (= limits on Autopilot):** app prod `500m`/`512Mi`; app review `250m`/`512Mi`; postgres prod `250m`/`512Mi` (PVC 8Gi); postgres review `250m`/`512Mi` (emptyDir). Review pods on Spot; production on-demand.
- **Commit trailer (every commit):**
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- **Prereqs for executing this plan locally:** Docker Desktop running; `helm` (`brew install helm`); `kubeconform` (`brew install kubeconform`). Cluster provisioning (Task 7 runbook) is user-run and not required to complete Tasks 1–6.

---

### Task 1: Prisma → PostgreSQL + local Docker Compose

**Files:**
- Create: `docker-compose.yml`
- Modify: `prisma/schema.prisma:10-13` (datasource provider)
- Delete + recreate: `prisma/migrations/*` (SQLite → Postgres history)
- Modify: `.env` (local `DATABASE_URL`), `.env.example`, `package.json` (`setup` script), `README.md` (run-locally steps)

**Interfaces:**
- Produces: a running local Postgres at `postgresql://dlectroflow:dlectroflow@localhost:5432/dlectroflow?schema=public`; a Postgres migration history under `prisma/migrations/` with `migration_lock.toml` provider `postgresql`. Consumed by every later task that runs the app or `prisma migrate deploy`.

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
services:
  db:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: dlectroflow
      POSTGRES_PASSWORD: dlectroflow
      POSTGRES_DB: dlectroflow
    ports:
      - "5432:5432"
    volumes:
      - dlectroflow_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dlectroflow"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  dlectroflow_pgdata:
```

- [ ] **Step 2: Switch the Prisma datasource to Postgres**

In `prisma/schema.prisma`, change the datasource block:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

- [ ] **Step 3: Point local `DATABASE_URL` at Postgres**

Set in `.env` (replace the old SQLite value):

```
DATABASE_URL="postgresql://dlectroflow:dlectroflow@localhost:5432/dlectroflow?schema=public"
```

- [ ] **Step 4: Start Postgres and regenerate the migration history**

```bash
export PATH="/opt/homebrew/bin:/usr/bin:/bin:$PATH"
docker compose up -d db
# wait for healthy
until docker compose exec -T db pg_isready -U dlectroflow; do sleep 1; done
rm -rf prisma/migrations
npx prisma migrate dev --name init
```

Expected: creates `prisma/migrations/<timestamp>_init/migration.sql` (Postgres DDL) and sets `prisma/migrations/migration_lock.toml` to `provider = "postgresql"`. Seeds the schema into local Postgres.

- [ ] **Step 5: Verify a clean deploy-style apply works**

```bash
npx prisma migrate reset --force   # drops, re-applies from migrations, no seed prompt
npx prisma migrate deploy
```

Expected: `All migrations have been successfully applied.` (no drift).

- [ ] **Step 6: Verify the app boots and works on Postgres**

```bash
npm run build && npm run dev
```
In another shell: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/dashboard` → `200`. Manually confirm the dashboard renders and a brain-dump capture saves. Stop dev.

- [ ] **Step 7: Update `.env.example`, `package.json` setup script, README**

In `.env.example`, replace the DATABASE_URL block with:

```
# Database connection string (PostgreSQL).
#   Local dev:  start Postgres with `docker compose up -d db`, then use:
DATABASE_URL="postgresql://dlectroflow:dlectroflow@localhost:5432/dlectroflow?schema=public"
#   Production: injected from GitLab Secrets Manager (see docs/deploy-runbook.md)
```

In `package.json`, change the `setup` script to:

```json
"setup": "docker compose up -d db && npm install && prisma migrate dev"
```

In `README.md`, update the "run locally" steps to: `docker compose up -d db` → `npm install` → `npm run db:migrate` → `npm run dev`.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml prisma/schema.prisma prisma/migrations .env.example package.json README.md
git commit -m "$(cat <<'EOF'
Step 10: switch Prisma to PostgreSQL + local Docker Compose

Postgres everywhere (dev/prod parity). Regenerated migration history for
postgresql; local dev runs Postgres via docker-compose. No app/enum changes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Health endpoint for Kubernetes probes

**Files:**
- Create: `src/app/api/health/route.ts`

**Interfaces:**
- Produces: `GET /api/health` → `200 {"status":"ok"}` when the DB is reachable, `503 {"status":"error"}` otherwise. Consumed by the Helm Deployment's liveness/readiness probes (Task 4).

- [ ] **Step 1: Create the health route**

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Node runtime + always dynamic: this must actually hit the DB each call.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
```

- [ ] **Step 2: Verify OK path**

With `docker compose up -d db` running and `npm run dev`:

```bash
curl -s -w " [%{http_code}]\n" http://localhost:3000/api/health
```
Expected: `{"status":"ok"} [200]`

- [ ] **Step 3: Verify failure path**

```bash
docker compose stop db
curl -s -w " [%{http_code}]\n" http://localhost:3000/api/health
docker compose start db
```
Expected: `{"status":"error"} [503]` while the DB is down.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/health/route.ts
git commit -m "$(cat <<'EOF'
Step 10: add /api/health for Kubernetes liveness/readiness probes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Standalone container image

**Files:**
- Modify: `next.config.ts`
- Modify: `Dockerfile` (full rewrite)

**Interfaces:**
- Produces: a container image that (a) runs the app via `node server.js` on port 3000, and (b) can run `npx prisma migrate deploy` (Prisma CLI + engines + `prisma/migrations` present). Consumed by the Helm Deployment app container + `migrate` initContainer (Task 4), and built/pushed by CI (Task 6).

- [ ] **Step 1: Enable standalone output**

`next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
```

- [ ] **Step 2: Rewrite the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1
# dlectroflow production image: standalone Next.js server + Prisma CLI/engines
# so the same image runs the app (node server.js) and migrations
# (npx prisma migrate deploy) from the Kubernetes migrate initContainer.

# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
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
RUN npm install --no-save prisma@6.19.3 dotenv

EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 3: Build the image**

```bash
docker build -t dlectroflow:test .
```
Expected: builds successfully.

- [ ] **Step 4: Verify migrations run from the image**

With `docker compose up -d db` running:

```bash
docker run --rm \
  -e DATABASE_URL="postgresql://dlectroflow:dlectroflow@host.docker.internal:5432/dlectroflow?schema=public" \
  dlectroflow:test npx prisma migrate deploy
```
Expected: `No pending migrations to apply.` (Task 1 already applied them) — confirms the CLI + engines + migration files are present and reach the DB.

- [ ] **Step 5: Verify the app serves from the image**

```bash
docker run --rm -d --name dlectro-test -p 3001:3000 \
  -e DATABASE_URL="postgresql://dlectroflow:dlectroflow@host.docker.internal:5432/dlectroflow?schema=public" \
  dlectroflow:test
sleep 3
curl -s -w " [%{http_code}]\n" http://localhost:3001/api/health
docker rm -f dlectro-test
```
Expected: `{"status":"ok"} [200]`

- [ ] **Step 6: Commit**

```bash
git add next.config.ts Dockerfile
git commit -m "$(cat <<'EOF'
Step 10: standalone Next.js image with Prisma CLI for k8s migrations

Multi-stage: standalone server for the app; Prisma CLI + engines + migrations
included so the migrate initContainer reuses the same image.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Helm chart — app Deployment, Service, helpers, values

**Files:**
- Create: `charts/dlectroflow/Chart.yaml`
- Create: `charts/dlectroflow/values.yaml`
- Create: `charts/dlectroflow/templates/_helpers.tpl`
- Create: `charts/dlectroflow/templates/deployment.yaml`
- Create: `charts/dlectroflow/templates/service.yaml`

**Interfaces:**
- Consumes: the image from Task 3 (`node server.js`, `npx prisma migrate deploy`, `/api/health`).
- Produces: values keys used by all later chart templates + CI: `image.repository`, `image.tag`, `env` (`review|production`), `host`, `replicas`, `spot`, `resources.app.{cpu,memory}`, `resources.postgres.{cpu,memory}`, `postgres.{persistent,storageSize,image}`, `tls.clusterIssuer`, `registry.{server,username,password}`, `secrets.{postgresPassword,anthropicApiKey,googleClientId,googleClientSecret,resendApiKey,roundupFromEmail}`. Template helpers `dlectroflow.databaseUrl` and `dlectroflow.labels`. In-namespace service names: app `dlectroflow`, postgres `dlectroflow-postgres`. Secret name `dlectroflow-secrets`, pull secret `dlectroflow-registry`.

- [ ] **Step 1: `Chart.yaml`**

```yaml
apiVersion: v2
name: dlectroflow
description: dlectroflow — ADHD helper app (review + production)
type: application
version: 0.1.0
appVersion: "1.0.0"
```

- [ ] **Step 2: `values.yaml`**

```yaml
image:
  repository: registry.gitlab.com/gl-demo-ultimate-dtop/dlectroflow
  tag: latest
  pullPolicy: IfNotPresent

env: production        # review | production
host: dlectroflow.dlectronique.dev
replicas: 1
spot: false            # true for review apps

resources:
  app:
    cpu: 500m
    memory: 512Mi
  postgres:
    cpu: 250m
    memory: 512Mi

postgres:
  persistent: true     # false for review (emptyDir)
  storageSize: 8Gi
  image: postgres:16

tls:
  clusterIssuer: letsencrypt-prod

# Rendered into a dockerconfigjson pull secret (private GitLab registry).
registry:
  server: registry.gitlab.com
  username: ""
  password: ""

# Injected by CI from GitLab Secrets Manager; never committed.
secrets:
  postgresPassword: ""
  anthropicApiKey: ""
  googleClientId: ""
  googleClientSecret: ""
  resendApiKey: ""
  roundupFromEmail: ""
```

- [ ] **Step 3: `templates/_helpers.tpl`**

```
{{- define "dlectroflow.labels" -}}
app.kubernetes.io/name: dlectroflow
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
dlectroflow/env: {{ .Values.env }}
{{- end -}}

{{- define "dlectroflow.databaseUrl" -}}
postgresql://dlectroflow:{{ .Values.secrets.postgresPassword }}@dlectroflow-postgres:5432/dlectroflow?schema=public
{{- end -}}
```

- [ ] **Step 4: `templates/deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dlectroflow
  labels:
    {{- include "dlectroflow.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicas }}
  selector:
    matchLabels:
      app.kubernetes.io/name: dlectroflow
  template:
    metadata:
      labels:
        {{- include "dlectroflow.labels" . | nindent 8 }}
    spec:
      {{- if .Values.spot }}
      nodeSelector:
        cloud.google.com/gke-spot: "true"
      {{- end }}
      imagePullSecrets:
        - name: dlectroflow-registry
      initContainers:
        - name: wait-for-db
          image: {{ .Values.postgres.image }}
          command:
            - sh
            - -c
            - until pg_isready -h dlectroflow-postgres -U dlectroflow; do echo waiting for db; sleep 2; done
        - name: migrate
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          command: ["npx", "prisma", "migrate", "deploy"]
          envFrom:
            - secretRef:
                name: dlectroflow-secrets
      containers:
        - name: app
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - containerPort: 3000
          envFrom:
            - secretRef:
                name: dlectroflow-secrets
          readinessProbe:
            httpGet: { path: /api/health, port: 3000 }
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /api/health, port: 3000 }
            initialDelaySeconds: 15
            periodSeconds: 20
          resources:
            requests:
              cpu: {{ .Values.resources.app.cpu }}
              memory: {{ .Values.resources.app.memory }}
            limits:
              cpu: {{ .Values.resources.app.cpu }}
              memory: {{ .Values.resources.app.memory }}
```

- [ ] **Step 5: `templates/service.yaml`**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: dlectroflow
  labels:
    {{- include "dlectroflow.labels" . | nindent 4 }}
spec:
  selector:
    app.kubernetes.io/name: dlectroflow
  ports:
    - port: 80
      targetPort: 3000
```

- [ ] **Step 6: Lint + verify render (both envs)**

```bash
export PATH="/opt/homebrew/bin:/usr/bin:/bin:$PATH"
helm lint charts/dlectroflow
helm template t charts/dlectroflow \
  --set env=production --set image.tag=abc123 \
  --set secrets.postgresPassword=pw --set secrets.anthropicApiKey=k \
  --set registry.username=u --set registry.password=p | tee /tmp/prod.yaml | grep -q "initContainers" && echo OK-prod
helm template t charts/dlectroflow \
  --set env=review --set spot=true --set image.tag=abc123 \
  --set secrets.postgresPassword=pw --set secrets.anthropicApiKey=k \
  --set registry.username=u --set registry.password=p | grep -q "gke-spot" && echo OK-review-spot
```
Expected: `helm lint` passes (1 chart(s) linted, 0 failed); `OK-prod` and `OK-review-spot` print.

- [ ] **Step 7: Commit**

```bash
git add charts/dlectroflow/Chart.yaml charts/dlectroflow/values.yaml charts/dlectroflow/templates/_helpers.tpl charts/dlectroflow/templates/deployment.yaml charts/dlectroflow/templates/service.yaml
git commit -m "$(cat <<'EOF'
Step 10: Helm chart — app Deployment, Service, values, helpers

Deployment with wait-for-db + migrate initContainers, health probes, per-env
resources, Spot nodeSelector for review, private-registry pull secret.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Helm chart — Secret, pull secret, Postgres, Ingress, ResourceQuota

**Files:**
- Create: `charts/dlectroflow/templates/secret.yaml`
- Create: `charts/dlectroflow/templates/registry-secret.yaml`
- Create: `charts/dlectroflow/templates/postgres.yaml`
- Create: `charts/dlectroflow/templates/ingress.yaml`
- Create: `charts/dlectroflow/templates/resourcequota.yaml`

**Interfaces:**
- Consumes: values + helpers from Task 4.
- Produces: `Secret/dlectroflow-secrets` (app env incl. `DATABASE_URL`, `POSTGRES_PASSWORD`), `Secret/dlectroflow-registry` (dockerconfigjson), `StatefulSet + Service dlectroflow-postgres`, an Ingress for `.Values.host` with cert-manager TLS, and (review only) a ResourceQuota.

- [ ] **Step 1: `templates/secret.yaml`**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: dlectroflow-secrets
  labels:
    {{- include "dlectroflow.labels" . | nindent 4 }}
type: Opaque
stringData:
  DATABASE_URL: {{ include "dlectroflow.databaseUrl" . | quote }}
  POSTGRES_PASSWORD: {{ .Values.secrets.postgresPassword | quote }}
  ANTHROPIC_API_KEY: {{ .Values.secrets.anthropicApiKey | quote }}
  {{- if eq .Values.env "production" }}
  GOOGLE_CLIENT_ID: {{ .Values.secrets.googleClientId | quote }}
  GOOGLE_CLIENT_SECRET: {{ .Values.secrets.googleClientSecret | quote }}
  RESEND_API_KEY: {{ .Values.secrets.resendApiKey | quote }}
  ROUNDUP_FROM_EMAIL: {{ .Values.secrets.roundupFromEmail | quote }}
  {{- end }}
```

- [ ] **Step 2: `templates/registry-secret.yaml`**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: dlectroflow-registry
  labels:
    {{- include "dlectroflow.labels" . | nindent 4 }}
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: {{ printf "{\"auths\":{\"%s\":{\"username\":\"%s\",\"password\":\"%s\",\"auth\":\"%s\"}}}" .Values.registry.server .Values.registry.username .Values.registry.password (printf "%s:%s" .Values.registry.username .Values.registry.password | b64enc) | b64enc }}
```

- [ ] **Step 3: `templates/postgres.yaml`** (StatefulSet + Service; persistent PVC or ephemeral emptyDir)

```yaml
apiVersion: v1
kind: Service
metadata:
  name: dlectroflow-postgres
  labels:
    {{- include "dlectroflow.labels" . | nindent 4 }}
spec:
  clusterIP: None
  selector:
    app.kubernetes.io/name: dlectroflow-postgres
  ports:
    - port: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: dlectroflow-postgres
  labels:
    {{- include "dlectroflow.labels" . | nindent 4 }}
spec:
  serviceName: dlectroflow-postgres
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: dlectroflow-postgres
  template:
    metadata:
      labels:
        app.kubernetes.io/name: dlectroflow-postgres
        dlectroflow/env: {{ .Values.env }}
    spec:
      {{- if .Values.spot }}
      nodeSelector:
        cloud.google.com/gke-spot: "true"
      {{- end }}
      containers:
        - name: postgres
          image: {{ .Values.postgres.image }}
          env:
            - name: POSTGRES_USER
              value: dlectroflow
            - name: POSTGRES_DB
              value: dlectroflow
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: dlectroflow-secrets
                  key: POSTGRES_PASSWORD
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          ports:
            - containerPort: 5432
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "dlectroflow"]
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              cpu: {{ .Values.resources.postgres.cpu }}
              memory: {{ .Values.resources.postgres.memory }}
            limits:
              cpu: {{ .Values.resources.postgres.cpu }}
              memory: {{ .Values.resources.postgres.memory }}
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
      {{- if not .Values.postgres.persistent }}
      volumes:
        - name: data
          emptyDir: {}
      {{- end }}
  {{- if .Values.postgres.persistent }}
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: {{ .Values.postgres.storageSize }}
  {{- end }}
```

- [ ] **Step 4: `templates/ingress.yaml`**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: dlectroflow
  labels:
    {{- include "dlectroflow.labels" . | nindent 4 }}
  annotations:
    cert-manager.io/cluster-issuer: {{ .Values.tls.clusterIssuer }}
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - {{ .Values.host }}
      secretName: dlectroflow-tls
  rules:
    - host: {{ .Values.host }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: dlectroflow
                port:
                  number: 80
```

- [ ] **Step 5: `templates/resourcequota.yaml`** (review only)

```yaml
{{- if eq .Values.env "review" }}
apiVersion: v1
kind: ResourceQuota
metadata:
  name: dlectroflow-quota
  labels:
    {{- include "dlectroflow.labels" . | nindent 4 }}
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 3Gi
    limits.cpu: "2"
    limits.memory: 3Gi
    pods: "10"
{{- end }}
```

- [ ] **Step 6: Lint + render + schema-validate both envs**

```bash
export PATH="/opt/homebrew/bin:/usr/bin:/bin:$PATH"
helm lint charts/dlectroflow
COMMON="--set image.tag=abc123 --set secrets.postgresPassword=pw --set secrets.anthropicApiKey=k --set registry.username=u --set registry.password=p"
# production: persistent PVC present, no resourcequota
helm template t charts/dlectroflow --set env=production $COMMON | tee /tmp/prod.yaml \
  | grep -q "volumeClaimTemplates" && echo OK-prod-pvc
grep -q "ResourceQuota" /tmp/prod.yaml && echo "UNEXPECTED-quota-in-prod" || echo OK-no-quota-prod
# review: emptyDir + resourcequota + spot
helm template t charts/dlectroflow --set env=review --set spot=true --set postgres.persistent=false $COMMON | tee /tmp/review.yaml \
  | grep -q "emptyDir" && echo OK-review-emptydir
grep -q "ResourceQuota" /tmp/review.yaml && echo OK-review-quota
# structural validation
kubeconform -strict -ignore-missing-schemas /tmp/prod.yaml /tmp/review.yaml && echo OK-kubeconform
```
Expected: `helm lint` passes; `OK-prod-pvc`, `OK-no-quota-prod`, `OK-review-emptydir`, `OK-review-quota`, `OK-kubeconform` all print.

- [ ] **Step 7: Commit**

```bash
git add charts/dlectroflow/templates/secret.yaml charts/dlectroflow/templates/registry-secret.yaml charts/dlectroflow/templates/postgres.yaml charts/dlectroflow/templates/ingress.yaml charts/dlectroflow/templates/resourcequota.yaml
git commit -m "$(cat <<'EOF'
Step 10: Helm chart — Secret, registry pull secret, Postgres, Ingress, quota

Postgres StatefulSet (persistent PVC for prod / emptyDir for review), TLS
Ingress via cert-manager, per-review ResourceQuota.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: GitLab agent config + CI pipeline

**Files:**
- Create: `.gitlab/agents/dlectroflow/config.yaml`
- Create: `.gitlab-ci.yml`

**Interfaces:**
- Consumes: the Helm chart (Tasks 4–5), the image build, and Secrets Manager secrets (incl. new `GITLAB_DEPLOY_TOKEN` / `GITLAB_DEPLOY_TOKEN_USER`, see Task 7 runbook).
- Produces: pipeline jobs `build`, `deploy_review`, `stop_review`, `deploy_production`.

- [ ] **Step 1: Agent config `.gitlab/agents/dlectroflow/config.yaml`**

```yaml
ci_access:
  projects:
    - id: gl-demo-ultimate-dtop/dlectroflow
```

- [ ] **Step 2: `.gitlab-ci.yml`**

```yaml
stages:
  - build
  - deploy

variables:
  IMAGE: "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA"
  KUBE_CONTEXT: "gl-demo-ultimate-dtop/dlectroflow:dlectroflow"

build:
  stage: build
  image:
    name: gcr.io/kaniko-project/executor:v1.23.2-debug
    entrypoint: [""]
  script:
    - mkdir -p /kaniko/.docker
    - echo "{\"auths\":{\"$CI_REGISTRY\":{\"username\":\"$CI_REGISTRY_USER\",\"password\":\"$CI_REGISTRY_PASSWORD\"}}}" > /kaniko/.docker/config.json
    - /kaniko/executor --context "$CI_PROJECT_DIR" --dockerfile "$CI_PROJECT_DIR/Dockerfile" --destination "$IMAGE"
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_BRANCH == "main"'

.deploy_base:
  stage: deploy
  image:
    name: dtzar/helm-kubectl:3.16.1   # bundles helm + kubectl
    entrypoint: [""]
  before_script:
    - kubectl config use-context "$KUBE_CONTEXT"

deploy_review:
  extends: .deploy_base
  secrets:
    ANTHROPIC_API_KEY:
      gitlab_secrets_manager: { name: ANTHROPIC_API_KEY, source: group/gl-demo-ultimate-dtop }
      file: false
    POSTGRES_PASSWORD:
      gitlab_secrets_manager: { name: POSTGRES_PASSWORD, source: group/gl-demo-ultimate-dtop }
      file: false
    GITLAB_DEPLOY_TOKEN:
      gitlab_secrets_manager: { name: GITLAB_DEPLOY_TOKEN, source: group/gl-demo-ultimate-dtop }
      file: false
    GITLAB_DEPLOY_TOKEN_USER:
      gitlab_secrets_manager: { name: GITLAB_DEPLOY_TOKEN_USER, source: group/gl-demo-ultimate-dtop }
      file: false
  script:
    - helm upgrade --install "dlectroflow-mr-$CI_MERGE_REQUEST_IID" charts/dlectroflow
        --namespace "dlectroflow-mr-$CI_MERGE_REQUEST_IID" --create-namespace
        --set env=review --set spot=true --set postgres.persistent=false
        --set-string image.tag="$CI_COMMIT_SHA"
        --set-string host="mr-$CI_MERGE_REQUEST_IID.35.246.93.255.sslip.io"
        --set-string secrets.postgresPassword="$POSTGRES_PASSWORD"
        --set-string secrets.anthropicApiKey="$ANTHROPIC_API_KEY"
        --set-string registry.username="$GITLAB_DEPLOY_TOKEN_USER"
        --set-string registry.password="$GITLAB_DEPLOY_TOKEN"
        --set resources.app.cpu=250m
        --wait --timeout 5m
  environment:
    name: review/$CI_MERGE_REQUEST_IID
    url: https://mr-$CI_MERGE_REQUEST_IID.35.246.93.255.sslip.io
    on_stop: stop_review
    auto_stop_in: 2 days
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'

stop_review:
  extends: .deploy_base
  script:
    - helm uninstall "dlectroflow-mr-$CI_MERGE_REQUEST_IID" --namespace "dlectroflow-mr-$CI_MERGE_REQUEST_IID" || true
    - kubectl delete namespace "dlectroflow-mr-$CI_MERGE_REQUEST_IID" --ignore-not-found
  environment:
    name: review/$CI_MERGE_REQUEST_IID
    action: stop
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
      when: manual
  allow_failure: true

deploy_production:
  extends: .deploy_base
  secrets:
    ANTHROPIC_API_KEY:
      gitlab_secrets_manager: { name: ANTHROPIC_API_KEY, source: group/gl-demo-ultimate-dtop }
      file: false
    POSTGRES_PASSWORD:
      gitlab_secrets_manager: { name: POSTGRES_PASSWORD, source: group/gl-demo-ultimate-dtop }
      file: false
    GOOGLE_CLIENT_ID:
      gitlab_secrets_manager: { name: GOOGLE_CLIENT_ID, source: group/gl-demo-ultimate-dtop }
      file: false
    GOOGLE_CLIENT_SECRET:
      gitlab_secrets_manager: { name: GOOGLE_CLIENT_SECRET, source: group/gl-demo-ultimate-dtop }
      file: false
    GITLAB_DEPLOY_TOKEN:
      gitlab_secrets_manager: { name: GITLAB_DEPLOY_TOKEN, source: group/gl-demo-ultimate-dtop }
      file: false
    GITLAB_DEPLOY_TOKEN_USER:
      gitlab_secrets_manager: { name: GITLAB_DEPLOY_TOKEN_USER, source: group/gl-demo-ultimate-dtop }
      file: false
  script:
    - helm upgrade --install dlectroflow charts/dlectroflow
        --namespace dlectroflow-prod --create-namespace
        --set env=production --set postgres.persistent=true
        --set-string image.tag="$CI_COMMIT_SHA"
        --set-string host="dlectroflow.dlectronique.dev"
        --set-string secrets.postgresPassword="$POSTGRES_PASSWORD"
        --set-string secrets.anthropicApiKey="$ANTHROPIC_API_KEY"
        --set-string secrets.googleClientId="$GOOGLE_CLIENT_ID"
        --set-string secrets.googleClientSecret="$GOOGLE_CLIENT_SECRET"
        --set-string registry.username="$GITLAB_DEPLOY_TOKEN_USER"
        --set-string registry.password="$GITLAB_DEPLOY_TOKEN"
        --wait --timeout 5m
  environment:
    name: production
    url: https://dlectroflow.dlectronique.dev
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
```

- [ ] **Step 3: Validate CI YAML + agent config locally**

```bash
export PATH="/opt/homebrew/bin:/usr/bin:/bin:$PATH"
# YAML well-formedness
python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in ['.gitlab-ci.yml','.gitlab/agents/dlectroflow/config.yaml']]; print('YAML OK')"
# If glab is available and authed, lint against the server schema:
glab ci lint 2>/dev/null && echo "glab lint OK" || echo "glab lint skipped (validate in-pipeline)"
```
Expected: `YAML OK`; glab lint passes or is skipped.

- [ ] **Step 4: Verify the exact prod deploy render succeeds** (simulate the CI helm command)

```bash
helm template dlectroflow charts/dlectroflow \
  --set env=production --set postgres.persistent=true \
  --set-string image.tag=deadbeef --set-string host=dlectroflow.dlectronique.dev \
  --set-string secrets.postgresPassword=pw --set-string secrets.anthropicApiKey=k \
  --set-string secrets.googleClientId=gid --set-string secrets.googleClientSecret=gsec \
  --set-string registry.username=depuser --set-string registry.password=deptok >/tmp/ci-prod.yaml
kubeconform -strict -ignore-missing-schemas /tmp/ci-prod.yaml && echo OK-ci-prod-render
```
Expected: `OK-ci-prod-render`.

- [ ] **Step 5: Commit**

```bash
git add .gitlab/agents/dlectroflow/config.yaml .gitlab-ci.yml
git commit -m "$(cat <<'EOF'
Step 10: GitLab agent config + CI pipeline (review apps + production)

kaniko build → registry; helm deploy via agent context. Review apps on MR
(sslip.io, Spot, ephemeral) with auto-stop; production on main. Secrets from
GitLab Secrets Manager (environment-scoped); registry pull via deploy token.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Provisioning runbook + README deploy section

**Files:**
- Create: `docs/deploy-runbook.md`
- Modify: `README.md` (add a "Deploy" section linking the runbook)

**Interfaces:**
- Consumes: all prior artifacts. Produces: a user-runnable runbook. No code; verification is completeness/accuracy.

- [ ] **Step 1: Write `docs/deploy-runbook.md`** with these exact, ordered sections and commands:

````markdown
# dlectroflow — Deployment Runbook (GKE Autopilot + GitLab)

All infra lives in GCP region **europe-west2**. Prod host **dlectroflow.dlectronique.dev**.

## 0. Prerequisites
- `gcloud` authed to the target project; `kubectl`, `helm` installed.
- GitLab project `gl-demo-ultimate-dtop/dlectroflow`, Ultimate, SaaS runners.

## 1. Create the Autopilot cluster
```bash
gcloud container clusters create-auto dlectroflow --region europe-west2
gcloud container clusters get-credentials dlectroflow --region europe-west2
```

## 2. Static IP (already reserved: 35.246.93.255)
```bash
gcloud compute addresses describe dlectroflow-ingress --region europe-west2 --format='value(address)'
# → 35.246.93.255
```

## 3. Install ingress-nginx pinned to the static IP
```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.loadBalancerIP=35.246.93.255
```

## 4. Install cert-manager + Let's Encrypt ClusterIssuer
```bash
helm repo add jetstack https://charts.jetstack.io && helm repo update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace --set crds.enabled=true
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: you@dlectronique.dev
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: nginx
EOF
```

## 5. Install + register the GitLab agent
- In GitLab: Operate → Kubernetes clusters → Connect a cluster → agent name `dlectroflow` (config is committed at `.gitlab/agents/dlectroflow/config.yaml`). Copy the registration token, then:
```bash
helm repo add gitlab https://charts.gitlab.io && helm repo update
helm upgrade --install dlectroflow-agent gitlab/gitlab-agent \
  --namespace gitlab-agent --create-namespace \
  --set config.token=<REGISTRATION_TOKEN> \
  --set config.kasAddress=wss://kas.gitlab.com
```

## 6. Secrets Manager (group gl-demo-ultimate-dtop)
Confirm these secrets exist with the listed scopes (all created except Resend):
- `ANTHROPIC_API_KEY` — All environments
- `POSTGRES_PASSWORD` — All environments
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — production
- `RESEND_API_KEY` — production (optional)
- **`GITLAB_DEPLOY_TOKEN` + `GITLAB_DEPLOY_TOKEN_USER` — All environments** (NEW):
  create a project **deploy token** (Settings → Repository → Deploy tokens, scope `read_registry`), then add the username and token as these two secrets.

## 7. Production DNS (done)
`dlectroflow` A record → `35.246.93.255` in dlectronique.dev DNS.

## 8. Google OAuth redirect
Add `https://dlectroflow.dlectronique.dev/api/google/oauth/callback` to the OAuth client's authorized redirect URIs.

## 9. Deploy
- Open an MR → `deploy_review` publishes to `https://mr-<IID>.35.246.93.255.sslip.io` (see the MR "View app" button).
- Merge to `main` → `deploy_production` publishes to `https://dlectroflow.dlectronique.dev`.

## 10. Cost guardrails
- Confirm the free Autopilot/zonal cluster credit on the billing account.
- Set a GCP budget alert (Billing → Budgets & alerts).

## 11. Verify
- `kubectl -n dlectroflow-prod get pods` → app + postgres Running.
- `curl -I https://dlectroflow.dlectronique.dev` → 200 + valid TLS.
- Google "Connect" completes on the prod host.
- Close the MR → review namespace is deleted.
````

- [ ] **Step 2: Add a Deploy section to `README.md`** linking `docs/deploy-runbook.md` and stating the live URL + that review apps deploy per MR.

- [ ] **Step 3: Commit**

```bash
git add docs/deploy-runbook.md README.md
git commit -m "$(cat <<'EOF'
Step 10: deployment runbook + README deploy section

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Notes / risks surfaced during planning

- **New secret required:** `GITLAB_DEPLOY_TOKEN` + `GITLAB_DEPLOY_TOKEN_USER` (private-registry pull). Not in the original spec's 5-secret list — flagged in the runbook (§6).
- **OAuth base URL behind ingress:** the app derives redirect URIs from the request origin ([src/lib/google.ts](../../../src/lib/google.ts)). Verify it yields `https://dlectroflow.dlectronique.dev/...` behind ingress-nginx (which sets `X-Forwarded-Proto: https`); if it builds `http://`, fix origin derivation to honor forwarded headers. Verification step is in runbook §11.
- **kaniko/helm image tags** are pinned to concrete versions in `.gitlab-ci.yml`; bump as needed.
- Tasks 1–6 are fully verifiable locally (Docker + helm + kubeconform). Task 7 is user-run infra.
```
