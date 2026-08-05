# Self-hosting dlectroflow on one small server

_Last verified: 2026-08-03._

This is the cheapest honest way to run dlectroflow 24/7 on your own domain:
**one small VPS, around $6/month**, with automatic HTTPS. It is the option
`docs/running-costs.md` recommends, and this page is the walkthrough for it.

You get: your own instance at your own domain, valid auto-renewing HTTPS,
Postgres, a nightly backup that is copied off the host, and a nightly guest-data
purge.

You do not get what the Kubernetes chart gives you: high availability (this is one
machine — a reboot is downtime), a preview environment per merge request, or a
second independent backup destination — the chart writes to two, this writes to
one plus a copy on the host itself (see [Backups](#backups)).

**What has actually been tested:** the whole stack was stood up end-to-end on a
developer machine — migrations, owner seeding, the app serving through Caddy, and
the purge job. The backup path was rehearsed in full on 2026-08-03: a dump taken
by this stack, uploaded to B2, pulled back down, restored into a fresh
digest-pinned `postgres:16.14` under a *different* role name, and compared to the
source per table — row counts and a content hash of every table, all 20 matching.
Both failure guards were made to fire on purpose. What has **not** been tested is
a real Let's Encrypt certificate being issued against a public domain, because
that needs public DNS and port 80. Everything up to that point is known to work;
if you hit a certificate problem, [Troubleshooting](#troubleshooting) is the place
to start, and a merge request improving this page is very welcome.

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
docker build -f docker/Dockerfile \
  --build-arg BUILD_SHA="$(git rev-parse HEAD)" \
  -t dlectroflow:local .
```

That produces `dlectroflow:local`, which the stack uses by default. It takes a few
minutes and needs more than 2 GB of RAM.

`BUILD_SHA` is optional but worth passing. It bakes the commit into the image so
`/api/health` can tell you which one a running container is on — a container
cannot read the tag it was pulled under, so without it the endpoint answers
`"sha": null` and "am I running what I think I'm running?" has no answer. Step 5
uses it.

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
> # 2. read one tag's size. 11826214 is this project's registry id, so step 1
> #    should hand you the same number back — swap it only for a fork.
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

Keep it at the repo root, next to `.env.prod.example` — not beside the compose
file. `docker/docker-compose.prod.yml` reads it as `../.env.prod`.

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

### Google Tasks — the connect flow needs your own OAuth client

**Skip this and "Connect Google" cannot succeed on your instance.** There is no
shared client to fall back on and nothing in the UI explains the absence, so it
reads as a bug rather than as unconfigured. Steps still save locally and export
as `.ics` without it, but the auto-scheduling half of the product does not exist
until `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.

In [Google Cloud Console](https://console.cloud.google.com):

1. Create (or pick) a project, then **APIs & Services → Library → Google Tasks
   API → Enable**. Without this the callback returns `access_not_configured`.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   application type **Web application**.
3. Authorised redirect URI: `https://YOUR-DOMAIN/api/google/oauth/callback` —
   exactly, including the scheme and no trailing slash. Google matches it
   literally.
4. Copy the client id and secret into `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET` in `.env.prod`, uncommenting both lines.

While the OAuth consent screen is in **Testing**, only accounts you add as test
users can connect, and their grant expires after seven days. Add yourself as a
test user; publishing is only needed if other people will use the instance.

`GOOGLE_TASKS_LIST_NAME` defaults to `reclaim`, because Reclaim.ai only
auto-schedules from its own list. Change it if you use a different scheduler, and
see `SCHEDULING_SYNTAX` / `SCHEDULING_TIMEZONE` in `.env.prod.example` if you do
— the default timezone is `Europe/London`.

Stored Google tokens are encrypted with `TOKEN_ENC_KEY`, so rotating that key
means everyone reconnects once.

### The weekly round-up email (optional)

`RESEND_API_KEY` plus `ROUNDUP_FROM_EMAIL` turn on the emailed round-up. The
in-app and desktop round-ups work without them, so this is purely additive.
Resend's free tier is plenty for one instance, and the from-address has to be on
a domain you have verified with them.

### The full lo-fi catalog (optional)

The focus timer always has music: ten CC0 tracks are inside the image, one per
open-lofi category. The full open-lofi set is 166 tracks and about 544 MB, which
is far too much to put in a container image, so the rest is read at run time from
wherever you choose to keep it.

Download the `openlofi.zip` release from
[open-lofi](https://github.com/btahir/open-lofi), extract it somewhere an HTTP
server can reach — object storage with public reads, an nginx container, a MinIO
service on this same Compose network — and point the app at the directory holding
the mp3s and `catalog.json`:

```bash
FOCUS_CATALOG_ORIGIN=http://minio:9000/openlofi
```

**Your browser never opens that URL, which is why plain `http://` on a private
network is fine here.** The app proxies the audio: `next.config.ts` sets
`default-src 'self'` and deliberately leaves `media-src` unset, so a browser will
refuse audio from anywhere but the app itself — a focus session is a long,
unattended, personal page view and makes no third-party request. The bytes are
fetched server-side and streamed back through `/api/focus-catalog/audio`, with
`Range` requests forwarded so seeking still works. If your store needs a
credential, it stays on the server for the same reason.

Leave it unset and you get the bundled ten. Set it wrong, or let the store go
down, and you also get the bundled ten — the timer is never silent because of
this variable. A misconfigured store logs `focus_catalog_unavailable` with the
reason, once per session rather than once per request:

```bash
docker compose --env-file .env.prod -f docker/docker-compose.prod.yml logs app | grep focus_catalog
```

Setting this also turns on **per-category playlists**, with nothing else to
configure. Settings starts offering "Chillhop — whole category" and the rest once
the catalog gives a category more than one track. With only the bundled ten —
one per category — a category playlist would be a second way of saying "this
track", so that part of the picker is absent rather than shown greyed out. If
`/focus` lists more than ten tracks and `/settings` still offers no category,
that is a bug worth reporting, not something to configure.

Licence and provenance for the streamed set are in `public/audio/LICENSE.md`. The
short version: it is the same CC0 1.0 release as the bundled ten, and the app
validates the *shape* of what it is served, never the licence of the bytes — so
what you upload is what your instance plays.

## 4. Start it

```bash
docker compose --env-file .env.prod -f docker/docker-compose.prod.yml up -d
```

**That `--env-file .env.prod` is not optional, and it is the single easiest thing
to get wrong.** Compose reads `env_file:` entries only to build a *container's*
environment; the `${VAR}` references inside `docker/docker-compose.prod.yml` itself are
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
docker compose --env-file .env.prod -f docker/docker-compose.prod.yml ps -a
```

`db`, `app` and `caddy` should be `running` (with `db` and `app` healthy), and
`migrate` and `seed-allowlist` should show `exited (0)` — they are one-shot jobs,
so that is success, not failure.

```bash
curl https://YOUR-DOMAIN/api/health     # {"status":"ok","sha":"cafc16d"}
```

`/api/health` runs a real query against Postgres, so `ok` means the app can
genuinely serve rather than merely that Node started. Then open your domain in a
browser and sign in with GitLab.

`sha` is the short commit the image was built from — the `BUILD_SHA` build arg
from step 2. It is `null` if you built without it. To confirm the running
container is the commit you think it is:

```bash
cd /path/to/dlectroflow
git rev-parse --short HEAD
curl -s https://YOUR-DOMAIN/api/health | grep -o '"sha":"[^"]*"'
```

Those two should agree. If they don't, the container is on an older image —
rebuild and `up -d` again (see [Upgrading](#upgrading)).

---

## Backups

The stack ships a two-stage backup job. Compose has no scheduler, so the host's
cron runs it. `crontab -e` and add:

```cron
# Nightly database dump at 02:00 — dumps, keeps the newest 14 in ./backups, and
# uploads that same dump off this host
0 2 * * * cd /path/to/dlectroflow && docker compose --env-file .env.prod -f docker/docker-compose.prod.yml run --rm backup-upload >> /var/log/dlectroflow-backup.log 2>&1

# Nightly guest-data purge at 03:30
30 3 * * * cd /path/to/dlectroflow && docker compose --env-file .env.prod -f docker/docker-compose.prod.yml run --rm purge >> /var/log/dlectroflow-purge.log 2>&1
```

One line, not two: `backup-upload` declares `backup` as a dependency, and
`docker compose run` re-runs a completed dependency, so each invocation takes a
fresh dump and uploads that one. If you have not set up an off-host destination
yet, use `run --rm backup` instead and read the next section — that variant
writes only to this machine's disk.

### Why the second stage exists

**A backup should not share a failure domain with the thing it backs up.** The
`backup` service alone writes to `./backups` at the repo root on this host (the
compose file mounts it as `../backups`, since the file itself sits in `docker/`)
and prunes to the newest 14. That copy is useful — it is the fastest thing to
restore from — but the one failure a backup exists to survive is losing this
machine, and it does not survive that. The database is also the only thing here
that cannot be rebuilt from source: the code, the image and the config all exist
somewhere else.

So `backup-upload` copies each dump to a Backblaze B2 bucket. Both copies carry
the **same filename**, taken from one timestamp written once per run, so a local
file and a remote object can be matched by name and verified byte for byte.

### Setting up the off-host copy

In [Backblaze](https://www.backblaze.com/cloud-storage) — the free tier is 10 GB
and these dumps are tens of kilobytes each:

1. Create a **private** bucket.
2. Create an **application key** and restrict it: this one bucket, the file-name
   prefix `pg/`, and the `writeFiles` capability **only**.
3. Put the four values in `.env.prod`:

```
B2_BUCKET=your-bucket-name
B2_PREFIX=pg
B2_KEY_ID=...
B2_APP_KEY=...
```

**Write-only is the point, not an oversight.** The two things an attacker wants
from a backup credential are to read your backups out and to delete them, and a
key with `writeFiles` alone can do neither. The cost is that this host cannot
list, download or verify its own backups — so keep a **second, read-capable key
on your own machine** and do that work there. That is where a restore drill
belongs anyway: rehearsing a restore on the machine you are rehearsing losing
proves nothing.

Leave the four values unset if you copy the dumps off some other way (`restic`,
`rsync` to another host, your provider's snapshots). `backup-upload` then refuses
to run and says so, rather than appearing to succeed. Nothing else in the stack
is affected — `up -d` works with none of them set.

### To restore

Do this into a **scratch database** first, and check it before going anywhere
near your live one.

From your own machine, with the read-capable key configured in `rclone`:

```bash
rclone lsl b2:YOUR-BUCKET/pg/ | tail -5
OBJ=$(rclone lsf b2:YOUR-BUCKET/pg/ | sort | tail -1)
rclone copy "b2:YOUR-BUCKET/pg/$OBJ" ./
docker run -d --name pg-restore -e POSTGRES_PASSWORD=scratch postgres:16.14
gunzip -c "$OBJ" | docker exec -i pg-restore psql -U postgres -d postgres -v ON_ERROR_STOP=1
```

Then compare row counts against the live database, per table, before trusting it:

```bash
docker exec pg-restore psql -U postgres -d postgres -At -c "select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name;"
```

Note the role in that restore is `postgres`, not `dlectroflow`. The dumps are
taken with `--no-owner --no-privileges`, so they restore under **any** role name
— which is what makes a rescue host usable — and with `--clean --if-exists`, so
they can also be restored over an existing schema. To go back into the live
database on the host instead:

```bash
gunzip -c backups/dlectroflow-YYYYMMDDTHHMMSSZ.sql.gz \
  | docker compose --env-file .env.prod -f docker/docker-compose.prod.yml exec -T db \
    psql -U dlectroflow -d dlectroflow
```

### What a failed run looks like

Both stages use `set -euo pipefail`, and the dump is only promoted to the name
the uploader reads **after** a minimum-size check. That combination is what stops
a broken backup being kept as if it had worked:

| Failure | What you see |
|---|---|
| `pg_dump` cannot connect or authenticate | Exit 1. Without `pipefail` this exits **0** and leaves a 20-byte `.sql.gz`, because a pipeline's status is the last command's and `gzip` succeeds at compressing nothing. |
| The dump is degenerate or the database is empty | `ERROR: dump suspiciously small (393 bytes)`, exit 1, nothing promoted locally or uploaded. |
| B2 is unreachable, or the key is wrong or revoked | Exit 1 after the local copy has already been written, so the run is loud but you still have a dump. |
| `B2_BUCKET` / `B2_KEY_ID` / `B2_APP_KEY` unset | `ERROR: set B2_BUCKET, B2_KEY_ID and B2_APP_KEY in .env.prod`, exit 1. |

Cron mails you a non-zero exit, so **make sure that mail goes somewhere you
read** — on a single-host stack it is the only signal there is. There is no
status object to query the way Kubernetes has for the chart's CronJob.

A successful run prints the object it wrote and the size, and B2 verifies the
content hash server-side on write (`rclone` sends `X-Bz-Content-Sha1` and B2
rejects a mismatch), so a success line is stronger evidence than a byte count:

```
dump bytes: 18203
wrote /backups/dlectroflow-20260803T101541Z.sql.gz
uploaded b2:your-bucket/pg/dlectroflow-20260803T101541Z.sql.gz (18203 bytes, sha1 verified by B2 on write)
```

> **B2 never deletes these on its own.** Its measured lifecycle is
> `daysFromHidingToDeleting: 90` with `daysFromUploadingToHiding: null`, and that
> 90-day clock only starts once an object is *hidden* — which happens only when a
> new version reuses its name. These names carry a unique timestamp, so nothing
> is ever hidden and nothing is ever deleted. At tens of kilobytes a day that is
> a few megabytes a year; prune from your own machine if it ever matters.

---

## Upgrading

```bash
git pull
docker build -f docker/Dockerfile \
  --build-arg BUILD_SHA="$(git rev-parse HEAD)" \
  -t dlectroflow:local .
docker compose --env-file .env.prod -f docker/docker-compose.prod.yml up -d
curl -s https://YOUR-DOMAIN/api/health
```

`migrate` runs again automatically and applies any new migrations before the new
app container starts. The `curl` is worth keeping: `sha` should now match the
commit you just pulled, which is the one thing that distinguishes "upgraded" from
"restarted the same image". **Upgrade one minor version at a time** and read
`CHANGELOG.md` first — it calls out breaking changes and any newly required
environment variables. Downgrades are not supported.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Blank database credentials, or `required variable POSTGRES_USER is missing` | You left off `--env-file .env.prod`. See [step 4](#4-start-it). |
| `caddy` restarting in a loop, nothing served, no obvious network fault | Check `docker compose logs caddy`. A `docker/Caddyfile` syntax error looks like a connectivity problem from outside. Most likely an `email` line with no value — Caddy rejects that. |
| You edited `docker/Caddyfile` and Caddy still uses the old config | Editors replace the file rather than writing in place, and the container keeps the old one. Recreate it: `docker compose --env-file .env.prod -f docker/docker-compose.prod.yml up -d --force-recreate caddy`. A plain `restart` is not enough. |
| No certificate issued | Let's Encrypt must reach port 80 on this host for the domain in `DLECTROFLOW_DOMAIN`. Check DNS actually resolves to this server, that ports 80 and 443 are open in both the host firewall and your provider's, and that nothing else already holds port 80. |
| `app` exits with `refusing to boot with data reachable. Missing: …` | Working as designed — the app will not start half-configured. It names exactly which variables are missing or too short; fill them in and `up -d` again. |
| `migrate` exited non-zero | Read `docker compose logs migrate`. The app will not start until migrations succeed, which is deliberate. |
| Sign-in says you are not invited | `OWNER_ALLOWLIST` did not match your identity. Numeric GitLab id is the most reliable value. Fix it, then re-run the seed: `docker compose --env-file .env.prod -f docker/docker-compose.prod.yml up -d --force-recreate seed-allowlist`. |
| `backup-upload` exits 1 with `no staged dump — run the backup service first` | Either the dump stage failed (its output is above this line in the same log) or you invoked the uploader with `--no-deps`. The stamp file is written last, so its absence means no good dump was produced — which is the uploader refusing to send yesterday's. |
| `backup-upload` exits 1 with a B2 `401` | The application key is wrong, revoked, or scoped to a different bucket or prefix than `B2_BUCKET`/`B2_PREFIX`. Check it from your own machine with the read-capable key; this host's key deliberately cannot list, so it cannot tell you more. |
| It took over a database container you were using for local development | The dev stack in `docker/docker-compose.yml` and this one use different Compose project names (`dlectroflow` vs `dlectroflow-prod`) precisely to avoid that. If you see it, you are probably running an older copy of this file. |
| Someone says **Connect Google →** "does nothing" — they never return to the app, and your logs show no callback at all | Their Google account is probably managed by an organisation that has not allowlisted your OAuth client. Google refuses at its own consent step (`Error 400: access_not_configured`), so there is no callback to log and no error the app can render. Nothing to fix on this host: see [A managed work account can be blocked by its own administrator](../README.md#a-managed-work-account-can-be-blocked-by-its-own-administrator). A personal Google account is the reliable workaround, and `.ics` export needs no Google account at all. |

Useful commands:

```bash
# Logs, following
docker compose --env-file .env.prod -f docker/docker-compose.prod.yml logs -f app

# A psql shell
docker compose --env-file .env.prod -f docker/docker-compose.prod.yml exec db psql -U dlectroflow -d dlectroflow

# Stop everything (data survives — it lives in named volumes)
docker compose --env-file .env.prod -f docker/docker-compose.prod.yml down
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
- **A second, independent backup destination.** The chart dual-writes to Google
  Cloud Storage (keyless, via Workload Identity) *and* optionally to B2, so
  losing either one still leaves a good backup. Here there is one off-host
  destination plus the host's own copy. See [Backups](#backups).

For what each alternative costs and what it buys, see
[docs/running-costs.md](running-costs.md).
