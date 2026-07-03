# dlectroflow 🧠⚡

An ADHD helper web app — **capture → clarify → schedule → focus → reward**.

You brain-dump anything, Claude breaks the scary stuff into tiny do-able steps,
those steps get scheduled onto your real calendar (via Reclaim), you focus on one
at a time, and you get a hit of dopamine for finishing. Come back tomorrow, repeat.

Built as both a learning project and a polished live-demo app.

---

## 🚦 Status — what works today

This is **in active development**. Being honest so you don't hit surprises:

| Feature | State |
|---|---|
| 🧠 Brain Dump — capture, triage, aging reminders | ✅ works |
| 🔔 Desktop notifications + demo override | ✅ works |
| ✂️ Claude task breakdown (streaming chat) | ✅ works (needs a Claude API key) |
| 📅 Scheduling (Claude → Google Tasks → Reclaim sync) | ✅ works — connect Google and steps land in your Reclaim-synced Google Tasks list (durations parsed). Direct Reclaim-MCP task creation is gated on some accounts → steps then save locally as a fallback (see [Connecting Reclaim](#-connecting-reclaim)). |
| ⏱️ Focus Timer | ✅ works |
| 🎉 Rewards & streaks + dashboard | ✅ works |
| 🌇 End-of-day round-up (in-app + desktop) | ✅ works |
| ✉️ Round-up **email** (opt-in) | ✅ works when `RESEND_API_KEY` is set; cleanly disabled otherwise |
| 🐳 Postgres + GitLab CI/CD | ✅ **live** — deployed to GKE Autopilot at **[dlectroflow.dlectronique.dev](https://dlectroflow.dlectronique.dev)** (valid TLS) via GitLab CI/CD; every MR gets a review app. Local Postgres via Docker Compose. |

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
| **Reclaim.ai** | Scheduling steps onto your calendar | Optional | Free tier connects; **auto-scheduling tasks may need a paid plan / beta access** (see caveat below). [reclaim.ai](https://reclaim.ai) |
| **Resend** | Opt-in end-of-day round-up **email** | Optional | Free tier is plenty. Set `RESEND_API_KEY`, then opt in on the dashboard. In-app + desktop round-up work without it. [resend.com](https://resend.com) |

You can run and demo the whole capture → breakdown flow with **just the Anthropic key**.

---

## 🚀 Quick start (local, ~5 minutes)

```bash
# 1. Clone
git clone https://gitlab.com/gl-demo-ultimate-dtop/dlectroflow.git
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

---

## 📅 Connecting Reclaim

Reclaim scheduling uses a **browser OAuth flow** — no API key to paste, and the app
**self-registers** with Reclaim (dynamic client registration), so there's no manual
"create an OAuth app" step.

1. Run the app (`npm run dev`).
2. Break down a task and hit **👍 Looks right**.
3. Click **Connect Reclaim →**, log in, and approve.
4. Back on the task, hit **📅 Schedule in Reclaim**.

Tokens are stored in your database (never the repo) and auto-refresh.

> ⚠️ **Known limitation (honest heads-up):** Reclaim gates task-*creation* via MCP
> per account. If yours only has read access, you'll see *"create_reclaim_task is
> not available for your account"* — your steps still save locally, nothing breaks.
> A **Claude → Google Tasks → Reclaim** route (Reclaim syncs your Google Tasks) is
> in progress to sidestep this.

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

## 🐳 Deploy

The app deploys automatically via **GitLab CI/CD to GKE Autopilot** (europe-west2):

- **Review apps** — every MR gets its own environment at `https://mr-<IID>.35-246-93-255.sslip.io` (the MR shows a "View app" button). The namespace is deleted when the MR closes.
- **Production** — merge to `main` deploys to **https://dlectroflow.dlectronique.dev**.

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

Migrations run automatically on start. Visit **http://localhost:3000**.

---

## 🧯 Troubleshooting

| Symptom | Fix |
|---|---|
| `command not found: node` | Node isn't installed / not on PATH. Install it (see Prerequisites), reopen your terminal. |
| Breakdown returns *"ANTHROPIC_API_KEY is not set"* | Export the key (or put it in `.env.local`) **and restart** `npm run dev`. Env is read at server start. |
| DB error mentioning a table/model that should exist | You ran a migration while `npm run dev` was running. **Restart the dev server.** |
| `Port 3000 is already in use` | Another server is running: `npm run dev -- -p 3001`, or stop the other one. |
| Reclaim: *"create_reclaim_task is not available for your account"* | Account-level Reclaim limit, not a bug — steps save locally. See [Connecting Reclaim](#-connecting-reclaim). |
| Prisma client seems out of date after `git pull` | `npm install` (runs `prisma generate`) or `npm run db:migrate`. |

---

## 🗺️ Tech stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Tailwind CSS v4** + **shadcn/ui** + **Framer Motion**
- **Prisma 6** + **PostgreSQL** (local dev via Docker Compose; production on GitLab)
- **Claude API** (`@anthropic-ai/sdk`, model `claude-opus-4-8`, adaptive thinking, streaming)
- **Reclaim** via OAuth 2.1 + the Claude remote-MCP connector
- Deploy: **Docker** → GKE Autopilot via GitLab CI/CD

Full feature spec and the build order live in [`docs/dlectroflow-plan.md`](docs/dlectroflow-plan.md).

---

## 🧠 A note for fellow neurodivergent nerds

This app is built the way it helps *me* think, and the setup is meant to respect that:

- **One command to start** (`npm run setup`) — fewer decisions, less friction.
- **Copy-pasteable steps** — no "figure out the obvious bit" gaps.
- **Honest status** above — so you're never chasing a feature that isn't wired yet.
- **Nothing hard-fails** — no Claude key? App still runs. No Reclaim? Steps save
  locally. The goal is to never punish you for a missing piece.

If a step here tripped you up, that's a bug in *the docs*, not in you — open an
issue and I'll fix the instructions.
