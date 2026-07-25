# dlectroflow 🧠⚡

[![pipeline status](https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/badges/main/pipeline.svg)](https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/pipelines)

An ADHD helper web app — **capture → clarify → schedule → focus → reward**.

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
- [📅 Connecting Google Tasks](#-connecting-google-tasks)
- [🗄️ Database & migrations](#️-database--migrations)
- [🐳 Deploy](#-deploy)
- [🧯 Troubleshooting](#-troubleshooting)
- [🗺️ Tech stack](#️-tech-stack)
- [🤝 Contributing](#-contributing)
- [🧭 Roadmap](#-roadmap)
- [🧠 A note for fellow neurodivergent nerds](#-a-note-for-fellow-neurodivergent-nerds)

---

## 🚦 Status — what works today

This is **in active development**. Being honest so you don't hit surprises:

| Feature | State |
|---|---|
| 🧠 Brain Dump — capture, triage, aging reminders | ✅ works |
| 🔔 Desktop notifications + demo override | ✅ works |
| ✂️ Claude task breakdown (streaming chat) | ✅ works (needs a Claude API key) |
| 📅 Scheduling (Claude → Google Tasks) | ✅ works — connect Google from **Settings → Integrations** (or right from a breakdown) and steps land in your Google Tasks list, durations parsed; a Reclaim-synced list is scheduled automatically. Direct Reclaim-MCP task creation is also available as a fallback but is gated on some accounts → steps then save locally in that case (see [Connecting Google Tasks](#-connecting-google-tasks)). |
| ⏱️ Focus Timer | ✅ works |
| 🎉 Rewards & streaks + dashboard | ✅ works |
| 🌇 End-of-day round-up (in-app + desktop) | ✅ works |
| ✉️ Round-up **email** (opt-in) | ✅ works when `RESEND_API_KEY` is set; cleanly disabled otherwise |
| 🐳 Postgres + GitLab CI/CD | ✅ **live** — deployed to GKE Autopilot at **[dlectroflow.dev](https://dlectroflow.dev)** (valid TLS) via GitLab CI/CD; every MR gets a review app. Local Postgres via Docker Compose. |

If all you want right now is **capture → Claude breakdown**, that's fully working
and genuinely useful.

---

## 🧰 Prerequisites

You'll need these installed **before** you start. (One-time, ~5 min if you have none.)

- [ ] **Node.js 20.9+** (tested on 26). Check: `node -v`
  - Don't have it? [nodejs.org](https://nodejs.org) or `brew install node` (macOS) / your package manager. There's a `.nvmrc` if you use [nvm](https://github.com/nvm-sh/nvm) (`nvm use`).
- [ ] **npm** (ships with Node). Check: `npm -v`
- [ ] **Git**. Check: `git --version`
- [ ] **Docker** — [docker.com](https://www.docker.com/) — used to run Postgres locally (and for production containers).

That's it for running locally. Postgres runs via Docker — no manual database server setup required.

---

## 🔑 Third-party services

| Service | Needed for | Required? | Cost |
|---|---|---|---|
| **Anthropic (Claude API)** | The task breakdown chat | ✅ Required | Pay-as-you-go; a breakdown is a few cents. [console.anthropic.com](https://console.anthropic.com) → **API keys** |
| **Google Tasks** | Scheduling steps — connect from **Settings → Integrations** | Optional | Free. Create an OAuth client in [Google Cloud Console](https://console.cloud.google.com/) (see [Connecting Google Tasks](#-connecting-google-tasks)). |
| **Reclaim.ai** | Auto-scheduling your Google Tasks list onto your calendar | Optional | Free tier connects; **auto-scheduling tasks may need a paid plan / beta access** (see caveat below). [reclaim.ai](https://reclaim.ai) |
| **Resend** | Opt-in end-of-day round-up **email** | Optional | Free tier is plenty. Set `RESEND_API_KEY`, then opt in on the dashboard. In-app + desktop round-up work without it. [resend.com](https://resend.com) |

You can run and demo the whole capture → breakdown flow with **just the Anthropic key**.

---

## 🚀 Quick start (local, ~5 minutes)

```bash
# 1. Clone
git clone https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow.git
cd dlectroflow

# 2. Start Postgres, install deps + create the database (one command)
npm run setup        # = docker compose up -d db && npm install && prisma migrate dev

# 3. Add your Claude API key (see options below), e.g. for this shell session:
export ANTHROPIC_API_KEY='sk-ant-...'

# 4. Run it
npm run dev
```

Open **http://localhost:3000** — it redirects to your inbox. Capture a thought,
hit **Break down →**, and watch Claude stream a plan. 🎉

> **No key yet?** The app still runs — you just get a friendly error when you try
> a breakdown instead of a plan.

---

## 🔐 Secrets & environment

**Golden rule: no secrets in the repo, ever.** The app only ever reads
`process.env.ANTHROPIC_API_KEY` — it doesn't care *how* the value got there.

**Local dev — pick whichever suits you:**
- **Quickest:** `export ANTHROPIC_API_KEY='sk-ant-...'` in your terminal before `npm run dev`.
- **Persistent:** `cp .env.example .env.local` and fill it in. `.env.local` is gitignored.

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

See [`.env.example`](.env.example) for the full list of variables.

### Phase 2: guest access & AI cost controls

Guest users get a sandboxed AI breakdown experience with built-in guardrails:

- **AI quota:** 5 breakdowns / IP / 24 h; 10 unique guest IPs / day globally (Haiku model — cheaper, still useful).
- **Owner model:** selectable in Settings (defaults to `claude-sonnet-4-6`).
- **`.ics` export:** no integration needed — pure client-side `.ics` file generation.
- **Dark mode:** persists via `localStorage`; no backend required.

New env vars for Phase 2:

| Variable | Where to set | Purpose |
|---|---|---|
| `GUEST_IP_HASH_SALT` | **CI masked/protected var** (never `.env.example`) | Salts the guest IP hash — never stores the raw IP. **Required in production** (>=16 chars); app refuses to boot without it. |
| `GUEST_AI_QUOTA_PER_WINDOW` | `.gitlab-ci.yml` prod job env | Max breakdowns per IP per window (default 5). |
| `GUEST_AI_WINDOW_HOURS` | `.gitlab-ci.yml` prod job env | Sliding window length in hours (default 24). |
| `GUEST_GLOBAL_DAILY_GUEST_CAP` | `.gitlab-ci.yml` prod job env | Max unique guest IPs per day globally (default 10). |
| `GUEST_SANDBOX_TTL_HOURS` | `.gitlab-ci.yml` prod job env | How long a guest sandbox lives (default 24 h). |
| `OWNER_BREAKDOWN_MODEL` | `.gitlab-ci.yml` prod job env | Claude model for owner breakdowns (default `claude-sonnet-4-6`). |
| `GUEST_BREAKDOWN_MODEL` | `.gitlab-ci.yml` prod job env | Claude model for guest breakdowns (default `claude-haiku-4-5`). |

---

## 📅 Connecting Google Tasks

Google Tasks is the recommended way to schedule steps — connect once and a
Reclaim-synced list is scheduled automatically from there.

1. Run the app (`npm run dev`) with `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` set
   (see [Third-party services](#-third-party-services)).
2. Go to **Settings → Integrations** and click **Connect Google →** (or connect
   inline: break down a task, hit **👍 Looks right**, then **Connect Google Tasks →**
   right there).
3. Log in and approve. Back on a task, hit **📅 Send to Google Tasks**.

Tokens are stored in your database (never the repo) and auto-refresh. If Google
revokes access, **Settings → Integrations** shows **Reconnect needed** and a task's
schedule button degrades to a reconnect link instead — click it, nothing is lost.
Settings → Integrations is also where you disconnect.

### Optional: direct Reclaim MCP scheduling

As a fallback (e.g. no Google OAuth client configured), the app can ask Claude to
create Reclaim tasks directly via the Reclaim remote-MCP connector. This flow uses
a **browser OAuth flow** — no API key to paste, and the app **self-registers** with
Reclaim (dynamic client registration), so there's no manual "create an OAuth app"
step. From a broken-down task, click **Connect Reclaim →**, log in, and approve;
then hit **📅 Schedule in Reclaim (MCP)**.

> ⚠️ **Known limitation (honest heads-up):** Reclaim gates task-*creation* via MCP
> per account. If yours only has read access, you'll see *"create_reclaim_task is
> not available for your account"* — your steps still save locally, nothing breaks.
> The Google Tasks route above sidesteps this entirely.

---

## 🗄️ Database & migrations

Postgres — runs locally via Docker Compose. Start it with `docker compose up -d db`.

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

# Build once (Playwright serves the app via `next start`)
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

### Run the container directly

If you want to run the image outside the cluster (e.g. a quick local prod-like test), supply a Postgres `DATABASE_URL`:

```bash
docker build -t dlectroflow .
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

## 🧯 Troubleshooting

| Symptom | Fix |
|---|---|
| `command not found: node` | Node isn't installed / not on PATH. Install it (see Prerequisites), reopen your terminal. |
| Breakdown returns *"ANTHROPIC_API_KEY is not set"* | Export the key (or put it in `.env.local`) **and restart** `npm run dev`. Env is read at server start. |
| DB error mentioning a table/model that should exist | You ran a migration while `npm run dev` was running. **Restart the dev server.** |
| `Port 3000 is already in use` | Another server is running: `npm run dev -- -p 3001`, or stop the other one. |
| Reclaim: *"create_reclaim_task is not available for your account"* | Account-level Reclaim MCP limit, not a bug — steps save locally, or use the recommended Google Tasks route instead. See [Connecting Google Tasks](#-connecting-google-tasks). |
| Prisma client seems out of date after `git pull` | `npm install` (runs `prisma generate`) or `npm run db:migrate`. |

---

## 🗺️ Tech stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Tailwind CSS v4** + **shadcn/ui** + **Motion** (née Framer Motion)
- **Prisma 6** + **PostgreSQL** (local dev via Docker Compose; production on GKE, deployed via GitLab CI/CD)
- **Claude API** (`@anthropic-ai/sdk`, streaming with adaptive thinking; model is configurable — defaults to `claude-sonnet-4-6` for owners and `claude-haiku-4-5` for guests, see [Phase 2](#phase-2-guest-access--ai-cost-controls))
- **Google Tasks API** via OAuth 2.0 (primary scheduling integration) + **Reclaim** via OAuth 2.1 + the Claude remote-MCP connector (optional fallback)
- Deploy: **Docker** → GKE Autopilot via GitLab CI/CD

Full feature spec and the build order live in [`docs/dlectroflow-plan.md`](docs/dlectroflow-plan.md).

---

## 🤝 Contributing

Spotted a bug, a confusing doc step, or an idea? **Open an issue** — small reports
are very welcome. For code changes, open a merge request against `main`; every MR
gets its own review app so you (and reviewers) can click around the change live.

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

- **One command to start** (`npm run setup`) — fewer decisions, less friction.
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
