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
| 📅 Reclaim scheduling | ⚠️ connects & works **if your Reclaim account allows task creation** — otherwise steps save locally (see [Connecting Reclaim](#-connecting-reclaim)). A Google-Tasks route is in progress to remove that limit. |
| ⏱️ Focus Timer | 🚧 coming next |
| 🎉 Rewards & streaks | 🚧 planned |
| 🌇 End-of-day email round-up | 🚧 planned |
| 🐳 Postgres + GitLab CI/CD | 🚧 planned (SQLite + Docker work today) |

If all you want right now is **capture → Claude breakdown**, that's fully working
and genuinely useful.

---

## 🧰 Prerequisites

You'll need these installed **before** you start. (One-time, ~5 min if you have none.)

- [ ] **Node.js 20.9+** (tested on 26). Check: `node -v`
  - Don't have it? [nodejs.org](https://nodejs.org) or `brew install node` (macOS) / your package manager. There's a `.nvmrc` if you use [nvm](https://github.com/nvm-sh/nvm) (`nvm use`).
- [ ] **npm** (ships with Node). Check: `npm -v`
- [ ] **Git**. Check: `git --version`
- [ ] *(Deploy only)* **Docker** — [docker.com](https://www.docker.com/) — only if you want to containerize.

That's it for running locally. No database server to install — it uses SQLite (a file).

---

## 🔑 Third-party services

| Service | Needed for | Required? | Cost |
|---|---|---|---|
| **Anthropic (Claude API)** | The task breakdown chat | ✅ Required | Pay-as-you-go; a breakdown is a few cents. [console.anthropic.com](https://console.anthropic.com) → **API keys** |
| **Reclaim.ai** | Scheduling steps onto your calendar | Optional | Free tier connects; **auto-scheduling tasks may need a paid plan / beta access** (see caveat below). [reclaim.ai](https://reclaim.ai) |
| **Resend** | End-of-day email (planned) | Not yet | — |

You can run and demo the whole capture → breakdown flow with **just the Anthropic key**.

---

## 🚀 Quick start (local, ~5 minutes)

```bash
# 1. Clone
git clone https://gitlab.com/gl-demo-ultimate-dtop/dlectroflow.git
cd dlectroflow

# 2. Install deps + create the database (one command)
npm run setup        # = npm install && prisma migrate dev

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

SQLite by default — a file at `prisma/dev.db` (gitignored). Zero setup.

```bash
npm run db:migrate    # create/apply migrations after schema changes
npm run db:studio     # open Prisma Studio to browse data
```

> **Gotcha:** after running a migration, **restart `npm run dev`** — a running dev
> server holds a stale database client and will error on new tables until you do.

---

## 🐳 Deploy

### Option A — Docker (simplest, SQLite on a volume)

Good for a single-user instance or a demo.

```bash
# build
docker build -t dlectroflow .

# run (persist the SQLite db in a named volume; pass your key at runtime)
docker run -p 3000:3000 \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v dlectroflow-data:/data \
  dlectroflow
```

Migrations run automatically on start. Visit **http://localhost:3000**.

### Option B — any Node host

```bash
npm ci
npm run build
npm run db:deploy      # apply migrations (prisma migrate deploy)
ANTHROPIC_API_KEY=... npm run start
```

Set `ANTHROPIC_API_KEY` (and any other secrets) via your host's secret manager,
not a file.

### Scaling up to Postgres

SQLite is perfect for one person. For multi-user / serverless:

1. In [`prisma/schema.prisma`](prisma/schema.prisma), change the datasource
   `provider` from `"sqlite"` to `"postgresql"`.
2. Point `DATABASE_URL` at your Postgres instance.
3. Regenerate migrations for Postgres: `npm run db:migrate` (SQLite migrations
   don't transfer — the SQL differs).

> Full production hardening (Postgres + `.gitlab-ci.yml` pipeline) is the planned
> final build step.

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
- **Prisma 6** + **SQLite** (→ Postgres for scale)
- **Claude API** (`@anthropic-ai/sdk`, model `claude-opus-4-8`, adaptive thinking, streaming)
- **Reclaim** via OAuth 2.1 + the Claude remote-MCP connector
- Deploy: **Docker** (SQLite) / any Node host

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
