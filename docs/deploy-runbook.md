# dlectroflow — Deployment Runbook (GKE Autopilot + GitLab)

All infra lives in GCP region **europe-west2**. Prod host **dlectroflow.dev**.

## 0. Prerequisites
- `gcloud` authed to the target project; `kubectl`, `helm` installed.
- GitLab project `gl-demo-ultimate-dtop/domi-oss/dlectroflow`, Ultimate, SaaS runners.

## 1. Create the Autopilot cluster
```bash
gcloud container clusters create-auto dlectroflow --region europe-west2
gcloud container clusters get-credentials dlectroflow --region europe-west2
```

> **kubectl needs `gke-gcloud-auth-plugin`.** If `kubectl` errors with "gke-gcloud-auth-plugin … not found", install it (`gcloud components install gke-gcloud-auth-plugin`) and ensure the SDK bin dir is on PATH (Homebrew: `/opt/homebrew/share/google-cloud-sdk/bin`), and `export USE_GKE_GCLOUD_AUTH_PLUGIN=True`.

## 2. Static IP (already reserved: YOUR_STATIC_IP)
```bash
gcloud compute addresses describe dlectroflow-ingress --region europe-west2 --format='value(address)'
# → YOUR_STATIC_IP
```

## 3. Install ingress-nginx pinned to the static IP
```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.loadBalancerIP=YOUR_STATIC_IP \
  --set controller.service.externalTrafficPolicy=Local \
  --set controller.replicaCount=2 \
  --set controller.minAvailable=1
```

> **Verify the IP bound:** `kubectl -n ingress-nginx get svc ingress-nginx-controller -w` until `EXTERNAL-IP` shows `YOUR_STATIC_IP`. GKE honors `loadBalancerIP` only when the reserved address is a **regional external** address in the cluster's region (`europe-west2`) — confirm with `gcloud compute addresses describe dlectroflow-ingress --region=europe-west2`. If GKE provisions a different IP, delete the Service so Helm can recreate it, and re-check the address is regional (not global).

> **Preserve the real client IP (`externalTrafficPolicy: Local`) — required for the per-IP guest quota (#28).** The app keys its guest AI quota (and ingress rate-limiting) on the client IP from the right-most `X-Forwarded-For` hop / `X-Real-IP` (`src/lib/guest-quota.ts`, !76). That is only trustworthy if the real client IP reaches ingress-nginx un-SNAT'd. With the GKE default `externalTrafficPolicy: Cluster`, kube-proxy SNATs external traffic to a **node IP**, so every guest collapses onto a handful of node IPs and the quota can't tell clients apart. `Local` stops the SNAT so the L4 passthrough NLB's preserved source IP reaches nginx. Keep ingress-nginx `use-forwarded-headers` at its default `false`. **No app change is needed.**
>
> **HA first — blast radius:** under `Local` the NLB drops traffic to any node without a Ready ingress-nginx pod. A single controller replica = one healthy backend node, so a pod move / node event is a brief full outage — hence `replicaCount=2`. The ingress-nginx chart creates the `PodDisruptionBudget` when **`controller.minAvailable` (or `controller.maxUnavailable`) is set** — *not* from `replicaCount` alone, and there is no `podDisruptionBudget.enabled` / `pdb.create` value. So `controller.minAvailable=1` is what actually creates the PDB (sized so one controller pod keeps serving through voluntary disruptions), and `replicaCount=2` gives it two pods to protect. (The !34 HA safeguards cover the **app**, not this controller.) Roll out on a review app first.
>
> **Validate (#28):** from two distinct client IPs, confirm distinct `clientIpHash` / quota counters — exhaust the quota from one IP, confirm the other is unaffected.

**Existing cluster (no reinstall):** re-apply the same settings as an upgrade. `--reuse-values` preserves the pinned `loadBalancerIP` from the install above; the explicit `controller.config.use-forwarded-headers=false` is required because `--reuse-values` would otherwise silently keep a stale `true` a prior operator may have set — and a `true` value lets nginx trust client-supplied `X-Forwarded-For`, which would let a guest spoof the per-IP quota. It **must** stay `false`.
```bash
# --version: pin to your CURRENTLY-INSTALLED chart (find it with `helm list -n ingress-nginx`,
#   CHART column → ingress-nginx-<X.Y.Z>) so a stale repo cache can't pull a different chart.
# --atomic --timeout: wait for the new controller pods to become Ready and auto-roll-back on
#   failure — important here because externalTrafficPolicy=Local drops traffic to any node
#   without a Ready controller pod, so a half-finished rollout is a partial outage.
helm upgrade ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --reuse-values \
  --version <installed-chart-version> \
  --atomic --timeout 10m \
  --set controller.service.externalTrafficPolicy=Local \
  --set controller.replicaCount=2 \
  --set controller.minAvailable=1 \
  --set controller.config.use-forwarded-headers=false
```

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
>   --set 'hostAliases[0].hostnames[0]=dlectroflow.dev' \
>   --set 'hostAliases[0].hostnames[1]=dlectroflow.dlectronique.dev' \
>   --set 'hostAliases[0].hostnames[2]=work.dlectroflow.dev'
> ```
>
> List **every** host the ingress terminates TLS for — during the domain
> migration (#54) that's both the canonical `dlectroflow.dev` **and** the legacy
> `dlectroflow.dlectronique.dev`, otherwise the legacy `dlectroflow-legacy-tls`
> cert's HTTP-01 self-check times out and never issues. Since #130 that list also
> includes `work.dlectroflow.dev`, this cluster's canonical host.
>
> **`--set` REPLACES the list, it does not append.** Re-running this command with
> fewer hostnames than are currently configured silently drops the missing ones,
> and the certs covering them fail to renew — 30-ish days later, not immediately,
> which is the worst possible feedback loop. Read the live list before changing it:
> ```bash
> kubectl -n cert-manager get deploy cert-manager \
>   -o jsonpath='{.spec.template.spec.hostAliases}'
> ```
>
> **Add the alias BEFORE the ingress starts serving a new host.** If the ingress
> gets there first, the HTTP-01 challenge fails its self-check and cert-manager
> backs off exponentially — the cert then still issues eventually, but long after
> you have fixed the cause and started looking for a different bug.
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
`dlectroflow` A record → `YOUR_STATIC_IP` in dlectronique.dev DNS.

Since #130 this cluster answers on **two** names, both A records to the same
static IP:

| Host | Role |
|---|---|
| `work.dlectroflow.dev` | **canonical** — the value of `host`, and therefore `PUBLIC_ORIGIN`. Sign-in happens here. |
| `dlectroflow.dev` | the apex, served by this cluster **without a redirect** during the overlap, and reserved for the instance that outlives it. |

`host` is the single auth origin: it becomes `PUBLIC_ORIGIN`
(`charts/dlectroflow/templates/deployment.yaml`), which pins the OAuth redirect
URIs against Host / `X-Forwarded-*` spoofing. Two hostnames can be **served**;
only one can complete a sign-in. Changing `host` is therefore an atomic switch,
and it invalidates every existing Google connection — the redirect URI moves with
it, so everyone reconnects. Do it while the user count is small.

Adding a host is four coordinated changes, in this order:

1. **DNS** A record → the ingress static IP (do it first; it propagates while you work)
2. **cert-manager `hostAliases`** — §4, and read the existing list before you `--set` over it
3. **Redirect URIs**, both providers: `…/api/google/oauth/callback` on the Google
   client **and** `…/api/auth/gitlab/callback` on the GitLab OAuth application.
   Forgetting the second breaks *sign-in*, not just Google Tasks.
4. **`host` / `legacyHosts`** in `deploy_production`, then deploy

Rolling back is putting the old `host` back and redeploying.

## 8. Google OAuth redirect
Add to the OAuth client's authorized redirect URIs (keep the local one too):
- `https://dlectroflow.dev/api/google/oauth/callback`
- `http://localhost:3000/api/google/oauth/callback`

After the production deploy, confirm the app builds an **https** redirect URI behind
ingress (Task 3 handles the forwarded-proto derivation):
```bash
curl -s -o /dev/null -D - "https://dlectroflow.dev/api/google/oauth/start" | grep -i '^location:'
```
The `Location:` URL's `redirect_uri=` must be `https%3A%2F%2Fdlectroflow.dev%2F…`.
If it shows `http%3A%2F%2F` or Google returns `redirect_uri_mismatch`, re-check the
ingress `X-Forwarded-Proto` header and Task 3's `requestOrigin`.

## 9. Deploy
- Open an MR → `deploy_review` publishes to `https://mr-<IID>.YOUR-STATIC-IP.sslip.io` (see the MR "View app" button).
  > **sslip.io host format:** use the **dash-separated** IP form (e.g. `mr-<IID>.203-0-113-5.sslip.io` for an ingress IP of `203.0.113.5`), **not** the dotted form. A dotted quad *after* a hyphenated prefix like `mr-1.` makes sslip.io misparse the address (it reads the leading `1` as part of the IP); the dash form resolves correctly. (`203.0.113.5` is a documentation placeholder — substitute your reserved ingress IP.)
- Merge to `main` → `deploy_production` publishes to `https://dlectroflow.dev`.

## 9b. The full lo-fi catalog (optional, off by default)
- Ten CC0 tracks ship inside the image, one per open-lofi category. The full
  open-lofi set is 166 tracks / ~544 MB, too much for a container image, so the
  rest is read at run time from wherever it is kept.
- Extract the `openlofi.zip` release somewhere an HTTP server can reach, then set
  the chart value:
  ```
  --set focus.catalogOrigin=https://your-store.example.com/openlofi
  ```
  It renders as `FOCUS_CATALOG_ORIGIN` in the app Secret, and is omitted entirely
  when empty — the default.
- **The URL never reaches a browser.** `next.config.ts` keeps `default-src 'self'`
  with `media-src` unset, so a browser refuses audio from any other origin; the
  pod fetches the bytes and streams them back through `/api/focus-catalog/audio`,
  forwarding `Range` so seeking works. Any credential the store needs therefore
  stays server-side. Pointing the player at the store directly would need a CSP
  relaxation, which `src/lib/security-headers.test.ts` fails the build over.
- Unset, unreachable or misconfigured, the player uses the bundled ten. A
  misconfigured store is not silent: grep the app logs for
  `focus_catalog_unavailable`, which carries the reason and is emitted once per
  session rather than once per range request.
- Verify from a pod rather than assuming: `kubectl -n dlectroflow-prod exec
  deploy/dlectroflow -- printenv FOCUS_CATALOG_ORIGIN`, then load `/focus` and
  confirm the mini-player lists more than ten tracks.
- Licence/provenance for the streamed set: `public/audio/LICENSE.md`. The app
  validates the shape of what it is served, never the licence of the bytes.

## 10. Cost guardrails
- Confirm the free Autopilot/zonal cluster credit on the billing account.
- Set a GCP budget alert (Billing → Budgets & alerts).
- For what this deploy costs per month — and seven cheaper ways to self-host —
  see [running-costs.md](running-costs.md). The ingress-nginx + cert-manager
  figure there is an **estimate**; if you can read the real invoice line, correct it.

## 11. Verify
- `kubectl -n dlectroflow-prod get pods` → app + postgres Running.
- `curl -I https://dlectroflow.dev` → 200 + valid TLS.
- Google "Connect" completes on the prod host.
- Close the MR → review namespace is deleted.

## 12. Database backups (GCS + optional B2, prod only)

The in-cluster Postgres is a single-replica StatefulSet on one PVC, so a logical
backup is the recovery path (see #21). A daily CronJob dumps the DB to GCS.

**Infra (one-time, already provisioned):**
- Bucket `gs://dlectroflow-db-backups-YOUR_GCP_PROJECT` (europe-west2, uniform access,
  public-access-prevention, **30-day lifecycle auto-delete**).
- GCP service account `dlectroflow-backup@YOUR_GCP_PROJECT.iam.gserviceaccount.com`
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
gcloud storage ls -l gs://dlectroflow-db-backups-YOUR_GCP_PROJECT/pg/ | tail
```

**Run one on demand** (e.g. before a risky migration):
```
kubectl -n dlectroflow-prod create job --from=cronjob/dlectroflow-db-backup manual-backup-$(date +%s)
```

### Second destination: Backblaze B2 (optional, off by default)

The GCS bucket lives in the same cloud project as the cluster it backs up, which
means the backups share a failure domain with the thing they exist to recover.
One deleted project, one revoked credential or one lapsed billing account takes
the database and every copy of it in the same stroke. Keeping a copy with a
second provider is the standard mitigation (3-2-1: at least one copy off the
primary platform), and it matters most here because restoring the database is
the one recovery path with no alternative — the image rebuilds from source, the
data does not.

It is **additive** — GCS keeps running exactly as before, and both uploads write
the same `${STAMP}` filename so the two copies are provably the same dump.

Why it is off by default: GCS uploads keylessly via Workload Identity, while B2
has no equivalent and needs a long-lived application key held as a Kubernetes
Secret. That is a worse credential posture, and it is only worth accepting
because it is additive — the key can be revoked at any moment without losing
the backup.

**Create the key with the narrowest scope that works:** restricted to the one
bucket, **Type of Access: Write Only**, and **File name prefix: `pg/`**.

This was verified against a real key rather than assumed, because the console's
access types do not map obviously onto B2's underlying capabilities:

| Operation | Result |
|---|---|
| Upload to `pg/` | works (needs `--no-check-dest`, see below) |
| List `pg/` | denied |
| Download a dump | **denied** |
| Reach `claude-memory/` | **denied** — the prefix restriction holds |

So a key leaking out of the cluster can add objects under `pg/` and nothing
else. It cannot read a backup, delete one, or see the other prefixes sharing
the bucket. B2 also versions overwritten objects, so it cannot quietly replace
an existing dump.

Two consequences for the job. `rclone copyto` needs `--no-check-dest`, because
its default HEAD on the destination is a read and fails 401 before uploading
anything. And there is no read-back verification: `b2_upload_file` requires an
`X-Bz-Content-Sha1` and rejects a mismatch, so a successful upload is B2
confirming the content hash server-side — stronger than comparing a byte count,
and it needs no extra permission.

Set four CI variables (all **protected + masked**):

| Variable | Value |
|---|---|
| `BACKUP_B2_ENABLED` | `true` |
| `BACKUP_B2_BUCKET` | bucket name, no `b2:` prefix |
| `BACKUP_B2_KEY_ID` | application key ID |
| `BACKUP_B2_APP_KEY` | application key |

`BACKUP_B2_ENABLED` is read at deploy time, so **turning B2 off during an
incident is a variable change plus a redeploy, not a code change.**

The chart refuses to render if `backup.b2.enabled` is true with an empty
bucket, so a half-configured deploy fails at `helm template` rather than
producing a CronJob that uploads nowhere.

**Verify after the next scheduled run:**
```
kubectl -n dlectroflow-prod logs job/<latest> -c upload-b2
rclone ls b2:<bucket>/pg | tail
```
The upload is verified by B2 against the SHA1 rclone sends with it, so a green
`upload-b2` means B2 stored exactly those bytes — not just that the copy
command exited 0.

Because both containers must succeed for the Job to succeed, **a B2 outage
turns the whole backup run red even though GCS succeeded.** That is the
intended trade: a destination silently receiving nothing is the failure this
job exists to prevent, and a red CronJob is the only version of it anyone
notices.

### Restore (into a scratch DB first — never straight over prod)
1. Pull the dump you want:
   ```
   gcloud storage cp gs://dlectroflow-db-backups-YOUR_GCP_PROJECT/pg/dlectroflow-<STAMP>.sql.gz /tmp/
   gunzip /tmp/dlectroflow-<STAMP>.sql.gz
   ```
2. Port-forward prod Postgres and restore into a **scratch** database to inspect:
   ```
   kubectl -n dlectroflow-prod port-forward svc/dlectroflow-postgres 5432:5432 &
   PGPASSWORD=<POSTGRES_PASSWORD> createdb   -h localhost -U dlectroflow restore_check
   PGPASSWORD=<POSTGRES_PASSWORD> psql -h localhost -U dlectroflow -d restore_check -f /tmp/dlectroflow-<STAMP>.sql
   ```
   (`POSTGRES_PASSWORD` is the Secrets Manager value; `kubectl -n dlectroflow-prod get secret dlectroflow-secrets -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d`.)
   > `dlectroflow` is the only DB role and is a **superuser** here — the postgres image makes `POSTGRES_USER` one — so it can `createdb`. There is no separate `postgres` role in this deployment.
3. Only once verified, restore over the live DB during a maintenance window:
   scale the app to 0 (`kubectl -n dlectroflow-prod scale deploy/dlectroflow --replicas=0`),
   `dropdb`/`createdb dlectroflow`, `psql -d dlectroflow -f dump.sql`, scale back up.

- **RPO ≈ 24h** (daily dump). **RTO** = time to pull + restore (minutes at this size).
  Tighten either by raising the schedule frequency.

**Belt-and-braces PD snapshots (set up 2026-07-15, manual GCP config):** the Postgres
PVC's disk also gets a daily GCE snapshot at 03:00 UTC (offset from the 02:00 dump),
14-day retention, snapshots survive disk deletion:
```
gcloud compute resource-policies create snapshot-schedule dlectroflow-pg-daily \
  --project YOUR_GCP_PROJECT --region europe-west2 --max-retention-days 14 \
  --on-source-disk-delete keep-auto-snapshots --daily-schedule --start-time 03:00 \
  --storage-location europe-west2
gcloud compute disks add-resource-policies <PVC_DISK> \
  --project YOUR_GCP_PROJECT --zone europe-west2-a --resource-policies dlectroflow-pg-daily
```
(`<PVC_DISK>` = `kubectl get pv $(kubectl -n dlectroflow-prod get pvc
data-dlectroflow-postgres-0 -o jsonpath='{.spec.volumeName}') -o
jsonpath='{.spec.csi.volumeHandle}'`, last path segment.)
> ⚠️ The policy attaches to the **disk**, not the PVC — if the PVC/PV is ever
> recreated, re-run the `add-resource-policies` step on the new disk. Snapshots are
> crash-consistent (not application-consistent); the pg_dump in this section stays
> the primary restore path, snapshots are the disaster fallback.

## 13. Guest retention purge (prod only)

Guest workspaces are ephemeral by design (#21): each guest session gets an
isolated workspace with a TTL (`GUEST_SANDBOX_TTL_HOURS`, default 24h), and
guest-scoped rate-limit counters (`GuestDailyActivity`, `GuestAiUsage`, keyed
by IP hash, not by workspace) need their own age-based cleanup since they
outlive any single workspace. A daily CronJob purges both.

**What it purges** (`prisma/scheduled-purge.ts` — self-contained so it runs in
the standalone prod image; imports only `@prisma/client`, no app source):
- `purgeExpiredGuests` — deletes `Workspace` rows with `kind: "guest"` and
  `expiresAt` in the past (bounded to 25/call, looped until drained). All
  workspace-scoped rows cascade via FK (Settings, Streak, BrainDumpItem, Task,
  FocusSession, DayRollup, RewardEvent, StreakRecord, Badge, DailySpark;
  Step/BreakdownTurn cascade transitively through Task).
- `purgeStaleGuestCounters` — deletes `GuestDailyActivity`/`GuestAiUsage` rows
  older than **30 days**.

Each run logs one structured JSON line tagged `"scheduled_purge"` with counts
(`guestsPurged`, `dailyActivity`, `aiUsage`) — grep pod/CronJob logs for that
tag to check what a run actually did.

**How it runs:** `charts/dlectroflow/templates/purge-cronjob.yaml` renders
`CronJob dlectroflow-guest-purge` when `purge.enabled` and `env=production`
(both true by default; review apps' ephemeral emptyDir DB is out of scope).
Schedule **03:30 UTC daily** (after the 02:00 UTC DB backup, §12). Single
container, the app image, running `npx tsx prisma/scheduled-purge.ts` against
the same `DATABASE_URL` secret the app uses.

**Check it's healthy:**
```
kubectl -n dlectroflow-prod get cronjob dlectroflow-guest-purge
kubectl -n dlectroflow-prod get jobs -l app.kubernetes.io/name=dlectroflow --sort-by=.metadata.creationTimestamp | tail
kubectl -n dlectroflow-prod logs -l app.kubernetes.io/name=dlectroflow --tail=200 | grep scheduled_purge
```

**Run one on demand** (e.g. to clear a backlog after a TTL/schedule change):
```
kubectl -n dlectroflow-prod create job --from=cronjob/dlectroflow-guest-purge purge-manual-$(date +%s)
```

## 14. Rollback

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

## 15. DB leaked — what to rotate, in what order

If a database copy may have left your control (stolen backup dump, exposed
`POSTGRES_PASSWORD`, compromised pod, suspicious GCS access), work this list
**top to bottom**. Token columns are AES-256-GCM ciphertext (`v1:`, key
`TOKEN_ENC_KEY` lives outside the DB), so a DB copy alone exposes no usable
credentials — the order below assumes the worst anyway.

1. **Cut off the entry point.** Rotate `POSTGRES_PASSWORD` in Secrets Manager,
   redeploy (the secret-checksum annotation rolls the pods), and restart the
   Postgres pod so old credentials die: `kubectl -n dlectroflow-prod rollout
   restart statefulset/dlectroflow-postgres`. If a pod was compromised, also
   rotate everything in `dlectroflow-secrets` — a pod reads env, not just the DB.
2. **Decide whether `TOKEN_ENC_KEY` is also suspect.** DB-only leak → it is not
   (it never touches the DB); ciphertext stays unusable, and steps 3–4 become
   optional hygiene. Pod/cluster/CI leak → treat it as burned: generate a new
   key (`head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'`), update the CI
   variable, then clean-slate the token rows (step 3) — old ciphertext is
   undecryptable under the new key by design (no re-encrypt path).
3. **Google tokens.** In [Google Account → Security → Third-party access],
   remove dlectroflow's grant (kills the refresh token server-side), then
   `DELETE FROM "GoogleAuth";` and reconnect via
   `https://dlectroflow.dev/api/google/oauth/start`.
4. **Reclaim tokens** (only if a `ReclaimAuth` row exists — the write path is
   unused): revoke dlectroflow in Reclaim's connected-apps settings, then
   `DELETE FROM "ReclaimAuth";` — a fresh client re-registers on next connect.
5. **Owner/guest sessions.** DB leak alone does NOT expose `AUTH_SESSION_SECRET`
   or `GUEST_IP_HASH_SALT` (env-only) — rotate them only on pod/CI compromise.
   Rotating logs everyone out (sessions are stateless JWTs).
6. **What's NOT in the DB:** `ANTHROPIC_API_KEY`, `RESEND_API_KEY`,
   `GITLAB_OAUTH_CLIENT_SECRET`, GCS credentials (keyless Workload Identity).
   Rotate at their providers only on pod/CI compromise.
7. **Afterwards:** take a fresh on-demand backup (§12), verify token columns
   show `v1:` ciphertext, and audit GCS bucket access
   (`gcloud logging read 'resource.type="gcs_bucket"' ...`) for reads you
   don't recognise. **That audit depends on §16 being in place** — with
   project-level ingestion off the read answers `SERVICE_DISABLED`, which is
   silent unless you check the exit status.

## 16. Log retention (prod)

**Two independent settings have to agree before a single log line is kept, and
neither one can see the other.**

1. The **cluster** decides what to ship: `loggingConfig` enabling
   `SYSTEM_COMPONENTS` and `WORKLOADS`, with `loggingService` set to
   `logging.googleapis.com/kubernetes`. §1's `create-auto` gives you this.
2. The **project** decides whether anything accepts it: the
   `logging.googleapis.com` service, enabled, with a retention window on the
   bucket the logs land in.

Do only the first and the cluster ships logs to somewhere that will not take
them. Nothing errors, nothing warns, and **there is no retention at all** — an
application log line then exists only in a running pod's buffer, and Autopilot
recycles pods without warning or correlation to anything you did. The dangerous
part is that each setting reads as correct on its own, so the contradiction is
invisible from either end. Do not treat "logging is enabled on the cluster" as
an answer to "are logs being kept".

### Enable it

```bash
gcloud services enable logging.googleapis.com --project=YOUR_GCP_PROJECT
gcloud logging buckets update _Default --location=global --retention-days=30 --project=YOUR_GCP_PROJECT
```

Enabling starts the clock; it does **not** backfill. Everything before this
point is gone, and the first minutes after it hold nothing either — so generate
some traffic and wait before believing any check.

### Then prove it from the artefact

```bash
LOG_PROJECT=YOUR_GCP_PROJECT bash scripts/check-log-retention.sh
```

`scripts/check-log-retention.sh` **reads a log line back out**. It deliberately
refuses to ask whether the API shows as enabled, because a status field can read
correct while nothing is being kept — this project has been caught more than
once by a green signal that meant nothing had been looked at. Exit codes follow
`check-prod-drift.sh` — `0` retained, `1` proven not retained, `2` undetermined.
**`2` is not a pass.** A successful query returning zero entries is reported as
`1`, not `0`.

Add `LOG_CLUSTER=dlectroflow LOG_CLUSTER_LOCATION=europe-west2` to have it read
the cluster's `loggingConfig` too, so a failure report names the *contradiction*
rather than only the symptom. Without that, a reader who is told "no logs" goes
to the cluster config, finds it correct, and stops.

> **A quiet instance can fail the namespace line honestly.** The app writes on
> startup and on errors, not per request, so on a low-traffic day there may be
> nothing from `dlectroflow-prod` inside the default one-hour window even though
> ingestion is working — the project-wide line above it will be a ✅ while the
> namespace line is a 🔴, which is the pair telling you which of the two it is.
> Give it something to say (`kubectl -n dlectroflow-prod rollout restart
> deployment/dlectroflow`, or widen the window with `LOG_FRESHNESS=24h`) rather
> than treating the empty read as noise.

The weekly `ops_digest` job calls the same script and publishes its verdict. It
reports `⚠️ undetermined` there, and that is honest rather than broken: that job
runs on `alpine` and authenticates to the cluster through the GitLab Kubernetes
agent, so it holds no Google Cloud credential and cannot see project-level
state. Until then the digest's job is to keep the gap visible instead of silent.

To make that line answerable, the job needs a **read-only** identity holding
`roles/logging.viewer` (the read-back) and
`roles/serviceusage.serviceUsageViewer` (the API-state line), plus `gcloud` on
the image. Nothing the script runs is a write, so nothing beyond those two roles
is warranted — and a credential wide enough to *fix* the problem would let a
scheduled job change production, which is the opposite of what a check is for.

### Why 30 days, and not a number picked by default

- 30 days is the `_Default` bucket's own default, and a bucket's default
  retention is the longest window whose storage is not separately billed.
  Extending past it adds a per-GiB-month charge on top of the ingestion charge
  that is already unavoidable, so a longer window is a recurring cost decision
  and a shorter one saves nothing.
- It has to outlast the loop it exists to close: the gap between a production
  event happening and someone asking about it. The signal that reports
  production problems here is a **weekly** digest, so any window shorter than a
  fortnight can lose an incident between two reports. 30 days covers four.
- Longer retention buys trend analysis and audit history, which belong to the
  durable alerting story — error rate, restart loops, `tag:"llm_failure"` —
  tracked separately in #157. Retention is that work's prerequisite, not a
  cheaper version of it, so the window is sized for diagnosis rather than for
  analysis it is not going to be used for.
- **If ingestion volume ever becomes the problem, the lever is an exclusion
  filter on `_Default`, not a shorter window.** Dropping health-check and
  static-asset lines cuts volume without costing you the lines an incident needs.

### What this does not give you

Retention, not alerting. Nothing here watches the logs — `/api/livez`'s
in-memory `llmFailureCount` still resets on every pod recycle, and the only
alert policy is a binary uptime check. That is deliberate and the reasoning is
in #157.

## 17. Container registry — measure it, don't quote it (#113)

Every number about this registry is stale within a pipeline: CI pushes a tag per
build. #113 was diagnosed four times; the first was right and each later round
re-argued it from whatever figure was last written down. So this section records
**commands, not numbers** — and dates the few numbers it cannot avoid.

### The one command

```
bash scripts/check-registry-drain.sh
```

Read-only. Prints the policy's configuration, per-repository tag counts and
cleanup status, the age of the oldest tag the policy owns, and a verdict. Exits
`0` draining / `1` not draining / `2` undetermined — and `2` is a distinct state
because "could not read the registry" must never be filed as "the registry is
fine". It also runs in the weekly `ops_digest` job, so the answer arrives without
anyone asking.

### Why the obvious signals are all wrong

Worth knowing before reaching for one of them in an incident:

| Signal | Why it misleads |
|---|---|
| Total tag count | Moved by GitLab's policy, by `prune_registry` (#114) and by manual passes, while CI pushes against all three. Attributes nothing. |
| Bare-SHA count falling | It will not fall. Measured 2026-08-04, ~46 pushes/day against a 7-day horizon settles near 400 **when the policy is working correctly** — re-derive both numbers before using them, they move with merge rate. |
| `next_run_at` advancing | On gitlab.com the cadence is an earliest-start, not a schedule. Measured 2026-08-04: ~20h overdue while the tags proved the last run had drained exactly. |
| `main-*` growing | The keep pattern retains those **forever** by design. That is #114's job to bound, not the policy's. |

The one signal that does work is the **age of the oldest tag the policy owns** —
immune to push rate, to #114, and to scheduler lag. That is what the script
asserts.

### Reading it by hand

If you need the raw facts rather than the verdict:

```
glab api projects/84020916 \
  | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)['container_expiration_policy'],indent=2))"
```

GitLab's own view of whether the last run finished — the field that went
unqueried for a week while the policy was assumed stalled. `UNFINISHED` means
"partially executed, tags remaining"; `UNSCHEDULED` is the default resting state:

```
printf '%s' '{"query":"{ project(fullPath: \"gl-demo-ultimate-dtop/domi-oss/dlectroflow\") { containerRepositories { nodes { path tagsCount expirationPolicyCleanupStatus expirationPolicyStartedAt } } } }"}' > /tmp/q.json
glab api graphql --input /tmp/q.json -H "Content-Type: application/json" -X POST
```

**Trap when listing tags yourself:** the REST endpoint returns them
**alphabetically**, so a paginator that stops early never reaches `m` and
concludes there are no `main-*` tags at all. And GitLab's GraphQL
`containerRepository.tags` connection caps a page at 20 while deriving
`hasNextPage` from what you *asked* for — measured 2026-08-04, `first: 100`
stops after 5 pages with 99 of 421 tags and a confident `hasNextPage: false`.
Request `first: 20`, page to exhaustion, and cross-check the total you collected
against `tagsCount` or the REST `X-Total` header:

```
glab api --method GET "projects/84020916/registry/repositories/11826214/tags?per_page=1" -i \
  | grep -i '^x-total:'
```

### Deleting tags

Nothing here deletes. `scripts/prune-registry.sh` is the only thing in this repo
that does, it ships as a dry run, and it needs a credential the CI job does not
have — read its header before changing anything about it.
