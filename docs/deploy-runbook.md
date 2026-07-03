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
