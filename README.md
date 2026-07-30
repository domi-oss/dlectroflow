# dlectroflow 🧠⚡

[![pipeline status](https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/badges/main/pipeline.svg)](https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/pipelines)

An ADHD helper web app — **capture → clarify → schedule → focus → reward**.

> [!NOTE]
> **Built with AI, run for real.** dlectroflow is developed primarily with AI assistance (Claude Code and GitLab Duo), directed by a human maintainer. It ships with genuine security measures — automated SAST and dependency scanning in CI, encrypted OAuth tokens, TLS hardening, and periodic self-directed security reviews (not formal third-party audits) — but it's a personal project that handles personal data. Review the code and consider self-hosting before trusting it with anything sensitive. Where a feature hasn't been exercised for real, this README says so out loud — no human has yet run the `openai-compatible` [BYO-LLM](#-bring-your-own-llm-byo-llm) adapter against a real non-Anthropic endpoint, for instance. Provided as-is, with no warranty (see [AGPL-3.0](LICENSE)).

**🌐 Try it:** a hosted instance runs at [dlectroflow.dev](https://dlectroflow.dev) — kick the tyres as a guest, no signup.

You brain-dump anything, Claude breaks the scary stuff into tiny do-able steps,
those steps land in Google Tasks and get scheduled onto your real calendar (a
Reclaim-synced list is scheduled automatically), you focus on one at a time, and
you get a hit of dopamine for finishing. Come back tomorrow, repeat.

**🏠 Built to self-host.** The hosted instance above is just a place to try it —
dlectroflow is meant to be run as *your own* instance. See [Quick start](#-quick-start-local-5-minutes)
to run it locally, or [Deploy](#-deploy) to host your own. (Also a learning project, built in the open.)

---

## 📖 Table of contents

- [🚦 Status — what works today](#-status--what-works-today)
- [🧰 Prerequisites](#-prerequisites)
- [🔑 Third-party services](#-third-party-services)
- [🚀 Quick start (local, ~5 minutes)](#-quick-start-local-5-minutes)
- [🔐 Secrets & environment](#-secrets--environment)
- [🤖 Bring your own LLM (BYO-LLM)](#-bring-your-own-llm-byo-llm)
- [📅 Connecting Google Tasks](#-connecting-google-tasks)
- [🎧 Focus music](#-focus-music)
- [🗄️ Database & migrations](#️-database--migrations)
- [🐳 Deploy](#-deploy)
- [💸 What it costs to run](#-what-it-costs-to-run)
- [🧯 Troubleshooting](#-troubleshooting)
- [🗺️ Tech stack](#️-tech-stack)
- [🤝 Contributing](#-contributing)
- [🧭 Roadmap](#-roadmap)
- [🧠 A note for fellow neurodivergent nerds](#-a-note-for-fellow-neurodivergent-nerds)
- [⚖️ Legal & privacy](#️-legal--privacy)

---

## 🚦 Status — what works today

This is **in active development**. Being honest so you don't hit surprises:

| Feature | State |
|---|---|
| 🧠 Brain Dump — capture, triage, aging reminders | ✅ works |
| 🔔 Desktop notifications + demo override | ✅ works |
| ✂️ AI task breakdown (streaming chat) | ✅ works — Claude by default (needs an Anthropic API key) |
| 🤖 Bring your own LLM (`LLM_PROVIDER`) | ⚠️ **partly** — `anthropic` is what runs in production; `openai-compatible` ships but is unit-tested only, and **no human has yet run it against a real non-Anthropic endpoint** (see [BYO-LLM](#-bring-your-own-llm-byo-llm)) |
| 📅 Scheduling (breakdown → Google Tasks) | ✅ works — connect Google from **Settings → Integrations** (or right from a breakdown) and steps land in your Google Tasks list, durations parsed; a Reclaim-synced list is scheduled automatically (see [Connecting Google Tasks](#-connecting-google-tasks)). No Google? Steps save locally and export as `.ics`. |
| ⏱️ Focus timer — true pause/resume, one-number setup screen | ✅ works |
| 🎧 Focus music — 10 bundled CC0 lo-fi tracks, in-session mini-player, shuffle | ✅ works (see [Focus music](#-focus-music)) |
| 🎉 Rewards & streaks + dashboard | ✅ works |
| 🌇 End-of-day round-up (in-app + desktop) | ✅ works |
| ✉️ Round-up **email** (opt-in) | ✅ works when `RESEND_API_KEY` is set; cleanly disabled otherwise |
| 🐳 Postgres + GitLab CI/CD | ✅ **live** — deployed to GKE Autopilot at **[dlectroflow.dev](https://dlectroflow.dev)** (valid TLS) via GitLab CI/CD; every MR gets a review app. Local Postgres via Docker Compose. |

If all you want right now is **capture → Claude breakdown**, that's fully working
and genuinely useful.

---

## 🧰 Prerequisites

You'll need these installed **before** you start. (One-time, ~5 min if you have none.)

- [ ] **Node.js 20.19+** (`package.json` engines). CI, the container and `.nvmrc` all use **22** — that's the version to match if you want an exact fit. Check: `node -v`
  - Don't have it? [nodejs.org](https://nodejs.org) or `brew install node` (macOS) / your package manager. There's a `.nvmrc` if you use [nvm](https://github.com/nvm-sh/nvm) (`nvm use`).
- [ ] **npm** (ships with Node). Check: `npm -v`
- [ ] **Git**. Check: `git --version`
- [ ] **Docker** — [docker.com](https://www.docker.com/) — used to run Postgres locally (and for production containers).

That's it for running locally. Postgres runs via Docker — no manual database server setup required.

---

## 🔑 Third-party services

| Service | Needed for | Required? | Cost |
|---|---|---|---|
| **Anthropic (Claude API)** | The task breakdown chat | ✅ Required — *unless* you switch provider (see [BYO-LLM](#-bring-your-own-llm-byo-llm)) | Pay-as-you-go; a breakdown is a few cents. [console.anthropic.com](https://console.anthropic.com) → **API keys** |
| **Your own model endpoint** | Running breakdowns on a local runner (Ollama, LM Studio, vLLM) or another vendor instead of Claude | Optional — ⚠️ experimental, untested | Free if it's local. Set `LLM_PROVIDER=openai-compatible` — read [BYO-LLM](#-bring-your-own-llm-byo-llm) first. |
| **Google Tasks** | Scheduling steps — connect from **Settings → Integrations** | Optional | Free. Create an OAuth client in [Google Cloud Console](https://console.cloud.google.com/) (see [Connecting Google Tasks](#-connecting-google-tasks)). |
| **Reclaim.ai** | Auto-scheduling your Google Tasks list onto your calendar | Optional | Set up entirely inside Reclaim — its own Google Tasks integration creates a 🗓 Reclaim list, and dlectroflow just writes into that list. Nothing to configure here. [reclaim.ai](https://reclaim.ai) |
| **Resend** | Opt-in end-of-day round-up **email** | Optional | Free tier is plenty. Set `RESEND_API_KEY`, then opt in on the dashboard. In-app + desktop round-up work without it. [resend.com](https://resend.com) |

You can run and demo the whole capture → breakdown flow with **just the Anthropic key**.

For what all of this adds up to per month — hosting included — see
[What it costs to run](#-what-it-costs-to-run).

---

## 🚀 Quick start (local, ~5 minutes)

```bash
# 1. Clone
git clone https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow.git
cd dlectroflow

# 2. Create your env file — copy it as-is, there's nothing to edit
cp .env.example .env

# 3. Start Postgres, install deps + create the database (one command)
npm run setup        # = docker compose up -d db && npm install && prisma migrate dev

# 4. Add your Claude API key (see options below), e.g. for this shell session:
#    (or point the app at a model of your own instead — see "Bring your own LLM")
export ANTHROPIC_API_KEY='sk-ant-...'

# 5. Run it
npm run dev
```

Open **http://localhost:3000** — it redirects to your inbox. Capture a thought,
hit **Break down →**, and watch Claude stream a plan. 🎉

> **Why step 2 comes first:** `npm run setup` ends in `prisma migrate dev`, which
> reads `DATABASE_URL` from **`.env`** — so `.env` has to exist before you run it,
> or setup stops at *"Environment variable not found: DATABASE_URL"*. The copied
> file needs no editing: its `DATABASE_URL` is already the local Compose database
> (`dlectroflow` / `dlectroflow`, matching `docker/docker-compose.yml`), which `npm run setup`
> starts for you. Note it's `.env`, **not** `.env.local` — Prisma only reads the
> former ([which file?](#which-file-env-vs-envlocal)).

> **No key yet?** The app still runs — you just get a friendly error when you try
> a breakdown instead of a plan.

---

## 🔐 Secrets & environment

**Golden rule: no secrets in the repo, ever.** The app only ever reads its model
key from the environment — `process.env.ANTHROPIC_API_KEY`, or
`process.env.LLM_API_KEY` on a [BYO-LLM](#-bring-your-own-llm-byo-llm) deploy — and
it doesn't care *how* the value got there.

**Local dev — pick whichever suits you:**
- **Quickest:** `export ANTHROPIC_API_KEY='sk-ant-...'` in your terminal before `npm run dev`.
- **Persistent:** put it in `.env` (`cp .env.example .env` if you skipped step 2). `.env.local` works for this one too — [which file?](#which-file-env-vs-envlocal). Both are gitignored.

### Which file: `.env` vs `.env.local`

Two filenames are in play and they are **not** interchangeable — this is the one
trap in local setup:

| File | Who reads it | What to put there |
|---|---|---|
| **`.env`** | The **Prisma CLI** (`npm run setup`, `npm run db:migrate`, `npm run db:studio` — via `prisma.config.ts`), `next dev`, **`npm test`** (`vitest.config.ts` forwards `DATABASE_URL` from it) and **`npm run test:e2e`** (`playwright.config.ts` does the same, because the standalone server it boots reads a *build-time copy* of this file — see #97). | **`DATABASE_URL`**, plus anything else you want persisted. A single `.env` is enough to run everything locally — that's what `cp .env.example .env` gives you. |
| **`.env.local`** | **Next.js**, and `npm test` / `npm run test:e2e` for `DATABASE_URL`; it *overrides* `.env`. The **Prisma CLI** never reads it. | Optional. Runtime-only values you'd rather keep out of `.env`. Don't put `DATABASE_URL` *only* here — migrations will fail with *"Environment variable not found: DATABASE_URL"*. |

Both are gitignored. If you only ever create `.env`, nothing is missing.

**CI/CD + production — use a real secrets manager.** This project targets
**GitLab Secrets Manager** (keeps secrets out of both the repo *and* project
settings). In `.gitlab-ci.yml`:

```yaml
job:
  secrets:
    ANTHROPIC_API_KEY:
      gitlab_secrets_manager:
        name: anthropic-api-key
        source: group/your-group   # or a project-level secret
      file: false                   # hand it to the app as an env var
```

Other options GitLab supports: external Vault / cloud KMS via OIDC `id_tokens`,
or (simplest) a masked + protected CI/CD variable.

See [`.env.example`](.env.example) for the full list of variables. Running a model
other than Claude? The `LLM_*` vars are documented in
[Bring your own LLM](#-bring-your-own-llm-byo-llm).

### Phase 2: guest access & AI cost controls

Guest users get a sandboxed AI breakdown experience with built-in guardrails:

- **AI quota:** 5 breakdowns / IP / 24 h; 10 unique guest IPs / day globally (Haiku model — cheaper, still useful).
- **Owner model:** selectable in Settings (defaults to `claude-sonnet-4-6`).
- **`.ics` export:** no integration or OAuth needed — the calendar file is built on request and downloaded.
- **Dark mode:** persists via `localStorage`; no backend required.

New env vars for Phase 2:

| Variable | Where to set | Purpose |
|---|---|---|
| `GUEST_IP_HASH_SALT` | **CI masked/protected var** (never `.env.example`) | Salts the guest IP hash — never stores the raw IP. **Required in production** (>=16 chars); app refuses to boot without it. |
| `GUEST_AI_QUOTA_PER_WINDOW` | `.gitlab-ci.yml` prod job env | Max breakdowns per IP per window (default 5). |
| `GUEST_AI_WINDOW_HOURS` | `.gitlab-ci.yml` prod job env | Sliding window length in hours (default 24). |
| `GUEST_GLOBAL_DAILY_GUEST_CAP` | `.gitlab-ci.yml` prod job env | Max unique guest IPs per day globally (default 10). |
| `GUEST_SANDBOX_TTL_HOURS` | `.gitlab-ci.yml` prod job env | How long a guest sandbox lives (default 24 h). |
| `OWNER_BREAKDOWN_MODEL` | `.gitlab-ci.yml` prod job env | Claude model for owner breakdowns (default `claude-sonnet-4-6`). `anthropic` provider only. |
| `GUEST_BREAKDOWN_MODEL` | `.gitlab-ci.yml` prod job env | Claude model for guest breakdowns (default `claude-haiku-4-5`). `anthropic` provider only. |

---

## 🤖 Bring your own LLM (BYO-LLM)

Self-hosting shouldn't force you to hold an Anthropic key. The breakdown chat
talks to a provider-agnostic seam (`src/lib/llm/`) with two adapters, picked by
one env var (#59):

- **`LLM_PROVIDER=anthropic`** — the hosted Claude API. The default, and what runs
  on dlectroflow.dev.
- **`LLM_PROVIDER=openai-compatible`** — any OpenAI-compatible `/v1` endpoint: a
  local runner (Ollama, LM Studio, vLLM) or another hosted vendor.

> [!WARNING]
> **`openai-compatible` is unit-tested only — no human has yet run it against a
> real non-Anthropic endpoint.** Its tests mock the SDK
> (`src/lib/llm/openai-compatible.test.ts`), so the adapter's logic is covered but
> the wire has never been exercised. Treat it as **experimental and expect to
> debug it**: response shapes, streaming and tool-calling all vary between
> runtimes and vendors. The `anthropic` default is the path running in
> production, and the one that's supported. If you get another provider working —
> or find exactly where it breaks — an issue or MR would be genuinely useful.

**Provider choice is deploy-time only:** env vars, no in-app switcher. The
Settings model picker only offers a choice on `anthropic` (its three tiers); on a
single-model `openai-compatible` deploy it collapses to a read-only
`Using model: …` line.

| Variable | Applies to | Purpose |
|---|---|---|
| `LLM_PROVIDER` | both | `anthropic` (default) or `openai-compatible`. An unrecognised value logs an error and falls back to `anthropic`. |
| `ANTHROPIC_API_KEY` | `anthropic` | Your Claude key. Missing → the app still boots (production logs a warning) and AI features fail at first use. |
| `LLM_BASE_URL` | `openai-compatible` — **required** | The OpenAI-compatible base URL, e.g. `http://localhost:11434/v1` for Ollama. |
| `LLM_MODEL` | `openai-compatible` — **required** | Model id, e.g. `llama3.1:8b`. |
| `LLM_API_KEY` | `openai-compatible` | Key for that endpoint. Local runners usually need none — the adapter sends a harmless placeholder when it's unset. |
| `LLM_OWNER_MODEL` / `LLM_GUEST_MODEL` | `openai-compatible` | Optional owner/guest model split; each falls back to `LLM_MODEL`. |
| `LLM_SUPPORTS_TOOLS` | `openai-compatible` | `true` (default) or `false`. Set `false` for a model with no native tool-calling — breakdowns then use a prompted JSON-in-text fallback instead of a tool call. |

**In production the app refuses to boot** on `openai-compatible` unless *both*
`LLM_BASE_URL` and `LLM_MODEL` are set — a half-configured provider fails fast
instead of at someone's first breakdown.

The config a local Ollama would use (untested — see the warning above):

```bash
ollama pull llama3.1:8b
export LLM_PROVIDER=openai-compatible
export LLM_BASE_URL=http://localhost:11434/v1
export LLM_MODEL=llama3.1:8b
# add LLM_SUPPORTS_TOOLS=false if the model can't do tool calls
npm run dev
```

---

## 📅 Connecting Google Tasks

Google Tasks is the recommended way to schedule steps — connect once and a
Reclaim-synced list is scheduled automatically from there.

1. Run the app (`npm run dev`) with `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` set
   (see [Third-party services](#-third-party-services)).
2. Go to **Settings → Integrations** and click **Connect Google →** (or connect
   inline: break down a task, hit **👍 Looks right**, then **Connect Google Tasks →**
   right there). Any signed-in account can do this for themselves — the
   connection is per user, not per instance.
3. Log in and approve. Back on a task, hit **📅 Send to Google Tasks**.

Tokens are stored in your database (never the repo) and auto-refresh. If Google
revokes access, **Settings → Integrations** shows **Reconnect needed** and a task's
schedule button degrades to a reconnect link instead — click it, nothing is lost.
Settings → Integrations is also where you disconnect.

### Publish your OAuth consent screen before inviting anyone

The Google Tasks scope (`.../auth/tasks`) is **sensitive**, and two
consent-screen states break sync in ways that look exactly like application bugs:

| Google Cloud console state | What your users actually see |
| --- | --- |
| Consent screen in **Testing**, user type External | Connecting works, then sync dies **about seven days later** — Google expires refresh tokens for testing apps after 7 days. `Settings → Integrations` starts showing **Reconnect needed** and it reads exactly like a token-refresh bug in the app. |
| **Production** but unverified, on a sensitive scope | A *"Google hasn't verified this app"* interstitial before consent, and a hard cap of **100 users**. Not a blocker at small scale, but it is an alarming screen to hand somebody you just invited. |

**Publish the consent screen** (Google Cloud console → *APIs & Services* → *OAuth
consent screen*) before inviting anyone. Full verification is only needed above
100 users. This is a console setting — nothing in the app can work around it.

Each person connects their **own** Google account: credentials are stored per
user, and no account (the instance owner included) can see or use another's.

### A managed work account can be blocked by its own administrator

Google Workspace administrators can restrict which third-party OAuth apps may
access accounts in their domain. If your OAuth client isn't on that allowlist,
Google refuses at **its own** consent step and shows **its own** page — the
organisation's help link plus `Error 400: access_not_configured`.

You will not see this happen. The person never reaches your callback, so there
is no error state to render and **nothing in your logs**; from inside the app it
is indistinguishable from someone changing their mind. It is also easy to
misdiagnose: `access_not_configured` is the same code Google returns for an API
that simply isn't enabled, which sends you looking at your Cloud project rather
than at the user's domain.

Two things follow if you run this for other people:

- **A personal Google account is the reliable choice**, and every Connect
  control in the app already carries that hint. It is the whole mitigation —
  there is no detection to add.
- **If your users all sit in one Workspace domain**, ask that domain's
  administrator to allowlist your OAuth client id (Google Admin console →
  *Security* → *Access and data control* → *API controls* → *App access
  control*). Only they can make that change.

Nobody is locked out either way: [`.ics` export](#no-google-account-ics-still-works)
needs no Google account at all.

### No Google account? `.ics` still works

Scheduling isn't all-or-nothing. With no Google connection at all, a task's steps
still save locally and **Add to calendar (.ics)** hands you a calendar file to
import wherever you like — no OAuth client, no integration to set up. It's
available to everyone, guests included.

> **Heads-up if you read an older copy of this README:** the direct
> "Schedule in Reclaim (MCP)" flow was **removed in v0.2.0** (#36). Reclaim is
> still supported, just downstream — you point *Reclaim's* own Google Tasks
> integration at your account, and dlectroflow writes into the list it creates.

---

## 🎧 Focus music

Optional lo-fi to focus to, bundled with the app — no streaming account, no media
service, works offline.

- **10 tracks**, one per genre category, in `public/audio/lofi/`. Every file is
  **CC0 1.0 (public domain)**; per-file provenance is in
  [`public/audio/LICENSE.md`](public/audio/LICENSE.md).
- **Pick one** in **Settings → Focus timer** — each track has a preview toggle, so
  you can audition without starting a session.
- **In-session mini-player**: now-playing, prev/next, play/pause, volume, progress,
  and a **shuffle** toggle.
- **It follows the timer** — the music pauses when you pause and resumes when you
  resume, so a paused session is actually quiet.
- **The playlist advances itself** when a track ends, and plays every track once
  before starting a new pass (shuffled or in order) — no accidental repeats.

Streaming a bigger catalogue is a later release (#61); this is the bundled set.

---

## 🗄️ Database & migrations

Postgres — runs locally via Docker Compose. Start it with `docker compose up -d db`.
Every command below takes its connection string from `DATABASE_URL` in **`.env`**
(see [which file?](#which-file-env-vs-envlocal)).

```bash
docker compose up -d db   # start local Postgres (idempotent — safe to re-run)
npm run db:migrate        # create/apply migrations after schema changes
npm run db:studio         # open Prisma Studio to browse data
```

> **Gotcha:** after running a migration, **restart `npm run dev`** — a running dev
> server holds a stale database client and will error on new tables until you do.

---

## Running E2E tests (Playwright)

Real-browser smoke suite (Chromium). Requires a local Postgres with the schema applied.

```bash
# One-time: install the browser
npx playwright install chromium

# Ensure the DB schema exists (uses your DATABASE_URL)
npm run db:deploy

# Build once — Playwright boots the *standalone* output (`node
# .next/standalone/server.js`), the same entrypoint the deployed image runs,
# so the suite exercises the artefact that ships (#97)
npm run build

# Run the smoke suite
npm run test:e2e
```

Auth is handled automatically: `e2e/global-setup.ts` forges a valid owner session
cookie with `signSession()` — no OAuth login is performed and no bypass code exists
in application source. Specs run serially against one owner workspace and scope
assertions to unique per-run strings. On failure in CI, an HTML report is uploaded
as a job artifact (`playwright-report/`).

Running locally against your own dev database accumulates `E2E …` rows in the
owner workspace across repeated runs — assertions stay correct regardless since
each run's items are scoped by a unique timestamped label, and CI is unaffected
because it runs against an ephemeral, per-job Postgres service.

### Accessibility gate (axe)

`e2e/a11y/axe-core-flow.spec.ts` runs [`@axe-core/playwright`](https://github.com/dequelabs/axe-core-npm)
over the core flow (inbox/capture → clarify → schedule → focus → reward) and
fails on **new serious/critical** WCAG 2.0/2.1 A+AA violations (contrast, labels,
roles, name/role/value). It rides the same `e2e_test` CI job as the smoke suite,
so it is already a blocking gate before the image build.

Pre-existing serious/critical violations are allow-listed in
`e2e/a11y/axe-baseline.json` (keyed by route, one `ruleId::selector` fingerprint
per node) so the gate starts green and only regressions fail. After fixing a
violation, or to intentionally accept a reviewed pre-existing one, regenerate the
baseline:

```bash
A11Y_UPDATE_BASELINE=1 npm run test:e2e -- e2e/a11y
```

Commit the resulting `axe-baseline.json` diff.

---

## 🐳 Deploy

The app deploys automatically via **GitLab CI/CD to GKE Autopilot** (europe-west2):

- **Review apps** — every MR gets its own environment at `https://mr-<IID>.YOUR-STATIC-IP.sslip.io` (the MR shows a "View app" button). The namespace is deleted when the MR closes.
- **Production** — merge to `main` deploys to **https://dlectroflow.dev**.

For the full provisioning walkthrough (cluster, ingress-nginx, cert-manager, GitLab agent, secrets, DNS, OAuth), see **[docs/deploy-runbook.md](docs/deploy-runbook.md)**.

### 🖥️ Or self-host it on one small server (~$6/month)

You don't need Kubernetes. `docker/docker-compose.prod.yml` runs the whole thing —
app, Postgres and [Caddy](https://caddyserver.com) for automatic HTTPS — on a
single VPS, with a nightly backup and guest-data purge:

```bash
cp .env.prod.example .env.prod          # fill in your domain + secrets
docker build -f docker/Dockerfile -t dlectroflow:local .
docker compose --env-file .env.prod -f docker/docker-compose.prod.yml up -d
```

Step-by-step walkthrough, cron lines, restore and upgrade steps:
**[docs/self-host-vps.md](docs/self-host-vps.md)**.

### Run the container directly

If you want to run the image outside the cluster (e.g. a quick local prod-like test), supply a Postgres `DATABASE_URL`:

```bash
docker build -f docker/Dockerfile -t dlectroflow .
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/dlectroflow" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  dlectroflow
```

> **Migrations are not run by the plain image.** Its command is just `node server.js`
> — it does **not** apply migrations on start. Point it at a database whose schema is
> already migrated, or run `npx prisma migrate deploy` yourself first. (In the Kubernetes
> deploy this is handled separately by a dedicated `migrate` initContainer that reuses this
> same image — see [docs/deploy-runbook.md](docs/deploy-runbook.md).)

Visit **http://localhost:3000**.

---

## 💸 What it costs to run

Short version: **the cheapest honest way to run dlectroflow 24/7 on your own
domain is one ~$6/month VPS** with Docker Compose and [Caddy](https://caddyserver.com)
for automatic HTTPS. The GKE Autopilot deploy above is roughly **$105–145/month**,
and more than half of that is the ingress controller, cert-manager and the load
balancer rather than the app.

| Where you run it | Roughly | Notes |
|---|---|---|
| Hardware you already own | **$0–3/mo** | Electricity. Uptime is your ISP's problem. |
| One small VPS + Docker Compose + Caddy | **$6/mo** | Cheapest always-on public site. No HA. |
| Fly.io / Render | **$10–14/mo** | Hosted; least work. Render's free Postgres expires after 30 days. |
| Managed Kubernetes (DigitalOcean / Civo) | **~$36/mo** | Runs this repo's Helm chart with real HA. |
| **GKE Autopilot — what production runs** | **$105–145/mo** | HA, review apps per MR, zero infra work. |

Plus a domain (~$10–15/**year**) and the AI model: about **$0.005 per breakdown**
on Haiku, **$0.025** on Sonnet, **$0.05** on Opus — so **$1–15/month** in
practice, or $0 if you point it at a model you run yourself.

> **Only the GKE Autopilot figures are from a real deployment.** Everything else
> is a worked example from published provider prices, offered because
> self-hosters arrive with very different budgets and skills — not a tested
> recipe. **If you run dlectroflow somewhere, please contribute what it actually
> cost.**

**Full breakdown — eight options, every tool explained, line-item costs: [docs/running-costs.md](docs/running-costs.md).**

---

## 🧯 Troubleshooting

| Symptom | Fix |
|---|---|
| `command not found: node` | Node isn't installed / not on PATH. Install it (see Prerequisites), reopen your terminal. |
| `npm run setup` stops at *"Environment variable not found: DATABASE_URL"* | There's no `.env` yet — or your `DATABASE_URL` is in `.env.local`, which Prisma doesn't read. `cp .env.example .env`, then re-run ([which file?](#which-file-env-vs-envlocal)). |
| `P1000: Authentication failed against database server` | Your `DATABASE_URL` password doesn't match `docker/docker-compose.yml` (it's `dlectroflow`). Re-copy the template: `cp .env.example .env`. |
| `P1001: Can't reach database server at localhost:5432` | Postgres isn't running. `docker compose -f docker/docker-compose.yml up -d db` (or just re-run `npm run setup`, which starts it). |
| First-ever page load logs `prisma:error … Unique constraint failed on the fields: (id)` | Harmless, and only on a brand-new database: two concurrent first-use reads race to create your Settings/Streak row, and the loser re-fetches it (see the docblock in `src/lib/db.ts`). The page still renders; you won't see it again. |
| Breakdown returns *"ANTHROPIC_API_KEY is not set"* | Export the key (or put it in `.env`, or `.env.local` — either works for runtime values) **and restart** `npm run dev`. Env is read at server start. |
| DB error mentioning a table/model that should exist | You ran a migration while `npm run dev` was running. **Restart the dev server.** |
| `Port 3000 is already in use` | Another server is running: `npm run dev -- -p 3001`, or stop the other one. |
| Boot fails: *LLM provider "openai-compatible" misconfigured — refusing to boot* | In production both `LLM_BASE_URL` and `LLM_MODEL` are required. Set them — see [BYO-LLM](#-bring-your-own-llm-byo-llm). |
| Breakdown returns *"LLM_BASE_URL is not set"* | You set `LLM_PROVIDER=openai-compatible` without a base URL (outside production nothing checks at boot). Set `LLM_BASE_URL` and restart. |
| Your own model chats back but never produces steps | It probably can't do native tool-calling: set `LLM_SUPPORTS_TOOLS=false` for the JSON-in-text fallback. Also read the [experimental warning](#-bring-your-own-llm-byo-llm) — no human has run this path against a real non-Anthropic endpoint yet. |
| Prisma client seems out of date after `git pull` | `npm install` (runs `prisma generate`) or `npm run db:migrate`. |
| Someone clicks **Connect Google →**, never comes back, and nothing appears in your logs — or they report `Error 400: access_not_configured` | Their Google account is probably managed by an organisation that hasn't allowlisted your OAuth client, so Google refuses at its own consent step. Not a bug you can fix in the app: see [A managed work account can be blocked by its own administrator](#a-managed-work-account-can-be-blocked-by-its-own-administrator). |

---

## 🗺️ Tech stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Tailwind CSS v4** + **shadcn/ui** + **Motion** (née Framer Motion)
- **Prisma 6** + **PostgreSQL** (local dev via Docker Compose; production on GKE, deployed via GitLab CI/CD)
- **Provider-agnostic LLM seam** (`src/lib/llm/`) — **Claude API** by default (`@anthropic-ai/sdk`, streaming with adaptive thinking; model is configurable — defaults to `claude-sonnet-4-6` for owners and `claude-haiku-4-5` for guests, see [Phase 2](#phase-2-guest-access--ai-cost-controls))
- …or **any OpenAI-compatible endpoint** via the `openai` SDK — a local runner or another vendor (see [BYO-LLM](#-bring-your-own-llm-byo-llm))
- **Google Tasks API** via OAuth 2.0 (the scheduling integration; Reclaim syncs that list from its own side) + a zero-OAuth `.ics` download as the universal fallback
- Bundled **CC0** focus audio under `public/audio/` — no external media service
- Deploy: **Docker** → GKE Autopilot via GitLab CI/CD

Full feature spec and the build order live in [`docs/dlectroflow-plan.md`](docs/dlectroflow-plan.md).

---

## 🤝 Contributing

Spotted a bug, a confusing doc step, or an idea? **Open an issue** — small reports
are very welcome. For code changes, open a merge request against `main`; every MR
gets its own review app so you (and reviewers) can click around the change live.

Setup, house conventions, the hygiene tests and the commit format are all in
**[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)**. Security reports go through
**[docs/SECURITY.md](docs/SECURITY.md)**, and participation is governed by the
**[Code of Conduct](docs/CODE_OF_CONDUCT.md)**.

> 🤖 This app is built with the support of **[Claude](https://claude.com/claude-code)** and **GitLab Duo** —
> from pair-building features and reviewing every merge request to drafting these very docs.

---

## 🧭 Roadmap

Development happens in the open, milestone by milestone:

- **[Milestones](https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/milestones)** — what's shipping next.
- **[Open issues](https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/issues)** — the full backlog.
- **[Changelog](CHANGELOG.md)** — what's already shipped.

Have an idea or hit a bug? [Open an issue](https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/issues/new) — including "this doc tripped me up."

---

## 🧠 A note for fellow neurodivergent nerds

This app is built the way it helps *me* think, and the setup is meant to respect that:

- **Two lines to start** (`cp .env.example .env && npm run setup`) — fewer decisions,
  less friction, and the template needs no editing.
- **Copy-pasteable steps** — no "figure out the obvious bit" gaps.
- **Honest status** above — so you're never chasing a feature that isn't wired yet.
- **Nothing hard-fails** — no Claude key? App still runs. Haven't connected Google
  Tasks yet (Settings → Integrations)? Steps save locally. The goal is to never
  punish you for a missing piece.

If a step here tripped you up, that's a bug in *the docs*, not in you — open an
issue and I'll fix the instructions.

---

## 📄 License

Licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).
In short: you're free to use, modify, and self-host it — but if you run a modified
version as a network service, you must make your source (including your changes)
available to its users.

---

## ⚖️ Legal & privacy

The hosted instance publishes a [Privacy Policy](https://dlectroflow.dev/privacy)
and [Terms of Service](https://dlectroflow.dev/terms) (source:
`src/app/privacy/page.tsx` and `src/app/terms/page.tsx`).

> [!NOTE]
> **They cover dlectroflow.dev only.** If you self-host, that instance is yours —
> you are its data controller, and you need your own policy. Nothing there applies
> to your deployment.

**Maintaining them: [docs/legal.md](docs/legal.md).** It lists which facts the
published text asserts about the running system — region, backup retention, LLM
provider, cookies, OAuth scopes — and therefore what has to be re-checked when
infrastructure changes, plus the effective-date rule and a Google OAuth
verification checklist. Worth reading *before* changing any of those, because the
pages go stale silently.
