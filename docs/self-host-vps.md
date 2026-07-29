# Self-hosting dlectroflow on one small server

_Last verified: 2026-07-28._

This is the cheapest honest way to run dlectroflow 24/7 on your own domain:
**one small VPS, around $6/month**, with automatic HTTPS. It is the option
`docs/running-costs.md` recommends, and this page is the walkthrough for it.

You get: your own instance at your own domain, valid auto-renewing HTTPS,
Postgres, a nightly backup and a nightly guest-data purge.

You do not get what the Kubernetes chart gives you: high availability (this is one
machine — a reboot is downtime), a preview environment per merge request, or
off-host backups (you have to add that last one yourself; see
[Backups](#backups)).

**What has actually been tested:** the whole stack was stood up end-to-end on a
developer machine — migrations, owner seeding, the app serving through Caddy,
the purge job and the backup job all verified. What has **not** been tested is a
real Let's Encrypt certificate being issued against a public domain, because that
needs public DNS and port 80. Everything up to that point is known to work; if
you hit a certificate problem, [Troubleshooting](#troubleshooting) is the place to
start, and a merge request improving this page is very welcome.

---

## Before you start

- **A server.** 2 vCPU / 4 GB is comfortable; 2 GB works. The app image is
  207 MB, the running app uses 200–400 MB, and Postgres wants a couple of hundred
  more. **Do not build the image on a 2 GB box** — the Next.js build needs more
  memory than that. Either take a 4 GB box for the build, or build elsewhere.
- **Docker with the Compose plugin.** On a fresh Debian/Ubuntu host:
  `curl -fsSL https://get.docker.com | sh`
- **A domain**, with an `A` (and ideally `AAAA`) record pointing at the server's
  IP. Ports 80 and 443 must be reachable from the internet — Let's Encrypt
  validates over port 80.
- **A GitLab account**, to create the OAuth application you sign in with.
- **An Anthropic API key**, or a model you run yourself. See
  [the model section](#the-ai-model) below.

---

## 1. Get the code

```bash
git clone https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow.git
cd dlectroflow
```

## 2. Build the image

The project's container registry is currently **private**, so the published image
cannot be pulled anonymously. Build it yourself:

```bash
docker compose -f docker-compose.prod.yml build
```

That produces `dlectroflow:local`, which the stack uses by default. It takes a few
minutes and needs more than 2 GB of RAM.

If you have registry access and would rather skip the build, run
`docker login registry.gitlab.com` and set `DLECTROFLOW_IMAGE` in your
environment file to a published tag instead.

> **The published tags are currently larger than a local build.** `latest` and
> `v0.4.0` are the same image, and it is **~892 MB** — the release was tagged
> hours before the change that took the runtime image down to ~207 MB (#71), so
> it predates the shrink. Production runs the small one; the newest _release_
> does not. Pulling therefore costs about four times the disk of building, which
> is the wrong trade on the small box this guide recommends, so prefer the build
> above for now.
>
> This corrects itself at the next release, whose tag pipeline builds
> post-shrink and moves `latest` to it. **Removing this note is tracked as part
> of #113** — it is deliberately time-limited, and once `latest` is the small
> image this paragraph would mislead in the opposite direction.
>
> To check a tag's size before pulling: the project's **Deploy → Container
> Registry** page lists every tag with its size, which needs no tooling. From
> the command line it takes two calls, because the repository listing does not
> include sizes — only the per-tag endpoint does:
>
> ```bash
> PROJ=gl-demo-ultimate-dtop%2Fdomi-oss%2Fdlectroflow
>
> # 1. find the repository id
> glab api "projects/$PROJ/registry/repositories" | jq -r '.[] | "\(.id)\t\(.path)"'
>
> # 2. read one tag's size (substitute the id from above)
> glab api "projects/$PROJ/registry/repositories/11826214/tags/latest" \
>   | jq -r '"\(.name)  \(.total_size / 1048576 | round) MiB"'
> # latest  851 MiB
> ```
>
> `docker manifest inspect` can also do it, but it needs a registry login and
> reports each layer separately, leaving you to add them up.

## 3. Create your environment file

```bash
cp .env.prod.example .env.prod
chmod 600 .env.prod
```

Now open `.env.prod` and fill in every value marked REQUIRED. The four secrets
can be generated right now:

```bash
openssl rand -base64 48   # AUTH_SESSION_SECRET
openssl rand -hex 24      # POSTGRES_PASSWORD
openssl rand -hex 16      # GUEST_IP_HASH_SALT
openssl rand -hex 32      # TOKEN_ENC_KEY  (must be exactly 64 hex chars)
```

**The GitLab OAuth application** — in GitLab: Settings → Applications → Add new
application.

- Redirect URI: `https://YOUR-DOMAIN/api/auth/gitlab/callback`
- Scope: `read_user` and nothing else. The app only needs to know who you are.
- Copy the application id and secret into `GITLAB_OAUTH_CLIENT_ID` and
  `GITLAB_OAUTH_CLIENT_SECRET`.

**`OWNER_ALLOWLIST`** is who is allowed to sign in. Sign-in is invite-only: an
OAuth identity only becomes an account if it matches this list, and everyone else
gets a throwaway guest sandbox. Your GitLab **numeric user id** is the most robust
value, because a username can be changed by whoever holds it:

```bash
curl -s "https://gitlab.com/api/v4/users?username=YOUR_USERNAME" | head -c 200
```

**`PUBLIC_ORIGIN`** must be the `https://` form of your domain with no trailing
slash. The app pins OAuth redirects and the Secure cookie flag to it, so a
spoofed `Host` header cannot hijack a sign-in.

### The AI model

Either the hosted Claude API — `LLM_PROVIDER=anthropic` plus an
`ANTHROPIC_API_KEY` from [console.anthropic.com](https://console.anthropic.com),
costing roughly $0.005 per breakdown on Haiku, $0.025 on Sonnet, $0.05 on Opus —
or a model you run yourself with `LLM_PROVIDER=openai-compatible`, which costs
nothing but electricity.

> ⚠️ The self-hosted-model path is unit-tested only. Nobody has yet run it against
> a real non-Anthropic endpoint, so treat it as experimental.

## 4. Start it

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

**That `--env-file .env.prod` is not optional, and it is the single easiest thing
to get wrong.** Compose reads `env_file:` entries only to build a *container's*
environment; the `${VAR}` references inside `docker-compose.prod.yml` itself are
resolved from your shell or from `.env`. Without the flag, the database
credentials come out blank. Every command on this page therefore carries it.

If you would rather not type it each time, on Compose 2.24 and newer you can
`export COMPOSE_ENV_FILES=.env.prod` instead.

Starting takes a minute or two on first run. The order is enforced for you:

```
db (healthy) → migrate → seed-allowlist → app → caddy
```

`migrate` applies database migrations, because the app image deliberately does
not do that on start. `seed-allowlist` writes your owner invitation — without it
you would be locked out of your own invite-only instance.

## 5. Check it worked

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml ps -a
```

`db`, `app` and `caddy` should be `running` (with `db` and `app` healthy), and
`migrate` and `seed-allowlist` should show `exited (0)` — they are one-shot jobs,
so that is success, not failure.

```bash
curl https://YOUR-DOMAIN/api/health     # {"status":"ok"}
```

`/api/health` runs a real query against Postgres, so `ok` means the app can
genuinely serve rather than merely that Node started. Then open your domain in a
browser and sign in with GitLab.

---

## Backups

The stack ships a backup job. Compose has no scheduler, so the host's cron runs
it. `crontab -e` and add:

```cron
# Nightly database dump at 02:00, keeping the last 14 in ./backups
0 2 * * * cd /path/to/dlectroflow && docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm backup >> /var/log/dlectroflow-backup.log 2>&1

# Nightly guest-data purge at 03:30
30 3 * * * cd /path/to/dlectroflow && docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm purge >> /var/log/dlectroflow-purge.log 2>&1
```

> **A dump that only exists on the machine you are protecting is not a backup.**
> The job writes to `./backups` on the host and prunes to the newest 14. Getting a
> copy somewhere else is the part it cannot do for you — add `rclone`, `restic`,
> `rsync` to another host, or your provider's snapshots. Backblaze B2 gives you
> 10 GB free, which is far more than these dumps need.

**To restore**, decompress into `psql`. Do this into a scratch database first and
confirm it looks right before going anywhere near your live one:

```bash
gunzip -c backups/dlectroflow-YYYYMMDDTHHMMSSZ.sql.gz \
  | docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T db \
    psql -U dlectroflow -d dlectroflow
```

The dumps are taken with `--clean --if-exists`, so they can be restored over an
existing schema.

---

## Upgrading

```bash
git pull
docker compose -f docker-compose.prod.yml build
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

`migrate` runs again automatically and applies any new migrations before the new
app container starts. **Upgrade one minor version at a time** and read
`CHANGELOG.md` first — it calls out breaking changes and any newly required
environment variables. Downgrades are not supported.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Blank database credentials, or `required variable POSTGRES_USER is missing` | You left off `--env-file .env.prod`. See [step 4](#4-start-it). |
| `caddy` restarting in a loop, nothing served, no obvious network fault | Check `docker compose logs caddy`. A Caddyfile syntax error looks like a connectivity problem from outside. Most likely an `email` line with no value — Caddy rejects that. |
| You edited the `Caddyfile` and Caddy still uses the old config | Editors replace the file rather than writing in place, and the container keeps the old one. Recreate it: `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --force-recreate caddy`. A plain `restart` is not enough. |
| No certificate issued | Let's Encrypt must reach port 80 on this host for the domain in `DLECTROFLOW_DOMAIN`. Check DNS actually resolves to this server, that ports 80 and 443 are open in both the host firewall and your provider's, and that nothing else already holds port 80. |
| `app` exits with `refusing to boot with data reachable. Missing: …` | Working as designed — the app will not start half-configured. It names exactly which variables are missing or too short; fill them in and `up -d` again. |
| `migrate` exited non-zero | Read `docker compose logs migrate`. The app will not start until migrations succeed, which is deliberate. |
| Sign-in says you are not invited | `OWNER_ALLOWLIST` did not match your identity. Numeric GitLab id is the most reliable value. Fix it, then re-run the seed: `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --force-recreate seed-allowlist`. |
| It took over a database container you were using for local development | The dev stack in `docker-compose.yml` and this one use different Compose project names (`dlectroflow` vs `dlectroflow-prod`) precisely to avoid that. If you see it, you are probably running an older copy of this file. |

Useful commands:

```bash
# Logs, following
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f app

# A psql shell
docker compose --env-file .env.prod -f docker-compose.prod.yml exec db psql -U dlectroflow -d dlectroflow

# Stop everything (data survives — it lives in named volumes)
docker compose --env-file .env.prod -f docker-compose.prod.yml down
```

> `down -v` also deletes the volumes, which means **your database and your issued
> certificates**. There is no undo.

---

## What this leaves out

Deliberately, to keep it one cheap machine:

- **High availability.** One app container on one host. The Kubernetes chart in
  `charts/dlectroflow/` runs two replicas with a PodDisruptionBudget and spreads
  them across nodes; see `docs/running-costs.md` options 7 and 8 if you want that.
- **Per-IP rate limiting.** The Kubernetes Ingress caps requests per IP; Caddy's
  rate limiter is a plugin that is not in the base image. The app's own guest AI
  quotas still cap the expensive path. Cloudflare's free tier in front is the
  easy fix.
- **Off-host backups.** See [Backups](#backups).

For what each alternative costs and what it buys, see
[docs/running-costs.md](running-costs.md).
