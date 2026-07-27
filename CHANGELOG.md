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
> `## [X.Y.Z] - <date>` and a fresh empty `## [Unreleased]` is added above it.

### Changed

- **The container image is ~4× smaller (#71).** Measured on the same build,
  registry-equivalent (gzipped layers): **795 MB → 198 MB**, a 75% cut. Almost
  none of the bulk was the app. The runtime stage ran `npm install` with `/app`
  as the working directory, so npm treated the standalone output's
  `package.json` as the project manifest and reinstalled the **entire**
  dependency tree — 392 packages including `next`, `typescript`, `playwright`
  and `@next/swc` — on top of the minimal `node_modules` that
  `output: "standalone"` had just traced, and kept npm's 885 MB tarball cache
  in the same layer (408 MiB compressed). A closing `RUN chown -R node:node
  /app` then rewrote every file, writing a second copy of the whole app into
  another layer (219 MiB compressed). The migrate/seed/purge CLIs (`prisma`,
  `tsx`, `dotenv`) now install into an isolated prefix and are grafted into
  `/app/node_modules`; ownership comes from `COPY --chown`.
  - **Nothing was removed.** The bundled lo-fi audio (29 MB, #43) — which the
    0.4.0 note above blamed for the size — stays, and `npx prisma migrate
    deploy`, `npx tsx prisma/seed.ts` and the purge CronJob were all verified
    to still run from the image. The image's `tsx` pin also caught up with the
    lockfile (4.19.2 → 4.23.1, the version #67 realigned on).
  - **Operators:** no action. The `helm --timeout` values raised in 0.4.0
    (production 20m, review 15m) are left as they are — they are now headroom
    rather than a requirement.

## [0.4.0] - 2026-07-27

**Focus-session depth + bring-your-own-model.** A focus session is now something you
can sit inside for an hour: real lo-fi music with a playlist that actually moves on,
a pause that survives a reload or a second device, and a setup screen that puts one
number and one action in front of you instead of four competing figures. Alongside
it, the dormant LLM seam is live — a self-hoster can point dlectroflow at a local
model or another vendor instead of needing an Anthropic key.

### ⚠️ Upgrade notes

- **This release migrates the database.** Four Prisma migrations run on container
  start: `FocusSession.pausedAt` + `accumulatedPausedMs` (#27), a widened
  `Settings.focusSound` CHECK constraint (#43), `Settings.focusShuffle` (#68), and a
  **one-off data cleanup that deletes orphaned `Task` rows** (#64). The schema
  changes are additive and default-valued; the cleanup is idempotent and only
  removes rows that were already unreachable from the Library. Still: take a backup
  and upgrade sequentially from 0.3.0.
- **New environment variables — required only if you change LLM provider (#59).**
  `LLM_PROVIDER` still defaults to `anthropic`, and that path is unchanged, so an
  existing deployment needs no config edits. Setting
  `LLM_PROVIDER=openai-compatible` makes **`LLM_BASE_URL` and `LLM_MODEL`
  boot-required in production** — the app refuses to start without them rather than
  failing at first use. Optional alongside them: `LLM_API_KEY` (omit it for local
  runners that need none), `LLM_OWNER_MODEL` / `LLM_GUEST_MODEL` (per-role split,
  each falling back to `LLM_MODEL`), and `LLM_SUPPORTS_TOOLS=false` for a model
  without native tool-calling. All documented in `.env.example`.
- **The container image is larger** (~893 MB) because the lo-fi tracks are bundled
  (#43). A cold rollout onto fresh nodes now spends real time pulling it, so the
  deploy jobs' `helm --timeout` was raised (production 10m → 20m, review 10m →
  15m). If you deploy with your own `helm --timeout`, raise it too — the first
  rollout of this version can otherwise time out and roll back on time alone,
  with healthy pods.

### Added

- **Bring-your-own-LLM (#59):** the `LLM_PROVIDER` seam is now real. A `getLLM()`
  factory serves one normalized provider interface behind every AI call (task
  breakdown, daily spark, end-of-day round-up, focus re-estimate), with two
  adapters: `anthropic` (today's behaviour, unchanged) and `openai-compatible` —
  one adapter covering hosted vendors (OpenAI, OpenRouter, Groq, Together) and
  local runners (Ollama, LM Studio, vLLM) via a base URL. Models for a
  non-Anthropic provider come from env rather than the built-in allowlist, and a
  model **without** tool-calling still works: steps are requested as JSON in the
  response and, if that can't be parsed, the deterministic local breakdown takes
  over. Provider health is surfaced on `/api/livez` (`llmFailures`), and retryable
  429/5xx responses get bounded backoff (never mid-stream).
- **Real lo-fi focus music (#43):** the placeholder sound is replaced by 10 curated
  **CC0** tracks (one per open-lofi category, bundled — no external requests, no new
  CSP origin, provenance recorded in `public/audio/LICENSE.md`). Settings gains a
  track picker with per-track preview, and `/focus` gets a mini-player
  (play/pause, prev/next, volume, now-playing as text). The music is coupled to the
  timer: pausing the session pauses the music, resuming resumes it, and it stops
  when the session ends.
- **The playlist moves on, and can shuffle (#68):** a track no longer loops
  forever. Playback walks the library as a "pass", so nothing repeats until the
  pass is exhausted, and Shuffle deals a shuffled copy of that order up front
  (rather than picking at random per track, which is what made it feel repetitive).
  The preference persists per workspace. This is Phase 1 — per-category playlists
  wait on catalog streaming (#61).
- **True pause/resume for the focus timer (#27):** pausing is now persisted, not
  just local React state, so a paused session survives a reload or a move to
  another device. The clock freezes at the pause instant — a session left paused
  overnight doesn't silently drain — and resuming returns the exact remaining time
  you left, across any number of pause/resume cycles. Pressing Start on a step with
  a genuinely paused session offers **both** "Resume · ~Xm left" and "Start fresh"
  instead of guessing. Task-level "time left" figures now derive from the same
  effective-remaining calculation, so the step and the task agree.

### Changed

- **Focus setup screen: one number, one action (#66).** The pre-session screen
  showed up to four figures at once (ring countdown, step-context line, the Resume
  button's own estimate, and a duration input) — and in the resume case two of them
  contradicted each other. Now the ring shows a single number labelled for what it
  is, there is one primary action, duration is a chip row (5/10/15/25m, plus the
  step's own estimate when it's off-preset) instead of a free-type input, and
  "Start fresh" reveals the chips only when asked — reversibly, so a mis-tap can't
  retire a paused session. On a multi-step task, `Step N of M` becomes the header
  eyebrow and the whole-task total is demoted to one quiet line: re-ranked, not
  removed.
- **CI is faster without weakening any gate (#53):** the image build no longer
  waits on tests it doesn't consume — the "no deploy from a red suite" gate moved
  downstream to the deploy jobs, and tag pipelines explicitly re-add the test gate
  so a release image can never be published from a red suite. Secret detection was
  deduplicated.
- **Dependency health:** `react` + `react-dom` upgraded to 19.2.8 as a peer pair,
  with a Renovate grouping rule so the React peer set always lands in one MR;
  `@axe-core/playwright` pinned; `google/cloud-sdk:slim` and `renovate/renovate`
  image digests refreshed.
- README now opens with an AI-built + no-warranty transparency note.

### Fixed

- **Phantom tasks in the focus launcher, and completions that never reached the
  Library (#64).** Deleting a captured item left its linked `Task` behind: the
  Focus launcher reads `Task` directly and kept offering the orphan forever, while
  the Library (which reads only captured items) couldn't see it at all — so
  completing it wrote to zero rows. Deletion now removes the linked task in the
  same transaction, and the migration clears orphans created before the fix.
- **Mobile drag preview (#62):** dragging an inbox row showed a grip-sized sliver
  with the title wrapped to one word per line; the drag ghost now sizes to its own
  content and reads as a full row, as it does on desktop.
- **Cramped breakdown step rows on mobile (#63):** the step row's controls now
  stack below `sm:` instead of overflowing and truncating the step text.
- **The saved-for-later "Review now" button failed WCAG-AA contrast (#56).** The
  idle row dimmed itself with `opacity-70`, which composited the brand-coloured CTA
  toward the background (~3.3:1). The dim now applies to the title line only, so
  the row still reads as asleep while the CTA stays at 5.4:1 (light) / 6.3:1
  (dark).
- **Renovate-generated lockfiles could no longer be installed by CI (#67):** two
  dependents needed incompatible `esbuild` ranges, so npm nested a second copy —
  and Renovate's newer npm dropped that nested subtree while keeping the package
  requiring it, so every dependency MR failed `npm ci` immediately. Upgrading
  `tsx` collapses `esbuild` to a single hoisted version, leaving nothing for the
  two npm versions to disagree about. Tooling only: no user-facing change.

## [0.3.0] - 2026-07-26

The **open-source launch**: dlectroflow is now public under AGPL-3.0, running on its
own domain, with a visual-identity refresh and a batch of UX + accessibility polish.

### Added

- **Visual identity refresh** (#40): a real app icon / brand mark (favicon + in-app),
  a Settings typeface picker, brand accents across nav, and hero-surface polish.
- **Open-source project files**: `LICENSE` (**AGPL-3.0**), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`; README rewritten self-host-first with a live-demo pointer and
  a Roadmap section.
- **Guest read-only settings** (#11): guests see the owner settings UI, disabled, so
  the app's capabilities are legible without exposing owner-only controls or values.
- **Stale-reminder as a notification chip** (#57): the "still needed?" nudge is now a
  compact, tinted, glanceable chip instead of muted background text.

### Changed

- **Primary domain is now `dlectroflow.dev`** (#54). The previous
  `dlectroflow.dlectronique.dev` permanently redirects to it (path + query preserved).
  Self-hosters set their own `host`; the app's origin is env-driven (`PUBLIC_ORIGIN`).
- **Inbox row hierarchy** (#50/#51/#52): the task title is the dominant element, the
  age/status pill moved down to the metadata line, and the stale banner no longer
  outweighs the row.
- **Inbox is served at the root `/`** (#58); `/inbox` permanently redirects to it.
- **Dark-mode toggle moved into the app header** (#49).
- Repo tidied for public consumption (internal design docs under `docs/design/`).

### Fixed

- `/library` tab-count pill failed WCAG-AA contrast once state accumulated (#48);
  fixed and the axe accessibility gate now covers `/library`.
- Aging label + nav aging-count contrast, and the "Help & Docs" footer spacing/casing.

### Security

- Bumped `brace-expansion` past **CVE-2026-14257** (High, DoS) (#55).
- Hardened the repository for public release: full git-history secret scan (clean),
  personal/infra fingerprint scrubbed from docs/config/CI, CI job logs made private,
  per-feature project visibility locked down before going public.

## [0.2.0] - 2026-07-22

Generalizing the scheduling stack for open-source (epic #29) and closing the loop
from *scheduled* → *focusing*, plus a CI/quality-gate build-out, Helm hardening,
and dependency/data-integrity security fixes.

### ⚠️ Upgrade notes (optional — no breaking changes, no new required env vars)

- **Preserve real client IP for the guest quota (#28):** the fix is a cluster-side
  ingress-nginx change (`controller.service.externalTrafficPolicy=Local` + ≥2
  controller replicas + a PDB via `controller.minAvailable`), not a chart change —
  apply it per `docs/deploy-runbook.md`. Until then the per-IP guest quota can be
  bypassed via node-IP SNAT collapse.
- **Weekly ops digest (#33):** posts only once the `OPS_DIGEST_ISSUE_IID` and
  `GL_TOKEN` (Reporter + `api`) CI variables are set; until then it runs a harmless
  preview and never fails the schedule.

### Added

- **Focus deep-link in scheduled events (#39):** a scheduled task's `.ics` events
  and Google Tasks now carry a short voice-aware note plus an absolute deep-link
  straight into the `/focus` timer.
- **/focus redesign (#41):** a step-picker launcher (resume hero + lanes), a
  redesigned timer with four styles (ring / digits / bar / mug) + previews and an
  optional completion alarm chime, and an app-wide completion-style Appearance
  setting (strikethrough + tick colour, WCAG-AA).
- **Scheduling-provider seam (#34):** `{ics, googleTasks}` behind one interface
  with a shared schedule + reward path — the foundation for generalized scheduling.
- **Weekly ops digest (#33):** a scheduled pipeline posts prod health, failed-CI,
  security, and dependency-upgrade signals to a standing tracking issue.
- **Playwright E2E smoke suite (#37):** browser tests across the core flows, wired
  as a blocking merge gate.
- **CI quality gates:** Prettier + `prettier --check` formatting (#32), a mechanical
  accessibility (axe) check on core routes (#31), and an `.env.example` drift check
  that fails on missing/extra keys (#30).

### Changed

- **Dropped Reclaim (#36):** removed the Reclaim client/model/routes; scheduling now
  flows entirely through the provider seam.
- **Helm chart hardening (#15):** opt-in spot-instance toleration, a CPU-limit
  throttling fix, and Renovate tracking for `values.yaml` image tags.

### Fixed

- Flaky roundup-card notification that fired twice and produced false CI failures
  (#42).

### Security

- **`sharp` → 0.35.3** via a `package.json` override, remediating inherited libvips
  vulnerabilities CVE-2026-33327 / -33328 / -35590 / -35591 (#47). Transitive via
  Next.js image optimization; low exploitability (no untrusted-image surface).
- **DB-level CHECK constraints** on status/role columns (pseudo-enums) enforcing
  data integrity at the database (#38).
- **Real client-IP preservation at the ingress (#28)** so the per-IP guest quota
  can't be bypassed (see upgrade notes).

## [0.1.0] - 2026-07-19

The wireframe → product build (#8): a Plain/Playful voice layer, inbox
information architecture, the Library hub, settings hub, and an accessibility
pass — plus the #21 security-hardening suite and guest-data retention.

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
- Library "Everything" hub — a dedicated `/library` view with Single-task /
  Multi-step / Saved-for-later / Done tabs, per-row actions, and a single-open
  expand/collapse toggle (#8).
- First-run welcome card, a non-destructive "first-run preview" demo toggle, and
  a low-shame "Pause for now" focus exit with an Inbox "resume →" banner (#8).
- Settings hub finish — freshness settings that auto-save (the Save button is
  gone), per-type desktop-notification toggles (end-of-day round-up / aging
  reminders / daily-review nudge), and a client-triggered daily-review nudge (#8).

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
- Accessibility pass — honour `prefers-reduced-motion` (the focus confetti no
  longer animates under reduce), WCAG-AA contrast in both light and dark themes,
  ≥44px touch targets, and status conveyed by text/icon (never colour alone) (#8).

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
- **Guest-data retention** (#21) — a 30-day purge of IP-hash-keyed guest
  rate-limit counters plus an owner-guarded cascade delete of expired guest
  workspaces, run by a daily production-only CronJob. Workspace-scoped rows now
  cascade via foreign keys, so no orphaned guest data lingers after a sandbox
  expires.

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

[Unreleased]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.4.0...main
[0.4.0]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.3.0...v0.4.0
[0.3.0]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.2.0...v0.3.0
[0.2.0]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.1.0...v0.2.0
[0.1.0]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/compare/v0.0.1...v0.1.0
[0.0.1]: https://gitlab.com/gl-demo-ultimate-dtop/domi-oss/dlectroflow/-/releases/v0.0.1
