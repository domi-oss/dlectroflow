# dlectroflow — Step 10: Live deployment on GitLab + GKE Autopilot (design)

**Date:** 2026-07-03
**Status:** approved (design), pending implementation plan
**Scope:** Step 10 of the build order — take dlectroflow from a local SQLite app to a
live, GitLab-CI/CD-deployed app on Kubernetes, with per-MR review apps and a stable
production environment. Deferred: further feature work and front-end polish (explicitly
after first live deployment).

---

## 1. Goal

Get dlectroflow to a **first live deployment** that doubles as a GitLab-Ultimate
showcase: a GitLab CI/CD pipeline that builds a container, deploys an ephemeral
**review app per merge request**, and deploys a **stable production** environment on
merge to `main` — all onto a **GKE Autopilot** cluster reached through the **GitLab
agent for Kubernetes**, with TLS, Postgres, and secrets sourced from **GitLab Secrets
Manager (beta)**.

Production URL: **https://dlectroflow.dlectronique.dev**

---

## 2. Decisions locked (from brainstorming)

| Decision | Choice |
|---|---|
| Deploy target | Kubernetes via the **GitLab agent** (`agentk`) |
| Cluster | **GKE Autopilot**, region **`europe-west2`** (London) |
| Provisioning state | Nothing exists yet — we produce all artifacts **+ a runbook** the user runs |
| Deploy model | **Review apps (per-MR, ephemeral) + production (on `main`)** |
| Review-app hostnames | **sslip.io** (`mr-<IID>.35.246.93.255.sslip.io`), zero DNS setup |
| Production host | **`dlectroflow.dlectronique.dev`** (subdomain; apex left free) |
| TLS | **Let's Encrypt HTTP-01** via cert-manager, per-host (no wildcard needed) |
| Manifests | **Helm** chart, one chart rendered per environment |
| Database | **Postgres everywhere.** Local via Docker Compose; in-cluster StatefulSet per env |
| Secrets | **GitLab Secrets Manager (beta)**, group-scoped, environment-scoped |
| Ingress LB IP | Reserved static IP **`35.246.93.255`** (`dlectroflow-ingress`, regional, `europe-west2`) |

---

## 3. Architecture & topology

One GKE Autopilot cluster hosts everything. `ingress-nginx` provides a **single**
external LoadBalancer pinned to the reserved static IP; `cert-manager` issues per-host
Let's Encrypt certs. The GitLab agent runs in-cluster and dials out to GitLab — no
cluster credentials are stored in GitLab.

```
                        GKE Autopilot cluster (europe-west2)
                        ingress-nginx @ 35.246.93.255  ·  cert-manager  ·  agentk
                        │
 MR opened ──► deploy_review ──► namespace: dlectroflow-mr-<IID>
                        │          ├─ app Deployment + Service + Ingress
                        │          ├─ Postgres StatefulSet (emptyDir, ephemeral)
                        │          ├─ Secret (from Secrets Manager)
                        │          └─ ResourceQuota
                        │          host: mr-<IID>.35.246.93.255.sslip.io  (HTTP-01 TLS)
 MR closed/merged ─► stop_review ─► kubectl delete namespace  (full teardown)

 merge to main ──► deploy_production ──► namespace: dlectroflow-prod
                        │                 ├─ app (same chart/image)
                        │                 ├─ Postgres StatefulSet (PVC 8Gi, persistent)
                        │                 └─ Secret (from Secrets Manager, prod scope)
                        │                 host: dlectroflow.dlectronique.dev  (A record → IP)
```

**Key properties**
- **Each environment is a self-contained namespace** — app + its own Postgres + Secret,
  rendered from the same chart with different values. Review namespaces are disposable;
  deleting the namespace cleans up everything including the ephemeral DB.
- **One image per pipeline**, tagged by commit SHA, pushed to the **GitLab Container
  Registry**; both review and production deploy that exact image.
- **Single shared LoadBalancer** for all environments (cost + simplicity).

---

## 4. Environments

| | Review app | Production |
|---|---|---|
| Trigger | MR pipeline | Merge to `main` |
| Namespace | `dlectroflow-mr-<IID>` | `dlectroflow-prod` |
| Host | `mr-<IID>.35.246.93.255.sslip.io` | `dlectroflow.dlectronique.dev` |
| Postgres | StatefulSet, `emptyDir` (ephemeral) | StatefulSet, PVC 8Gi (persistent) |
| Compute class | **Spot** | on-demand |
| Lifecycle | `auto_stop_in: 2 days` + manual `stop_review` | long-lived |
| OAuth (Google/Reclaim) | unavailable (no wildcard redirect) | available |
| Secrets available | `ANTHROPIC_API_KEY`, `POSTGRES_PASSWORD` | all (incl. `GOOGLE_*`, `RESEND_API_KEY`) |

---

## 5. App-side changes

### 5.1 Prisma provider switch (SQLite → Postgres)
- `prisma/schema.prisma`: `provider = "postgresql"`, `url = env("DATABASE_URL")`.
- **Regenerate migration history** (no real data to preserve): delete the four SQLite
  migrations, create a fresh `0001_init` against local Postgres; `migration_lock.toml`
  flips to `postgresql`.
- **No application/`constants.ts` changes.** The `String`-for-enum decisions remain
  valid on Postgres, so `rewards.ts`, actions, libs, and components are untouched.

### 5.2 Local dev via Docker Compose
- New `docker-compose.yml` with `postgres:16` (named volume, port 5432, db/user/pass
  `dlectroflow`).
- Local `DATABASE_URL=postgresql://dlectroflow:dlectroflow@localhost:5432/dlectroflow?schema=public`.
- Update `.env.example`, README "run locally" (`docker compose up -d db` →
  `npm run db:migrate` → `npm run dev`), and the `setup` npm script.

### 5.3 Standalone container image
- `next.config.ts`: `output: "standalone"`.
- Multi-stage Dockerfile: build stage compiles; runtime stage carries the standalone
  server (`node server.js`) **plus** the Prisma CLI + query engine + `prisma/migrations`
  + `prisma.config.ts`, because the migration step reuses this same image.
- Remove the SQLite `VOLUME` and the `DATABASE_URL` default (now from the Secret).
- `CMD` → `node server.js` (migrations move out of `CMD`, see 5.5).

### 5.4 Health endpoint
- Add `GET /api/health` (Node runtime) returning 200 + a lightweight DB ping, for
  Kubernetes liveness/readiness probes.

### 5.5 Migrations
- Run via **app-Deployment initContainers**, not a Helm hook:
  `wait-for-db` (`pg_isready` loop) → `migrate` (`prisma migrate deploy`) → app container.
- Rationale: a Helm pre-install hook cannot see the in-namespace Postgres (a normal
  release resource) before it exists; at `replicas: 1` the initContainer is race-free,
  and Prisma's migration advisory lock covers future scale-up.

---

## 6. Helm chart (`charts/dlectroflow/`)

Templates:
- `deployment.yaml` — app; `replicas: 1`; `envFrom` the Secret; liveness/readiness on
  `/api/health`; initContainers `wait-for-db` + `migrate`; per-env resources; Spot
  `nodeSelector` when `spot=true`.
- `service.yaml` — ClusterIP for the app.
- `ingress.yaml` — `ingressClassName: nginx`, `cert-manager.io/cluster-issuer:
  letsencrypt-prod`, host + TLS from values.
- `postgres-statefulset.yaml` + `postgres-service.yaml` — `postgres:16`;
  `persistent=true` → `volumeClaimTemplates` PVC; `persistent=false` → `emptyDir`.
- `secret.yaml` — rendered from values injected by CI (`secrets.*`); provides
  `DATABASE_URL` (built from the in-namespace Postgres service + `postgresPassword`),
  `ANTHROPIC_API_KEY`, and (prod) `GOOGLE_*` / `RESEND_API_KEY` / `ROUNDUP_FROM_EMAIL`.
- `resourcequota.yaml` — per review namespace, to cap runaway usage.

`values.yaml` holds defaults; CI overrides per env via `--set` / `--set-string`:
`image.repository`, `image.tag`, `env`, `host`, `postgres.persistent`, `spot`,
resource requests, and `secrets.*`.

### Resource allocation (Autopilot bills per Pod request; requests = limits)

| Component | Env | CPU req | Mem req | Storage | Class |
|---|---|---|---|---|---|
| app (Next.js) | production | `500m` | `512Mi` | ephemeral 1Gi | on-demand |
| postgres | production | `250m` | `512Mi` | PVC 8Gi | on-demand |
| app | review | `250m` | `512Mi` | ephemeral 1Gi | Spot |
| postgres | review | `250m` | `512Mi` | emptyDir | Spot |

(Autopilot minimums honored: ≥0.25 vCPU/pod, memory:CPU within 1:1–6.5:1.)

### Stability & scaling headroom

Sized for this app's real workload — a **single-user** demo where Claude inference
runs on Anthropic's side, so our pods just proxy/stream (CPU stays low) and hold a tiny
dataset. Expected steady state: Next.js standalone ~250–350MB under SSR + Prisma + the
Anthropic SDK (well under `512Mi`); Postgres a few hundred rows (well under `512Mi`).

Autopilot defaults **limits = requests**, so memory is a hard cap (over → OOMKill) and
CPU is capped (over → throttle, not crash); the sizes above are set *with* headroom for
that, not sized to the bone. Spot (review only) can be preempted → a few minutes of
review-app restart, which is acceptable for ephemeral environments and deliberately not
used for production.

Every knob is a Helm value, so growth is low-effort and low-disruption:

| Want to… | How | Disruption |
|---|---|---|
| Give a pod more CPU/RAM | change a `values.yaml` number → redeploy | rolling, none |
| Handle concurrent users | raise `replicas` (+ HPA later); app is stateless, Prisma's migration lock covers it | none |
| Grow the database | expand the PVC (GKE online resize), or move to Cloud SQL (§14) | minimal |
| Exceed a node's size | nothing — Autopilot auto-provisions nodes to fit | none |

---

## 7. GitLab CI pipeline (`.gitlab-ci.yml`)

Stages: `build → deploy`.

- **`build`** — kaniko (no privileged runner) builds and pushes
  `$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA` to the GitLab Container Registry.
- **`deploy_review`** — `rules: if $CI_PIPELINE_SOURCE == "merge_request_event"`.
  `helm upgrade --install` into `dlectroflow-mr-$CI_MERGE_REQUEST_IID`
  (`--create-namespace`), host `mr-$CI_MERGE_REQUEST_IID.35.246.93.255.sslip.io`,
  `spot=true`, ephemeral Postgres.
  `environment: { name: review/$CI_MERGE_REQUEST_IID, url: https://…, on_stop:
  stop_review, auto_stop_in: 2 days }`.
- **`stop_review`** — `rules: if MR`, `when: manual`; `helm uninstall` +
  `kubectl delete namespace`. `environment: { name: review/$CI_MERGE_REQUEST_IID,
  action: stop }`.
- **`deploy_production`** — `rules: if $CI_COMMIT_BRANCH == "main"`. Namespace
  `dlectroflow-prod`, host `dlectroflow.dlectronique.dev`, `postgres.persistent=true`,
  on-demand. `environment: { name: production, url: https://dlectroflow.dlectronique.dev }`.

All deploy jobs select the agent context
(`kubectl config use-context gl-demo-ultimate-dtop/dlectroflow:dlectroflow`) before
running Helm.

Agent registration file: `.gitlab/agents/dlectroflow/config.yaml` with `ci_access` to
grant this project Helm/`kubectl` through the agent.

---

## 8. Secrets — GitLab Secrets Manager (beta)

Enabled at the **group** (`gl-demo-ultimate-dtop`). Requires Premium/Ultimate + Owner +
Runner 19.0+ (gitlab.com SaaS runners qualify). Secrets are added via the UI
(Secure → Secrets manager). **Already created** by the user:

| Name | Purpose | Env scope | Status |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API (breakdown, spark, round-up) | **All** | ✅ added |
| `GOOGLE_CLIENT_ID` | Google Tasks OAuth | **production** | ✅ added |
| `GOOGLE_CLIENT_SECRET` | Google Tasks OAuth | **production** | ✅ added |
| `POSTGRES_PASSWORD` | In-cluster Postgres password | **All** | ✅ added |
| `RESEND_API_KEY` | Opt-in round-up email | **production** | ⏳ not yet (optional; email stays disabled) |

**Environment scoping replaces the old protected-variable workaround:** All-scope
secrets reach ephemeral review pipelines (so Claude breakdown works in review);
production-scope secrets never touch MR pipelines (and review apps can't do OAuth
anyway).

Consumed with the `secrets:` keyword + `gitlab_secrets_manager` provider, `file: false`
so values arrive as env vars and pass into `helm --set-string secrets.*`:

```yaml
deploy_production:
  environment:
    name: production
    url: https://dlectroflow.dlectronique.dev
  secrets:
    ANTHROPIC_API_KEY:
      gitlab_secrets_manager: { name: ANTHROPIC_API_KEY, source: group/gl-demo-ultimate-dtop }
      file: false
    GOOGLE_CLIENT_ID:
      gitlab_secrets_manager: { name: GOOGLE_CLIENT_ID, source: group/gl-demo-ultimate-dtop }
      file: false
    GOOGLE_CLIENT_SECRET:
      gitlab_secrets_manager: { name: GOOGLE_CLIENT_SECRET, source: group/gl-demo-ultimate-dtop }
      file: false
    POSTGRES_PASSWORD:
      gitlab_secrets_manager: { name: POSTGRES_PASSWORD, source: group/gl-demo-ultimate-dtop }
      file: false
  script:
    - kubectl config use-context gl-demo-ultimate-dtop/dlectroflow:dlectroflow
    - helm upgrade --install dlectroflow charts/dlectroflow
        --namespace dlectroflow-prod --create-namespace
        --set-string image.tag="$CI_COMMIT_SHA"
        --set-string host="dlectroflow.dlectronique.dev"
        --set postgres.persistent=true
        --set-string secrets.anthropicApiKey="$ANTHROPIC_API_KEY"
        --set-string secrets.googleClientId="$GOOGLE_CLIENT_ID"
        --set-string secrets.googleClientSecret="$GOOGLE_CLIENT_SECRET"
        --set-string secrets.postgresPassword="$POSTGRES_PASSWORD"
```

`deploy_review` declares only `ANTHROPIC_API_KEY` + `POSTGRES_PASSWORD` (the All-scope
secrets), so prod-scope secrets are never exposed there.

No secret touches the repo, `.env`, or a masked CI variable. `DATABASE_URL` and
`ROUNDUP_FROM_EMAIL` are not secrets (chart-built / plain value).

**Beta caveats:** free during beta (consumes GitLab credits at GA); disabling the
Secrets Manager or deleting the group permanently destroys the secrets — runbook
documents re-adding them.

---

## 9. TLS / DNS / ingress

- **Static IP** `35.246.93.255` (reserved: `dlectroflow-ingress`, regional,
  `europe-west2`). `ingress-nginx` installed with
  `controller.service.loadBalancerIP=35.246.93.255`.
- **cert-manager** + a `letsencrypt-prod` **ClusterIssuer** (HTTP-01 via the nginx
  class). Per-host certs issue automatically for both sslip.io review hosts and the prod
  host.
- **Review hosts:** `mr-<IID>.35.246.93.255.sslip.io` — sslip.io resolves the embedded
  IP; zero DNS config.
- **Production DNS** (`dlectronique.dev`): single **A record** `dlectroflow` →
  `35.246.93.255` (TTL 300). Already created and resolving.
- `.dev` is HSTS-preloaded → HTTPS mandatory; fine because cert-manager issues the cert
  once nginx answers on :80 at the resolved host. Create DNS **before** expecting the
  cert.
- **Google OAuth redirect URIs** on the OAuth client:
  `https://dlectroflow.dlectronique.dev/api/google/oauth/callback` (prod) and
  `http://localhost:3000/api/google/oauth/callback` (local). No wildcard for review apps.

---

## 10. Cost controls

Fixed costs dominate the tiny pod spend:

| Item | ~Monthly (europe-west2, estimate) | Control |
|---|---|---|
| Cluster management fee | ~$74 | One Autopilot/zonal cluster free per billing account — use it (→ $0). |
| LoadBalancer (1 shared) | ~$18–20 | ingress-nginx = one LB for all envs. |
| Production pods (always on) | ~$28 | Right-sized (§6). |
| Prod PVC (8Gi) | ~$1 | — |
| Review apps | a few $ | Spot pods + `auto_stop_in: 2 days` + manual stop + ResourceQuota. |

**Realistic total ~$45–55/mo** with the free cluster credit (~$120/mo without), plus
variable review-app time. Runbook adds a **GCP budget alert** and a check that the free
cluster credit is unused. Estimates — verify in the GCP pricing calculator.

---

## 11. Provisioning runbook (user-run; produced as `docs/`)

1. Create GKE **Autopilot** cluster in `europe-west2`.
2. Reserve static IP — **done** (`35.246.93.255`).
3. Install **ingress-nginx** pinned to `35.246.93.255`.
4. Install **cert-manager** + `letsencrypt-prod` ClusterIssuer.
5. Install/register the **GitLab agent** (`.gitlab/agents/dlectroflow/config.yaml` +
   `helm install` with the registration token).
6. Enable **Secrets Manager** at the group + confirm the 5 secrets and their scopes —
   **done** (Resend optional/pending).
7. Production **DNS A record** — **done**.
8. Register the **Google OAuth** prod redirect URI.
9. Push: open an MR → review app; merge to `main` → production.
10. Set a **GCP budget alert**; confirm the free cluster credit.
11. Per-environment **verification** (§13).

---

## 12. Known limitations (documented, not bugs)

- **OAuth connect (Google Tasks / Reclaim) works only on the production host** — no
  wildcard redirect URIs for ephemeral sslip.io hosts. Review apps fully demo capture →
  breakdown → focus → rewards → round-up; calendar-scheduling connect is prod-only.
- **Review-app Postgres is ephemeral** — reset on each deploy/teardown (intended).
- **Round-up email disabled in production** until `RESEND_API_KEY` is added (app guards
  gracefully via `emailConfigured()`).
- **Secrets Manager is beta** — see §8 caveats.

---

## 13. Verification / acceptance

- **Local:** `docker compose up -d db && npm run db:migrate && npm run dev` runs on
  Postgres; existing flows work.
- **Image:** builds in CI and pushes to the registry; migration initContainer applies
  cleanly against a fresh Postgres.
- **Review app:** opening an MR produces a running app at the sslip.io URL with valid
  TLS; the MR shows a "View app" button; Claude breakdown works; closing the MR tears
  the namespace down.
- **Production:** merge to `main` deploys to `dlectroflow.dlectronique.dev` with valid
  TLS; DB persists across a redeploy; Google "Connect" completes on the prod host.
- **Secrets:** no secret value appears in repo, logs, or job output; prod-scope secrets
  absent from review pipelines.

---

## 14. Out of scope (future iterations)

- Front-end polish / animation pass and any new features (explicitly deferred until
  after first live deployment).
- Managed Cloud SQL (in-cluster StatefulSet is enough for the demo).
- Multi-replica / autoscaling / PodDisruptionBudgets.
- Migrating secrets consumption from CI `--set` to native CSI/External Secrets.

---

## 15. Deliverables (files to create/modify)

- `prisma/schema.prisma` (provider), `prisma/migrations/*` (regenerated), `migration_lock.toml`
- `docker-compose.yml`, `.env.example`, `README.md`, `package.json` (`setup` script)
- `next.config.ts` (`output: standalone`), `Dockerfile` (multi-stage/standalone + Prisma CLI)
- `src/app/api/health/route.ts`
- `charts/dlectroflow/` (Chart.yaml, values.yaml, templates/*)
- `.gitlab/agents/dlectroflow/config.yaml`
- `.gitlab-ci.yml`
- `docs/deploy-runbook.md`
