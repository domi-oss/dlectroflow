# dlectroflow — Deployment Status (Step 10)

**As of 2026-07-03.** Branch `step-10-deployment` → **MR !1** (Ready). Full procedure: [`docs/deploy-runbook.md`](deploy-runbook.md).

## ✅ Provisioned (live now)

GCP project **`dtop-1bf3a85b`**, region **`europe-west2`**, account `dtop@gitlab.com`.

| Component | State |
|---|---|
| **GKE Autopilot cluster** `dlectroflow` | RUNNING (k8s 1.35). Context: `gke_dtop-1bf3a85b_europe-west2_dlectroflow` |
| **ingress-nginx** (ns `ingress-nginx`) | Installed; Service `EXTERNAL-IP` = **`35.246.93.255`** (reserved static IP bound ✅) |
| **cert-manager** v1.16.2 (ns `cert-manager`) | Installed **with the Autopilot fix** `global.leaderElection.namespace=cert-manager` |
| **ClusterIssuer** `letsencrypt-prod` | **READY** (ACMEAccountRegistered), HTTP-01 via nginx |
| **Production DNS** | `dlectroflow.dlectronique.dev` A → `35.246.93.255` (set) |
| **App image / CI** | MR !1 pipeline `build` = green (image pushed to registry); `deploy_*` pending the agent |

> kubectl access: needs `gke-gcloud-auth-plugin` on PATH (`/opt/homebrew/share/google-cloud-sdk/bin`) + `export USE_GKE_GCLOUD_AUTH_PLUGIN=True`.

## ⏳ Remaining (needs you — GitLab-side, can't be done from the CLI/agentless)

1. **Install the `dlectroflow` GitLab agent** (this is what makes the pipeline's `AGENT_CONTEXT` resolve and deploys go green):
   - GitLab → **Operate → Kubernetes clusters → Connect a cluster** → agent name **`dlectroflow`** (config already committed at `.gitlab/agents/dlectroflow/config.yaml`). Copy the registration token, then:
     ```bash
     export PATH="$HOME/.rd/bin:/opt/homebrew/share/google-cloud-sdk/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
     export USE_GKE_GCLOUD_AUTH_PLUGIN=True
     helm repo add gitlab https://charts.gitlab.io && helm repo update
     helm upgrade --install dlectroflow-agent gitlab/gitlab-agent \
       --namespace gitlab-agent --create-namespace \
       --set config.token=<REGISTRATION_TOKEN> \
       --set config.kasAddress=wss://kas.gitlab.com
     ```
2. **Registry deploy token** → create a `read_registry` deploy token (Settings → Repository → Deploy tokens, name `k8s-registry-pull`), then add **`GITLAB_DEPLOY_TOKEN`** + **`GITLAB_DEPLOY_TOKEN_USER`** to Secrets Manager (group `gl-demo-ultimate-dtop`, All environments). See runbook §6.
3. **Google OAuth** → add redirect URI `https://dlectroflow.dlectronique.dev/api/google/oauth/callback` to the OAuth client (runbook §8).
4. **Deploy** → re-run MR !1's pipeline (review app) and/or **merge to `main`** for production. Verify per runbook §11.

## Notes
- Let's Encrypt registration email used for the ClusterIssuer: `dtop@gitlab.com`.
- Secrets Manager already holds: `ANTHROPIC_API_KEY`, `POSTGRES_PASSWORD` (all-envs), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (prod). `RESEND_API_KEY` optional (email stays disabled without it).
- The group's shared `KUBE_CONTEXT` var points at `demo-foundation:gitops-agent` — we deliberately use our own `AGENT_CONTEXT` so it isn't shadowed (runbook §5 note).
- Deferred code polish (non-blocking) is listed in MR !1.
