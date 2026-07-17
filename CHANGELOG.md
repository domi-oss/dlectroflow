# Changelog

All notable changes to **dlectroflow** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is pre-`1.0`, it stays on the `v0.x` line; `v1.0.0` will mark the
stability promise. Each pushed `vX.Y.Z` git tag builds a versioned container image
(`:vX.Y.Z`) alongside `:latest`. **Upgrade sequentially through minor versions**
(Prisma migrations run on container start); downgrades are not supported.

Sections group changes as **Added / Changed / Fixed / Security**. **Breaking
changes** and **new required environment variables** are called out explicitly so
operators upgrading a self-hosted instance don't get surprised.

## [Unreleased]

> Shipped to production but not yet tagged. At cut time this becomes
> `## [0.1.0] - <date>` and a fresh empty `## [Unreleased]` is added above it.

### ⚠️ Upgrade notes (operator action required)

- **New required env var in production:** `TOKEN_ENC_KEY` — a 64-hex-character
  (32-byte) key used to encrypt OAuth tokens at rest (AES-256-GCM). The app now
  **refuses to boot in production** if it is missing or malformed. Generate with
  `openssl rand -hex 32`. This joins the existing production boot-guard set
  (`AUTH_SESSION_SECRET` ≥32 chars, `OWNER_ALLOWLIST`, `GITLAB_OAUTH_CLIENT_ID`,
  `GITLAB_OAUTH_CLIENT_SECRET`, `GUEST_IP_HASH_SALT` ≥16 chars). `PUBLIC_ORIGIN`
  is also required in production (used to derive OAuth redirect origins).
- **App ↔ database now requires TLS** (`sslmode=require`). Ensure your PostgreSQL
  presents a certificate the app trusts before upgrading.

### Added

- Complete + Completed bucket board: drag items between buckets, a "Move to…"
  menu, and a per-step Reopen picker (#10).
- Inbox information-architecture overhaul — a 4-tier freshness model,
  freshness-aware sort, a "freshen" action, and a ☰ navigation menu.
- Task-row and step-row redesign with inline row-level scheduling, and reward
  parity when scheduling a single task (#25).
- Settings → Integrations panel for connecting Google Tasks, with automatic
  cleanup of revoked/expired tokens (#22).
- In-app getting-started docs at `/help`, linked from Settings and the nav menu.
- Voice/tone foundation (Plain / Playful) with voice-aware step labels.
- Breakdown editor controls: step emoji picker and add/remove-step, plus
  send-to-review.
- Daily automated PostgreSQL → GCS backups with retention, plus a documented
  `helm --atomic` rollback runbook.
- Operational observability: process-only liveness probe and surfaced AI
  provider failures instead of silent errors.

### Changed

- Routine dependency and base-image maintenance via Renovate: Next.js/React
  ecosystem, ESLint 9, Anthropic SDK, jsdom, lucide-react, resend, shadcn,
  Kaniko executor, helm-kubectl, and the Node base image; `framer-motion`
  replaced by its `motion` successor.
- CI/tooling reliability: switched Renovate to the `-full` image and bumped it
  39 → 43 to fix lock-file artifact crashes (#24); deferred the ESLint (<10) and
  TypeScript (<6.1) majors until the plugin chain supports them.
- Repointed deploy references to the `gl-demo-ultimate-dtop/domi-oss` subgroup.
- Ignore `.claude/` agent worktrees in git and ESLint.

### Fixed

- Intermittent 503s during rollouts — run 2 app replicas behind a
  PodDisruptionBudget.
- Duplicate end-of-day round-up email — an atomic claim replaces a
  check-then-act race (#18).
- Board drag-and-drop on touch / mobile screens (#26).
- Inverted "More / Fewer" control in the breakdown editor.

### Security

- **Encrypted OAuth tokens at rest** (AES-256-GCM) so a database dump alone does
  not expose them. Introduces the required `TOKEN_ENC_KEY` (see Upgrade notes).
- **Enforced TLS between the app and the database** (`sslmode=require`), plus a
  documented database-leak credential-rotation runbook.
- **Session and cookie hardening** — signing-algorithm pinning, hardened guest
  and owner session cookies, an owner session lifetime, POST-based logout, and
  safer forwarded-header handling.
- **Hardened validation of outbound request targets** to prevent server-side
  request forgery.
- **Robustness fixes** across concurrency- and parsing-sensitive paths.
- **Owner-gated the round-up email** configuration and send path, removing a
  guest-accessible route.
- **CI security gate** — type-check, lint, and tests now run ahead of image
  build and deploy, so a red suite can't reach production.

## [0.0.1] - 2026-07-08

Baseline — first tracked release of the shipped app.

### Added

- Core ADHD loop: **capture → clarify → schedule → focus → reward** — brain-dump
  capture with triage and aging reminders, Claude-powered task breakdown
  (streaming chat), scheduling into Google Tasks / Reclaim, a focus timer, and a
  rewards dashboard with streaks and badges.
- Desktop notifications with a demo override.
- End-of-day round-up (in-app + desktop) and opt-in round-up email (Resend).
- Workspace access **Phase 1** — owner GitLab OAuth login plus isolated
  per-browser guest sandboxes.
- Workspace access **Phase 2** — guest AI cost controls (per-IP and global daily
  caps), per-role breakdown models, client-side `.ics` calendar export, a 24-hour
  guest sandbox TTL, and dark mode.
- GKE Autopilot deployment with valid TLS, per-MR review apps, and the full
  GitLab security-scanner suite.

[Unreleased]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.0.1...main
[0.0.1]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/releases/v0.0.1
