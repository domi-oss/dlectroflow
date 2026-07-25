# dlectroflow — Deployment Status (Step 10)

**As of 2026-07-03 — ✅ LIVE.** MR !1 merged to `main`; production pipeline succeeded. The app is live at **https://dlectroflow.dev** with a valid Let's Encrypt cert. Full procedure: [`docs/deploy-runbook.md`](deploy-runbook.md).

## ✅ Provisioned (live now)

GCP project **`YOUR_GCP_PROJECT`**, region **`europe-west2`**, account `you@example.com`.

| Component | State |
|---|---|
| **GKE Autopilot cluster** `dlectroflow` | RUNNING (k8s 1.35). Context: `gke_YOUR_GCP_PROJECT_europe-west2_dlectroflow` |
| **ingress-nginx** (ns `ingress-nginx`) | Installed; Service `EXTERNAL-IP` = **`YOUR_STATIC_IP`** (reserved static IP bound ✅) |
| **cert-manager** v1.16.2 (ns `cert-manager`) | Installed **with the Autopilot fix** `global.leaderElection.namespace=cert-manager` |
| **ClusterIssuer** `letsencrypt-prod` | **READY** (ACMEAccountRegistered), HTTP-01 via nginx |
| **Production DNS** | `dlectroflow.dev` A → `YOUR_STATIC_IP` (set) |
| **GitLab agent** `dlectroflow` | ✅ Installed & Connected (`helm ... gitlab/gitlab-agent` in ns `gitlab-agent`). Its `ci_access` config lives on `main` (`.gitlab/agents/dlectroflow/config.yaml`) — required, KAS reads it from the default branch only. |
| **cert-manager hostAlias** (prod TLS) | ✅ `dlectroflow.dev` → ingress ClusterIP `34.118.234.248` (set via `helm upgrade cert-manager ... --set hostAliases[0]...`). Works around GKE not hairpinning to its own external LB IP during the HTTP-01 self-check. |
| **App image / CI** | ✅ `build` + `deploy_production` green; app pod 1/1, `/api/health` 200, HTTP→HTTPS 308, valid Let's Encrypt cert. Review apps deploy per-MR and auto-tear-down on close. |

> kubectl access: needs `gke-gcloud-auth-plugin` on PATH (`/opt/homebrew/share/google-cloud-sdk/bin`) + `export USE_GKE_GCLOUD_AUTH_PLUGIN=True`.

## ✅ Completed (all four GitLab-side steps done)

1. **GitLab agent installed** (`dlectroflow`, ns `gitlab-agent`, Connected). Gotcha: its `ci_access` config must be on the **default branch** (`main`) or MR `deploy_review` can't authorize.
2. **Registry deploy token** (`k8s-registry-pull`, `read_registry`) + `GITLAB_DEPLOY_TOKEN`(+`_USER`) in Secrets Manager (All environments).
3. **Google OAuth** prod redirect URI `https://dlectroflow.dev/api/google/oauth/callback` added (verified: the app builds an `https` redirect_uri behind ingress).
4. **Merged MR !1 → production deployed & verified** (valid TLS, review app also verified then torn down).

### Fixes made during the deploy (all in-repo / documented)
- **initContainers** (`wait-for-db`, `migrate`) now set resource limits — the review-only `ResourceQuota` requires limits on every container (chart fix).
- **Review host** uses sslip.io's **dash-IP** form `mr-<IID>.YOUR-STATIC-IP.sslip.io` — the dotted form after a hyphenated prefix mis-resolves (`.gitlab-ci.yml` fix).
- **Prod TLS** unblocked via the cert-manager `hostAlias` above (cluster-side; documented in runbook §4).

## Notes
- Let's Encrypt registration email used for the ClusterIssuer: `you@example.com`.
- Secrets Manager already holds: `ANTHROPIC_API_KEY`, `POSTGRES_PASSWORD` (all-envs), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (prod). `RESEND_API_KEY` optional (email stays disabled without it).
- The group's shared `KUBE_CONTEXT` var points at `demo-foundation:gitops-agent` — we deliberately use our own `AGENT_CONTEXT` so it isn't shadowed (runbook §5 note).
- Deferred code polish (non-blocking) is listed in MR !1.
