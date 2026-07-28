# dlectroflow — What it costs to self-host

_Last checked: 2026-07-28._

This guide exists because "self-hostable" is a claim, not an answer. Below are
eight concrete ways to run dlectroflow, cheapest first, with every tool named and
explained, and honest line-item costs.

> **None of these setups except the last one has been tested by the maintainers.**
> Option 8 is what [dlectroflow.dev](https://dlectroflow.dev) actually runs on and
> is verified in production. Options 1–7 are worked examples, built from each
> provider's published prices and this project's real resource footprint, offered
> because self-hosters arrive with wildly different budgets, skills and hardware.
> They are a starting point to adapt, not a tested recipe to follow blindly.
>
> **If you run dlectroflow somewhere, please tell us what it actually cost.** A
> merge request correcting a number, or adding a setup that isn't here, is the
> most useful contribution this page can get — see [Contributing your setup](#contributing-your-setup).

All prices are **provider list prices in USD per month** unless noted, and they
move: Hetzner raised cloud prices in June 2026 and Fly.io removed its free tier,
both within a few months of this being written. Check before committing money.

Every option below targets the same outcome, so they are comparable:

- a public URL on your own domain, with valid HTTPS
- PostgreSQL with an 8 Gi volume
- a nightly database backup stored somewhere other than the machine running the app

---

## Summary

| Option | Roughly | Best when |
|---|---|---|
| [1. Hardware you already own](#1-hardware-you-already-own--03mo) | **$0–3** | You have a spare machine and want to pay nothing |
| [2. One small VPS + Docker Compose](#2-one-small-rented-vps-with-docker-compose--6mo) | **$6** | Cheapest honest always-on public site |
| [3. VPS + self-hosted platform](#3-one-vps-running-a-self-hosted-platform-coolify-or-dokploy--6mo) | **$6** | You want a deploy dashboard, not a terminal |
| [4. k3s on one VPS + this repo's chart](#4-lightweight-kubernetes-k3s-on-one-vps-running-this-repos-helm-chart--912mo) | **$9–12** | Run the project's real deployment, cheaply |
| [5. Fly.io](#5-flyio--10mo) | **$10** | Hosted platform, nice CLI, own your database |
| [6. Render](#6-render--14mo) | **$14** | Least work of anything here |
| [7. Managed Kubernetes (DigitalOcean / Civo)](#7-managed-kubernetes-on-digitalocean-or-civo-running-this-repos-helm-chart--36mo) | **$36** | Real redundancy without Google pricing |
| [8. GKE Autopilot — as shipped](#8-google-kubernetes-engine-autopilot--this-projects-production-deployment-as-shipped--105145mo) | **$105–145** | What production runs; zero infra work |

Add to any of them: a domain (~$10–15/**year**) and the AI model cost
(**$0–15/month**, see [What every option also costs](#what-every-option-also-costs)).

---

## 1. Hardware you already own — ~$0–3/mo

**Who it's for:** you want to run it for yourself, you have a spare machine, and
you'd rather pay nothing.

**The pieces:**

- **Docker** — free, open-source software that runs applications in isolated
  "containers", so you don't install Node.js or Postgres directly onto the
  machine. [docker.com](https://www.docker.com) · **Docker Compose** ships with
  it: a single `docker-compose.yml` file describes several containers and
  `docker compose up` starts them together.
- **The dlectroflow image** — the app, prebuilt as a container from this repo's
  [Dockerfile](../Dockerfile) and published by CI, so you download it rather than
  compiling anything.
- **PostgreSQL** — free, open-source database. You run the official `postgres:16`
  container image. [postgresql.org](https://www.postgresql.org)
- **Caddy** — free, open-source web server that sits in front of the app and
  obtains plus auto-renews HTTPS certificates with almost no configuration.
  [caddyserver.com](https://caddyserver.com)
- **Let's Encrypt** — the free, non-profit certificate authority Caddy gets those
  certificates from. No account, no payment. [letsencrypt.org](https://letsencrypt.org)
- **Cloudflare Tunnel** (alternative to Caddy plus port-forwarding) — free
  service where your machine dials *outward* to Cloudflare, making the app
  publicly reachable without opening any ports or holding a fixed IP address.
  [cloudflare.com/products/tunnel](https://www.cloudflare.com/products/tunnel/)
- **Tailscale** — free for personal use; a private network so that only your own
  devices can reach the app. Pick this instead if you don't want it public at all.
  [tailscale.com](https://tailscale.com)
- **`pg_dump`** — the backup tool bundled with Postgres, free. Run it on a
  schedule with `cron`, built into Linux and macOS.
- **Backblaze B2** — cheap object storage to keep those dumps off the machine.
  First 10 GB free, then about $6 per TB per month.
  [backblaze.com/cloud-storage](https://www.backblaze.com/cloud-storage)
- **DuckDNS** — free dynamic-DNS service that keeps a hostname pointed at your
  home IP address when your ISP changes it. [duckdns.org](https://duckdns.org)

**The bill:** electricity only. A mini PC idling around 10 W is roughly
7 kWh/month — about $2–3 (£2 at UK rates; electricity price varies more by
country than anything else in this guide). Add ~$12/year if you want a real domain
instead of a free DuckDNS hostname.

**You get:** total control, no vendor, no recurring cloud bill, as much disk as
the machine has.

**You lose:** uptime is your ISP plus your hardware plus your power. No
redundancy, and no rollback beyond snapshots you take yourself.

**Watch out:** many ISPs use CGNAT, which makes port-forwarding impossible no
matter what you configure — Cloudflare Tunnel or Tailscale is then your only
route in. Download the prebuilt image rather than building it on the machine;
the Next.js build step is memory-hungry.

---

## 2. One small rented VPS with Docker Compose — ~$6/mo

**Who it's for:** you want a real, always-on public site at the lowest honest
price, and you're comfortable in a terminal. **If you're unsure which option to
pick, pick this one.**

**The pieces:**

- **A VPS** — a "virtual private server", i.e. a rented Linux machine you get
  root on. 2 vCPU / 4 GB is plenty. **Hetzner Cloud** is the cheapest reputable
  option at roughly €5.50–6/month ([hetzner.com/cloud](https://www.hetzner.com/cloud/));
  **DigitalOcean**, **Vultr**, **Scaleway** and **OVH** are equivalent at $5–12.
- **Docker + Docker Compose** — free, open source. Docker runs each piece as an
  isolated container; Compose describes them all in one `docker-compose.yml` and
  starts them with `docker compose up -d`. [docker.com](https://www.docker.com)
- **The dlectroflow image** — prebuilt from this repo's [Dockerfile](../Dockerfile)
  and published by CI, so you pull it rather than building it.
- **PostgreSQL** — free, open-source database; the official `postgres:16` image
  with a named Docker volume so data survives restarts.
  [postgresql.org](https://www.postgresql.org)
- **Caddy** — free, open-source reverse proxy. It terminates HTTPS and forwards
  requests to the app on port 3000, fetching and renewing certificates from
  **Let's Encrypt** (free, non-profit) automatically. This is why this option
  needs no separate certificate tooling at all.
  [caddyserver.com](https://caddyserver.com)
- **`pg_dump` + `cron`** — both free and already on the box; a one-line cron job
  dumps the database nightly and uploads it.
- **Backblaze B2** — object storage for those dumps; 10 GB free, then ~$6/TB/month.
  [backblaze.com/cloud-storage](https://www.backblaze.com/cloud-storage)
- **A domain** — any registrar. Cloudflare and Porkbun sell near cost, roughly
  $10–15/year.

**The bill:** VPS ~$6 + B2 ~$0.10 for a few hundred MB + domain ~$12/year.

**You get:** a genuine 24/7 public URL with valid TLS, root access, a flat
predictable price, and deploys that are two commands:
`docker compose pull && docker compose up -d`.

**You lose:** high availability — a reboot or a bad deploy is visible downtime.
No temporary preview environment per merge request. The scheduled database
backup and the nightly guest-data purge become cron jobs you write and monitor
yourself.

**Watch out:** the app image is 207 MB and the running app uses 200–400 MB, plus
Postgres — so 2 GB technically works, 4 GB is comfortable, and you should never
run the *build* on a 2 GB box. Check whether this project's container registry
image is publicly pullable; if not, you'll need registry credentials.

> **This one is ready to copy.** The repo ships
> [docker-compose.prod.yml](../docker-compose.prod.yml), a
> [Caddyfile](../Caddyfile) and [.env.prod.example](../.env.prod.example) for
> exactly this setup, with a step-by-step walkthrough in
> **[docs/self-host-vps.md](self-host-vps.md)** — including the nightly backup and
> guest-purge cron lines, how to restore a dump, and how to upgrade. The stack was
> verified end-to-end (migrations, owner seeding, app serving through Caddy, both
> scheduled jobs); the one part not yet exercised on a real public domain is
> Let's Encrypt issuing the certificate.

---

## 3. One VPS running a self-hosted platform (Coolify or Dokploy) — ~$6/mo

**Who it's for:** you want VPS prices but a click-and-deploy web interface rather
than typing Docker commands.

**The pieces:**

- **A VPS** — a rented Linux machine; take the 4 GB tier here. **Hetzner Cloud**
  ~€6/month ([hetzner.com/cloud](https://www.hetzner.com/cloud/)), or
  DigitalOcean / Vultr / Scaleway at $6–12.
- **Coolify** — free and open source, self-hosted; effectively "your own Heroku".
  One install script on the VPS, then you manage everything through a web
  dashboard: define services, deploy on git push, roll back, read logs, schedule
  database backups. A paid hosted version exists but is unnecessary here.
  [coolify.io](https://coolify.io)
- **Dokploy** — free, open-source alternative to Coolify with the same idea and a
  lighter footprint. Pick whichever interface you prefer.
  [dokploy.com](https://dokploy.com)
- **The dlectroflow image** — prebuilt from this repo's [Dockerfile](../Dockerfile);
  you paste the image name into the dashboard as one service.
- **PostgreSQL** — free, open source. The platform provisions a Postgres 16
  database as a second service, with a persistent volume, from a dropdown.
  [postgresql.org](https://www.postgresql.org)
- **Traefik** — free, open-source reverse proxy that Coolify installs and
  configures for you behind the scenes; it terminates HTTPS using free
  certificates from **Let's Encrypt**. You never touch it directly.
  [traefik.io](https://traefik.io)
- **Backblaze B2 or any S3-compatible bucket** — the dashboard can push its
  scheduled database dumps straight there; 10 GB free on B2.
  [backblaze.com/cloud-storage](https://www.backblaze.com/cloud-storage)

**The bill:** VPS ~€6 + optional B2 ~$0.10 + domain ~$12/year.

**You get:** git-push or webhook deploys, one-click rollback, HTTPS handled
invisibly, and backup scheduling plus logs in a UI — most of the comfort of a
paid platform at rented-box prices.

**You lose:** high availability, because it's still a single machine.

**Watch out:** the dashboard itself consumes roughly 1 GB of RAM, so 4 GB is the
realistic floor. That dashboard is internet-facing and is now yours to keep
patched — put a strong password and ideally a VPN or Cloudflare Access in front
of it.

---

## 4. Lightweight Kubernetes (k3s) on one VPS, running this repo's Helm chart — ~$9–12/mo

**Who it's for:** you want to run the project's *real* deployment definition
without rewriting it, and you don't mind learning some Kubernetes.

**The pieces:**

- **A VPS** — rented Linux machine, 4 GB minimum, 8 GB for headroom. **Hetzner
  Cloud** ~$8–12 ([hetzner.com/cloud](https://www.hetzner.com/cloud/)) or
  equivalent.
- **Kubernetes** — free, open-source system for running containers with automatic
  restarts, rolling updates and scheduled jobs. It's what this project's
  production deployment is written for.
- **k3s** — free, open source, from SUSE/Rancher. A single-binary Kubernetes
  distribution light enough for one small server, installed with one command.
  This is what makes Kubernetes viable at $10/month. [k3s.io](https://k3s.io)
- **Helm** — free, open-source package manager for Kubernetes; a "chart" is a
  package. This repo ships one at [charts/dlectroflow/](../charts/dlectroflow/),
  so `helm install` gets you the app Deployment, the Postgres StatefulSet with
  its 8 Gi volume, the Ingress, a PodDisruptionBudget, the daily
  database-backup CronJob and the nightly guest-purge CronJob — all pre-written.
  [helm.sh](https://helm.sh)
- **ingress-nginx** — free, open source, maintained by the Kubernetes project.
  It accepts incoming HTTP traffic and routes it to the right service. This
  chart's Ingress is written for it, including its rate-limiting and
  request-size settings.
  [kubernetes.github.io/ingress-nginx](https://kubernetes.github.io/ingress-nginx/)
- **cert-manager** — free, open-source Kubernetes add-on (a CNCF project) that
  requests and renews HTTPS certificates from **Let's Encrypt** automatically.
  The chart expects a ClusterIssuer named `letsencrypt-prod`.
  [cert-manager.io](https://cert-manager.io)
- **Traefik** — free, open-source reverse proxy that k3s installs **by default**.
  You can use it instead of ingress-nginx, but the chart's ingress class then
  needs overriding. [traefik.io](https://traefik.io)
- **Backblaze B2 or Google Cloud Storage** — where the chart's backup CronJob
  uploads its nightly dump. B2 gives 10 GB free.
  [backblaze.com/cloud-storage](https://www.backblaze.com/cloud-storage)

**The bill:** VPS ~$8–12 + object storage ~$0.10 + domain ~$12/year.

**You get:** the project's actual, already-tuned deployment — both CronJobs, the
health probes, the security context, the resource settings — instead of a
homemade equivalent. Upgrades are `helm upgrade`. See
[deploy-runbook.md](deploy-runbook.md) for how the chart is meant to be operated.

**You lose:** high availability, because one node means `replicas: 2` costs you
memory and buys you nothing. And you now operate Kubernetes, which is a real
learning curve if it's your first time.

**Watch out:** the chart sets `ingressClassName: nginx` and expects cert-manager.
Either install both into k3s, or override the ingress class to k3s's bundled
Traefik and supply certificates another way.

---

## 5. Fly.io — ~$10/mo

**Who it's for:** you want a hosted platform with a good CLI and no server to
patch, and you're willing to run your own database to keep it cheap.

**The pieces:**

- **Fly.io** — a paid commercial platform that runs containers as small,
  fast-booting virtual machines called "Machines", in data centres near your
  users. There is no longer a free tier. [fly.io](https://fly.io)
- **flyctl** — Fly's free, open-source command-line tool. `fly deploy` from this
  repo builds the [Dockerfile](../Dockerfile) and ships it.
- **One app Machine** — `shared-cpu-1x` with 512 MB RAM, roughly $3–4/month,
  running the dlectroflow container.
- **PostgreSQL on a second Machine** — free, open-source database that you run
  yourself as an ordinary container with an attached Fly Volume for storage.
  Volumes cost $0.28 per GB per month, so 8 GB is about $2.24.
- **Fly Managed Postgres** — Fly's fully-managed database, where they handle
  backups and failover. Priced from about **$38/month**, which is more than any
  other option in this entire guide on its own. This one choice makes or breaks
  Fly's cost. [fly.io/docs/mpg](https://fly.io/docs/mpg/)
- **TLS and routing** — included in the platform at no extra cost. Fly issues and
  renews certificates for your custom domain automatically, and there is no
  separate load-balancer charge.
- **Backups** — Fly volume snapshots are included; safer still is `pg_dump` from
  a scheduled Machine to **Backblaze B2** (10 GB free).
  [backblaze.com/cloud-storage](https://www.backblaze.com/cloud-storage)

**The bill:** app Machine ~$3–4 + self-run Postgres Machine and 8 GB volume ≈ $5
+ metered egress + domain ~$12/year.

**You get:** global routing, HTTPS handled for you, optional scale-to-zero so an
idle app costs almost nothing, and a pleasant deploy experience with no server to
maintain.

**You lose:** managed-database convenience, unless you pay roughly four times the
total for it. Running your own Postgres Machine puts backups back in your hands.
Volumes are tied to a single Machine, so real redundancy costs meaningfully more.

**Watch out:** bandwidth is metered, so a traffic spike shows up on the bill —
unlike a flat-rate VPS.

---

## 6. Render — ~$14/mo

**Who it's for:** you want the least possible operational work and will pay a
small premium for it.

**The pieces:**

- **Render** — a paid commercial hosting platform that builds and runs apps from
  a Git repository. Connect the repo, it detects the [Dockerfile](../Dockerfile),
  and it redeploys on every push to the branch you choose.
  [render.com](https://render.com)
- **A Starter web service** — $7/month, 512 MB RAM and 0.5 CPU, running the
  dlectroflow container. Render's free web tier sleeps when idle, which makes a
  focus-timer app unpleasant.
- **Render Postgres, Basic plan** — $7/month for a fully managed PostgreSQL
  database. Render handles the server, upgrades and **daily backups**. There is a
  free database tier, but it is **deleted after 30 days**, so the $7 is
  unavoidable from month two.
- **TLS on your custom domain** — included, issued and renewed automatically by
  Render at no extra cost. Nothing to install or configure.
- **A domain** — any registrar, roughly $10–15/year.

**The bill:** $7 web service + $7 database = $14/month, plus the domain. There is
no third line item — no load balancer, no storage add-on, no certificate tooling.

**You get:** the smallest amount of work of anything in this guide. No server to
patch, no certificates to renew, no backup script to write, nothing to install
locally beyond Git.

**You lose:** control and headroom. 512 MB is workable for a 207 MB image but not
generous, and when something behaves oddly you can't get underneath the platform
to look.

**Watch out:** budget the $7 database from day one rather than starting on the
free tier and being surprised a month later.

---

## 7. Managed Kubernetes on DigitalOcean or Civo, running this repo's Helm chart — ~$36/mo

**Who it's for:** you want the project's real Kubernetes deployment *with*
genuine redundancy, without Google-scale pricing.

**The pieces:**

- **Managed Kubernetes** — the provider runs and upgrades the Kubernetes control
  plane (its brain) for free; you pay only for the worker machines your
  containers run on. **DigitalOcean Kubernetes**
  ([digitalocean.com/products/kubernetes](https://www.digitalocean.com/products/kubernetes))
  and **Civo** ([civo.com](https://www.civo.com)) both work this way; Civo's is
  built on the lightweight k3s distribution.
- **Two worker nodes** — roughly 2 GB each, about $10–12/month per node. Two
  nodes is what makes real high availability possible: if one dies, the app keeps
  serving from the other.
- **A managed load balancer** — the provider's component that receives public
  traffic and spreads it across your nodes. About $10–12/month, flat. This is the
  one unavoidable extra line item.
- **Helm** — free, open-source Kubernetes package manager. This repo's chart at
  [charts/dlectroflow/](../charts/dlectroflow/) installs the app with 2 replicas,
  a **PodDisruptionBudget** (stops both copies being taken down at once during
  maintenance), **topology spread** (places the two copies on different nodes),
  the Postgres StatefulSet with its 8 Gi volume, and both CronJobs.
  [helm.sh](https://helm.sh)
- **ingress-nginx** — free, open source, from the Kubernetes project. Accepts
  incoming HTTP and routes it to your services. You install it once into the
  cluster; the chart's Ingress is written for it.
  [kubernetes.github.io/ingress-nginx](https://kubernetes.github.io/ingress-nginx/)
- **cert-manager** — free, open-source add-on that requests and renews HTTPS
  certificates from **Let's Encrypt** automatically, indefinitely, without you
  intervening. [cert-manager.io](https://cert-manager.io)
- **Block storage** — the provider's persistent disks for the 8 Gi Postgres
  volume, about $1/month at this size.
- **Backblaze B2 or the provider's object storage** — destination for the chart's
  nightly database dump.
  [backblaze.com/cloud-storage](https://www.backblaze.com/cloud-storage)

**The bill:** 2 nodes ≈ $24 + load balancer $10–12 + storage ~$1 + domain
~$12/year ≈ **$36/month**.

**You get:** real high availability across two machines, automatic certificate
renewal, this project's chart running essentially unmodified, and the option to
add per-merge-request preview environments by wiring up your CI.

**You lose:** node upgrades and cluster housekeeping are yours, and the load
balancer bills the same whether you serve ten requests a month or ten million.

**Why this is a third of the Google price for identical files:** you rent whole
machines here, so the ingress and cert-manager components run inside capacity
you've already paid for, instead of being billed individually.

---

## 8. Google Kubernetes Engine Autopilot — this project's production deployment as shipped — ~$105–145/mo

**Who it's for:** this is what [dlectroflow.dev](https://dlectroflow.dev) actually
runs on, and the only option in this guide that has been verified in production.
Choose it if you want zero infrastructure work plus preview environments, and the
price is acceptable.

**The pieces:**

- **Google Kubernetes Engine (GKE), Autopilot mode** — Google's managed
  Kubernetes. "Autopilot" means you never see or manage servers: you declare what
  each container needs and Google provisions capacity invisibly. Paid, billed per
  second. [cloud.google.com/kubernetes-engine](https://cloud.google.com/kubernetes-engine)
- **Helm** — free, open-source Kubernetes package manager; this project's chart
  lives at [charts/dlectroflow/](../charts/dlectroflow/). [helm.sh](https://helm.sh)
- **GitLab CI/CD** — free at this scale. The pipeline in
  [.gitlab-ci.yml](../.gitlab-ci.yml) builds the image, deploys the chart on
  merge, and spins up a throwaway preview environment for every merge request on
  cheap interruptible "spot" capacity.
- **2 app replicas** — 500 millicores of CPU and 512 MiB of memory each, with a
  PodDisruptionBudget and topology spread. **≈ $36/month.**
- **PostgreSQL** — free, open-source database, run inside the cluster as a
  StatefulSet at 250 millicores / 512 MiB on an 8 Gi Google persistent disk.
  **≈ $10/month** for the pod, **~$0.80** for the disk.
- **ingress-nginx** — free, open-source ingress controller; receives public
  traffic and routes it. Free as software, but its pods consume billable
  Autopilot capacity.
  [kubernetes.github.io/ingress-nginx](https://kubernetes.github.io/ingress-nginx/)
- **cert-manager** — free, open-source add-on that issues and renews the
  multi-domain **Let's Encrypt** certificate, including the legacy hostname that
  redirects to the current one. Also free software on billable capacity, and it
  runs as several pods: a controller, a webhook and a cainjector.
  [cert-manager.io](https://cert-manager.io) · Together with ingress-nginx,
  **≈ $40–60/month — see the estimate note below.**
- **A Google Cloud external load balancer** — receives public traffic. Billed at
  $0.025 per hour per forwarding rule = **$18.25/month**, flat.
- **Google Cloud Storage** — paid object storage. The nightly `pg_dump` CronJob
  uploads there and a bucket lifecycle rule handles retention. **~$1/month**
  including egress.
- **A nightly guest-data purge CronJob** — deletes expired guest workspaces.
  Costs essentially nothing.
- **The GKE cluster management fee** — $0.10/hour, about $73/month, **entirely
  cancelled** by Google's free-tier credit of $74.40/month per billing account.
  So this line is genuinely **$0** — confirm the credit is active on your billing
  account (see [deploy-runbook.md](deploy-runbook.md) §10).

**The bill:** roughly **$105–145/month**, itemised above.

> **The $40–60 for ingress-nginx and cert-manager is an estimate, not an invoice
> figure.** It is derived from Autopilot's published per-pod rates and minimums,
> not read off a bill, and it swings the total by about $40 either way. If you run
> this on Autopilot and can read your actual invoice, please
> [send us the real number](#contributing-your-setup).

**You get:** high availability, no machines to manage or patch, certificates that
renew themselves indefinitely, off-cluster nightly backups, automated guest-data
expiry, a live preview environment for every merge request, and a pipeline that
performs the whole deploy on merge.

**You lose:** about $100/month, most of which isn't buying application capacity.

**Why it costs this much:** Autopilot bills per *requested* CPU and memory —
roughly $0.0445 per vCPU-hour, about $32 per vCPU-month — with a hard minimum of
250 millicores and 512 MiB per pod, and a default near 500 millicores / 1 GiB for
any container whose author declared no requests. So the handful of platform pods
you never wrote (the ingress controller, cert-manager's controller, its webhook,
its cainjector) can cost more than dlectroflow itself, and there's no spare node
capacity to absorb them the way there is when you rent whole machines.

**Cheaper without leaving Google:**

- Drop to a single replica — saves ~$18, gives up high availability.
- Replace ingress-nginx and cert-manager with Google's own GCE ingress and
  Google-managed certificates — removes that $40–60 of add-on pods, but means
  rewriting the chart and losing the nginx rate-limiting and request-size
  settings the current Ingress depends on.
- Run k3s yourself on one `e2-small` virtual machine — about $13/month.

---

## What every option also costs

- **A domain** — ~$10–15/year from any registrar. Cloudflare and Porkbun sell
  near cost.
- **The AI breakdown feature needs a model.** Either **Anthropic's Claude API** —
  paid per token, no subscription, key from
  [console.anthropic.com](https://console.anthropic.com) — or a model you run
  yourself.
- **Model you run yourself:** **Ollama** (free, open source,
  [ollama.com](https://ollama.com)), **LM Studio** (free,
  [lmstudio.ai](https://lmstudio.ai)) or **vLLM** (free, open source). Costs
  nothing but electricity. Set `LLM_PROVIDER=openai-compatible`. ⚠️ That path is
  unit-tested only — **nobody has yet run it against a real local model**, so
  treat it as experimental.
- **Email round-ups are optional.** **Resend** has a free tier that covers
  personal use ([resend.com](https://resend.com)). Leave `RESEND_API_KEY` unset
  and the in-app plus desktop round-ups still work.
- **Calendar integration is free.** **Google Tasks** needs only a free Google
  Cloud OAuth client; **Reclaim.ai** is configured entirely on their side and has
  a free tier.
- **Sign-in is not optional.** The production start-up guard refuses to boot
  without a **GitLab OAuth application** (free to create) plus three generated
  secrets: `AUTH_SESSION_SECRET`, `GUEST_IP_HASH_SALT` and `TOKEN_ENC_KEY`.
  Cheapest is never zero-setup.

### What the model actually costs per breakdown

Measured against the real prompt this app sends (roughly 2,000 input tokens: the
coach system prompt, the static app-context block, the tool schema and the
per-request context block).

| Model | Per breakdown | ~5 breakdowns/day, with follow-ups |
|---|---|---|
| Haiku 4.5 (guest default) | ~$0.005 | ~$1–2/month |
| Sonnet 4.6 (owner default) | ~$0.025 | ~$5–8/month |
| Opus 4.8 | ~$0.05 | ~$10–15/month |
| A model you run locally | $0 | $0 (⚠️ untested path) |

Two honest caveats. Chat follow-ups resend the conversation, so a breakdown you
refine over three turns costs roughly two to three times a single-shot one. And
**prompt caching is not enabled yet** — it would trim the repeated input prefix,
but output tokens dominate the bill here, so the saving would be modest.

---

## Contributing your setup

This page is only as good as the numbers in it, and most of them have not been
tested by us. Contributions that would genuinely help, in rough order of value:

1. **Correct a number.** If a price here is wrong or has moved, change it and say
   where the figure came from.
2. **Report a real bill.** Especially the Autopilot ingress-nginx +
   cert-manager estimate in option 8, but any "I ran this and it actually cost
   $X" is valuable.
3. **Add a setup that isn't here.** Oracle Cloud free tier, a Raspberry Pi,
   Hetzner dedicated, AWS Lightsail, Kamal, NixOS, Unraid, a corporate cluster —
   if you got dlectroflow running somewhere, that's worth a section.
4. **Confirm option 2 end to end on a real domain.** The Compose stack now ships
   and is verified locally, but nobody has yet watched Let's Encrypt issue a
   certificate for it on a public host. If you run it, say so — that turns the
   cheapest option from "verified locally" into "verified in the wild".

Open a merge request against this file, or an issue if you'd rather just report
the numbers and let someone else write it up. Please include the date you checked
and the region you're in — prices vary by both. See
[CONTRIBUTING.md](../CONTRIBUTING.md).
