# dlectroflow — Deployment Runbook (GKE Autopilot + GitLab)

All infra lives in GCP region **europe-west2**. Prod host **dlectroflow.dlectronique.dev**.

## 0. Prerequisites
- `gcloud` authed to the target project; `kubectl`, `helm` installed.
- GitLab project `gl-demo-ultimate-dtop/domi-oss/dlectroflow`, Ultimate, SaaS runners.

## 1. Create the Autopilot cluster
```bash
gcloud container clusters create-auto dlectroflow --region europe-west2
gcloud container clusters get-credentials dlectroflow --region europe-west2
```

> **kubectl needs `gke-gcloud-auth-plugin`.** If `kubectl` errors with "gke-gcloud-auth-plugin … not found", install it (`gcloud components install gke-gcloud-auth-plugin`) and ensure the SDK bin dir is on PATH (Homebrew: `/opt/homebrew/share/google-cloud-sdk/bin`), and `export USE_GKE_GCLOUD_AUTH_PLUGIN=True`.

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

> **Verify the IP bound:** `kubectl -n ingress-nginx get svc ingress-nginx-controller -w` until `EXTERNAL-IP` shows `35.246.93.255`. GKE honors `loadBalancerIP` only when the reserved address is a **regional external** address in the cluster's region (`europe-west2`) — confirm with `gcloud compute addresses describe dlectroflow-ingress --region=europe-west2`. If GKE provisions a different IP, delete the Service so Helm can recreate it, and re-check the address is regional (not global).

## 4. Install cert-manager + Let's Encrypt ClusterIssuer
```bash
helm repo add jetstack https://charts.jetstack.io && helm repo update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace --set crds.enabled=true --version v1.16.2 \
  --set global.leaderElection.namespace=cert-manager
```

> **GKE Autopilot fix (required):** `--set global.leaderElection.namespace=cert-manager`. By default cert-manager takes its leader-election lease in `kube-system`, which Autopilot **forbids writes to** ("managed-namespaces-limitation"). Without this flag, cainjector never becomes leader → never injects the webhook `caBundle` → every `ClusterIssuer`/`Certificate` apply fails with `failed calling webhook … x509: certificate signed by unknown authority`. If you already installed cert-manager without it, `helm upgrade` with the flag and wait for the webhook `caBundle` to populate (`kubectl get validatingwebhookconfiguration cert-manager-webhook -o jsonpath='{.webhooks[0].clientConfig.caBundle}' | wc -c` > 100).

> `--set crds.enabled=true` is correct for cert-manager **v1.15+**; for older charts use `--set installCRDs=true` instead. If the ClusterIssuer apply fails with `no matches for kind "ClusterIssuer"`, the CRDs didn't install — apply them manually: `kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.crds.yaml`.

```bash
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: you@dlectronique.dev # replace with your real email
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: nginx
EOF
```

> **GKE prod-TLS fix (required): cert-manager `hostAlias`.** cert-manager runs an HTTP-01 **self-check** by requesting the challenge at the public hostname, which resolves to the ingress **external LB IP**. On GKE a pod **can't reliably reach its own cluster's external LB IP** (no hairpin), so the self-check times out (`context deadline exceeded`) and the cert never issues — even though Let's Encrypt itself would validate fine from the internet. Fix: point cert-manager's in-cluster resolution of the prod host at the ingress **ClusterIP** via a `hostAlias`, applied durably through the Helm chart:
> ```bash
> INGRESS_CLUSTERIP=$(kubectl -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.spec.clusterIP}')
> helm upgrade cert-manager jetstack/cert-manager \
>   --namespace cert-manager --version v1.16.2 \
>   --set 'crds.enabled=true' \
>   --set 'global.leaderElection.namespace=cert-manager' \
>   --set "hostAliases[0].ip=$INGRESS_CLUSTERIP" \
>   --set 'hostAliases[0].hostnames[0]=dlectroflow.dlectronique.dev'
> ```
> Public DNS is untouched, so Let's Encrypt still validates over the internet. (Review apps on dynamic `*.sslip.io` hosts are left on the ingress default self-signed cert — ephemeral previews, and the per-MR host would need its own alias.)

## 5. Install + register the GitLab agent

> **Note — KUBE_CONTEXT collision:** the `gl-demo-ultimate-dtop` group defines a shared `KUBE_CONTEXT` CI/CD variable (pointing at `demo-foundation:gitops-agent`). Because group variables override `.gitlab-ci.yml`, this project's pipeline uses its own `AGENT_CONTEXT` variable (`gl-demo-ultimate-dtop/domi-oss/dlectroflow:dlectroflow`) instead. After you install the `dlectroflow` agent (below) and it connects, that context is injected into this project's CI jobs and the deploy jobs will find it. No group-variable change is required.

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
  1. Project → **Settings → Repository → Deploy tokens → Add token**.
  2. Name `k8s-registry-pull`; scope **`read_registry`** only; expiration optional.
  3. **Create deploy token** — GitLab shows a **username** (`gitlab+deploy-token-…`) and
     a **token** once. Copy both.
  4. In Secrets Manager add two All-environments secrets:
     - `GITLAB_DEPLOY_TOKEN_USER` = the username
     - `GITLAB_DEPLOY_TOKEN` = the token
  These become the cluster's dockerconfigjson pull secret so pods can pull the private
  image across restarts (the CI job token would expire).

## 7. Production DNS (done)
`dlectroflow` A record → `35.246.93.255` in dlectronique.dev DNS.

## 8. Google OAuth redirect
Add to the OAuth client's authorized redirect URIs (keep the local one too):
- `https://dlectroflow.dlectronique.dev/api/google/oauth/callback`
- `http://localhost:3000/api/google/oauth/callback`

After the production deploy, confirm the app builds an **https** redirect URI behind
ingress (Task 3 handles the forwarded-proto derivation):
```bash
curl -s -o /dev/null -D - "https://dlectroflow.dlectronique.dev/api/google/oauth/start" | grep -i '^location:'
```
The `Location:` URL's `redirect_uri=` must be `https%3A%2F%2Fdlectroflow.dlectronique.dev%2F…`.
If it shows `http%3A%2F%2F` or Google returns `redirect_uri_mismatch`, re-check the
ingress `X-Forwarded-Proto` header and Task 3's `requestOrigin`.

## 9. Deploy
- Open an MR → `deploy_review` publishes to `https://mr-<IID>.35-246-93-255.sslip.io` (see the MR "View app" button).
  > **sslip.io host format:** use the **dash-separated** IP (`35-246-93-255`), not dotted (`35.246.93.255`). A dotted quad *after* a hyphenated prefix like `mr-1.` makes sslip.io misparse the IP (e.g. `mr-1.35.246.93.255.sslip.io` resolves to a bogus `1.35.246.93`). The dash form resolves correctly.
- Merge to `main` → `deploy_production` publishes to `https://dlectroflow.dlectronique.dev`.

## 10. Cost guardrails
- Confirm the free Autopilot/zonal cluster credit on the billing account.
- Set a GCP budget alert (Billing → Budgets & alerts).

## 11. Verify
- `kubectl -n dlectroflow-prod get pods` → app + postgres Running.
- `curl -I https://dlectroflow.dlectronique.dev` → 200 + valid TLS.
- Google "Connect" completes on the prod host.
- Close the MR → review namespace is deleted.

## 12. Database backups (GCS, prod only)

The in-cluster Postgres is a single-replica StatefulSet on one PVC, so a logical
backup is the recovery path (see #21). A daily CronJob dumps the DB to GCS.

**Infra (one-time, already provisioned):**
- Bucket `gs://dlectroflow-db-backups-dtop-1bf3a85b` (europe-west2, uniform access,
  public-access-prevention, **30-day lifecycle auto-delete**).
- GCP service account `dlectroflow-backup@dtop-1bf3a85b.iam.gserviceaccount.com`
  with `roles/storage.objectAdmin` **scoped to that bucket only**.
- Workload Identity binding: KSA `dlectroflow-prod/dlectroflow-backup` → that GSA
  (keyless; no JSON key exists or is mounted).

**How it runs:** `charts/dlectroflow/templates/backup.yaml` renders a `ServiceAccount`
(WI-annotated) + `CronJob dlectroflow-db-backup` when `backup.enabled` and
`env=production` (CI sets both). Schedule **02:00 UTC daily**. Two stages: an
initContainer (`postgres:16`, version-matched) runs `pg_dump | gzip` to a shared
volume, then the `google/cloud-sdk` container `gcloud storage cp`s it to
`gs://…/pg/dlectroflow-<UTC-timestamp>.sql.gz`.

**Check it's healthy:**
```
kubectl -n dlectroflow-prod get cronjob dlectroflow-db-backup
kubectl -n dlectroflow-prod get jobs -l app.kubernetes.io/name=dlectroflow --sort-by=.metadata.creationTimestamp | tail
gcloud storage ls -l gs://dlectroflow-db-backups-dtop-1bf3a85b/pg/ | tail
```

**Run one on demand** (e.g. before a risky migration):
```
kubectl -n dlectroflow-prod create job --from=cronjob/dlectroflow-db-backup manual-backup-$(date +%s)
```

### Restore (into a scratch DB first — never straight over prod)
1. Pull the dump you want:
   ```
   gcloud storage cp gs://dlectroflow-db-backups-dtop-1bf3a85b/pg/dlectroflow-<STAMP>.sql.gz /tmp/
   gunzip /tmp/dlectroflow-<STAMP>.sql.gz
   ```
2. Port-forward prod Postgres and restore into a **scratch** database to inspect:
   ```
   kubectl -n dlectroflow-prod port-forward svc/dlectroflow-postgres 5432:5432 &
   PGPASSWORD=<POSTGRES_PASSWORD> createdb   -h localhost -U dlectroflow restore_check
   PGPASSWORD=<POSTGRES_PASSWORD> psql -h localhost -U dlectroflow -d restore_check -f /tmp/dlectroflow-<STAMP>.sql
   ```
   (`POSTGRES_PASSWORD` is the Secrets Manager value; `kubectl -n dlectroflow-prod get secret dlectroflow-secrets -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d`.)
3. Only once verified, restore over the live DB during a maintenance window:
   scale the app to 0 (`kubectl -n dlectroflow-prod scale deploy/dlectroflow --replicas=0`),
   `dropdb`/`createdb dlectroflow`, `psql -d dlectroflow -f dump.sql`, scale back up.

- **RPO ≈ 24h** (daily dump). **RTO** = time to pull + restore (minutes at this size).
  Tighten either by raising the schedule frequency.

## 13. Rollback

**App-only (no schema change in the bad deploy):** deploys use `helm upgrade --atomic`,
so a rollout that fails to become Ready **auto-rolls back** to the last good release.
To revert a deploy that *succeeded* but is bad:
```
helm -n dlectroflow-prod history dlectroflow
helm -n dlectroflow-prod rollback dlectroflow <PREVIOUS_REVISION> --wait --timeout 10m
```

**⚠️ If the bad deploy ran a migration:** migrations are **forward-only**
(`prisma migrate deploy` in the app initContainer). `helm rollback` reverts the
*image* but **not** the schema, so an older image can hit a newer schema and crash.
Options, in order of preference:
1. **Roll forward** — fix in a new commit and deploy (preferred; avoids schema divergence).
2. If you must go back, restore the DB from the pre-deploy backup (§12) to match the
   old image, then `helm rollback`. Take a fresh on-demand backup first.
- **Discipline going forward:** keep migrations backward-compatible (expand/contract)
  so an app rollback is always safe without a DB restore.
