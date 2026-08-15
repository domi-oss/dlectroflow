# Quality Audit Prompts for dlectroflow

A layered set of prompts to run in **Claude Code** against this repo to raise the app
to production quality. Adapted from Richard Seroter's "quality-focused prompts for the
vibe coding addict" (four-layer *build a house* progression), rewritten for this stack:
non-standard Next.js, Prisma, GitLab CI, Google Tasks calendar integration, LLM-driven task
breakdown, and an ADHD target audience.

> Source: https://seroter.com/2025/07/07/quality-focused-prompts-for-the-vibe-coding-addict/

## How to use this file

Paste one prompt at a time into **Claude Code**. Every prompt is written to **report
first and patch only on approval**; keep that guard, especially on anything touching the
live domain. See the **Cadence** section below for *when* to run each layer — the first
time through, front-load by risk rather than running strictly 0→4.

Three ground rules baked into the prompts below:

1. **Non-standard Next.js.** Per `AGENTS.md`, this is not the Next.js in the model's
   training data. Claude must read the relevant guides in `node_modules/next/dist/docs/`
   before judging or refactoring any Next.js pattern.
2. **GitLab, not GitHub.** This repo already has `.gitlab-ci.yml`, a multi-stage
   `docker/Dockerfile`, `docker/docker-compose.yml`, `.env.example`, and Vitest. The deploy layer is an
   **audit-and-harden**, not a scaffold. Do **not** generate GitHub Actions.
3. **ADHD app.** Cognitive load is a functional requirement, not polish. That's Layer 0.

## Cadence

**One schedule, unified with `docs/SECURITY.md` and issue #16 (hosted-mode ops) — don't
re-run manually what CI/Duo already enforce.** CI already gates every MR with
`tsc`/`eslint`/`vitest` (incl. Postgres integration tests), all five scanners
(SAST + Advanced SAST, Dependency, Secret, Container) plus a Scan Result Policy, and
Duo's code-review + security-review bots. Weekly base-image rescans and Renovate already
run on a schedule. The table below is what a **human** runs *on top* of that floor.

| Bucket | Run |
|---|---|
| **Per-MR (automate in CI/Duo)** | The CI + Duo floor above, **plus** an axe a11y check, an `.env.example` drift check, and `prettier --check` (see Automation gaps). Scope the **Layer 2** review to diffs touching auth / token / LLM / Prisma paths. Don't manually repeat Duo's per-MR code smells or the scanners. |
| **Weekly (~30 min)** | Triage the weekly base-image rescan + Renovate MRs; #16 ops glance — site + `/api/health`, error-log scan, Anthropic + GKE spend, guest AI-cap sanity. |
| **Monthly** | Duo `security-assessment.md` full run (owns the generic security posture — see the Layer 2 scope note). One rotating **Layer 0** cognitive-load pass on the roughest-feeling flow. One **Layer 1** whole-repo smell + dependency-redundancy pass. |
| **Quarterly** | Full **Layer 0** WCAG-AA sweep across all flows. Threat-model refresh + **Layer 2** app-specific deep dive. Refresh these prompt files and `security-assessment.md`. |
| **Pre-release / on-demand** | **Layer 3** before onboarding more users or when the data/scale shape changes (also unlocks the #16 weekly health/spend checks). **Layer 4** when the `docker/` stack / CI / Prisma flow changes. Full **Layer 2** before anything touching user data hits the live domain. |

**Hard trigger:** run **Layer 2** before anything touching auth, tokens, or user-data
isolation reaches `dlectroflow.dev`.

**First pass (the app already has real users, so front-load by risk — not strictly 0→4):**
cheap CI automations → **Layer 2** Prisma isolation → **Layer 0** on the core
capture → clarify → schedule → focus → reward flow → **Layer 1** → **Layer 3** → **Layer 4**.
Budget ~5–7 h spread over 1–2 weeks in 30–60 min chunks.

Treat this as a **ratchet**, not a one-time ritual — the value is repetition catching new
debt each cycle. This file **defers to** `docs/SECURITY.md` (security cadence) and #16
(hosted-mode ops) rather than duplicating them.

### Automation gaps (turn manual prompt work into CI)

**All three of the gaps this section listed have since been closed**, and the
prompts below have been corrected to match. Left here as the record of what was
automated, because a prompt telling an agent to add a gate that already exists
burns a whole run and comes back with a confident wrong finding:

- ~~**`.env.example` drift check**~~ — **done.** `scripts/check-env-drift.ts` +
  `src/lib/env-drift.ts`, run as `npm run check:env` and folded into the
  `test_app` job.
- ~~**Mechanical a11y**~~ — **done.** `@axe-core/playwright` with nine specs under
  `e2e/a11y/`, gating on new serious/critical violations against
  `e2e/a11y/axe-baseline.json`. It rides `e2e_test` rather than taking its own job.
- ~~**Format gate**~~ — **done.** Prettier is installed, configured at
  `config/prettier.config.mjs`, and run as `npm run format:check`.
- ~~**Scheduled pipelines** — a weekly #16 health/spend digest and a monthly run of the Duo
  `security-assessment.md` (it already files a tracked issue).~~ **Done.** The weekly
  digest is the `ops_digest` job on the base-image rescan schedule; the monthly
  assessment is the `security_assessment` job on its own **Monthly security
  assessment** schedule (`SECURITY_ASSESSMENT=true`, #134). The job does not
  perform the assessment — it files the dated work item the prompt requires,
  pre-filled with the active-vulnerability snapshot, so the monthly bucket below
  starts from data instead of from a blank page.

---

## Layer 0 — Cognitive load & accessibility

*Attributes: usability, accessibility (the ADHD-specific quality attribute).*

```
Act as an accessibility and cognitive-load specialist reviewing an app whose users have
ADHD — so reducing friction, decision fatigue, and overwhelm is a functional requirement,
not a nice-to-have. Audit the UI in `src/`. Report on: (1) WCAG 2.1 AA gaps — contrast,
focus order, keyboard nav, touch-target size, screen-reader labelling; (2) cognitive-load
smells specific to this audience — screens with too many choices at once, missing "one
thing at a time" focus states, unclear next actions, punishing error/empty states, lost
work on interruption; (3) the capture → clarify → schedule → focus → reward flow — where a
distractible user could drop off or lose their brain-dump. Give me a prioritised list with
the specific file and a concrete fix for each. Don't change code yet.
```

## Layer 1 — Foundation: maintainability & flexibility

*Attributes: maintainability, flexibility, repeatability (at code level).*

```
Act as a senior engineer doing a maintainability review of dlectroflow. IMPORTANT: this is
a non-standard Next.js build — read the relevant guides in `node_modules/next/dist/docs/`
before judging any Next.js patterns, per `AGENTS.md`. Then: (1) find the top 5 code smells
(over-long/over-complex functions, unclear names, SRP violations) and show refactored
versions; (2) scan for hardcoded config/magic values that belong in env or a central
config; (3) review `package.json` dependencies for redundant/duplicate libraries that could
be consolidated (skip "outdated/deprecated" — Renovate + Dependency Scanning own that); (4)
confirm the ESLint setup enforces what it should and flag gaps (note: Prettier IS
installed and `npm run format:check` is a CI gate — audit the existing config at
`config/prettier.config.mjs`, do not propose adding one); (5) assess whether `README.md` and `docs/` would get a new
contributor running. Report first, patch only what I approve.
```

## Layer 2 — Walls & locks: security & reliability

*Attributes: security, reliability, availability.*

> **Scope:** the generic posture (secrets hygiene, container hardening, HTTP headers, OWASP
> input/output boundaries, GitLab platform config) is owned by the **monthly** Duo
> `.gitlab/duo/prompts/security-assessment.md` run and the five CI scanners. Run this layer
> for the four **app-specific** risks automation can't judge: LLM prompt-injection / PII,
> Prisma cross-user isolation, OAuth token at-rest/refresh/revoke *design*, and graceful
> degradation on outage.

```
Act as a paranoid security and reliability engineer. Cross-reference `docs/SECURITY.md` and
`.gitlab/duo/prompts/security-assessment.md` and produce an actionable, prioritised work
plan (not just prose) — focused on the four app-specific risks (defer generic posture to
the monthly security-assessment): (1) the OAuth/token flow — how GitLab sign-in and Google Tasks access &
refresh tokens are stored, scoped, refreshed, and revoked; flag anything at-rest in
plaintext or logged (note: #21 P2 added AES-256-GCM `TOKEN_ENC_KEY` — verify it holds);
(2) the LLM task-breakdown path — treat user brain-dump text as untrusted: prompt-injection
exposure, PII leaving to the model provider, and missing rate/cost limits; (3) Prisma data
isolation — can one user ever read another's tasks? check every query for a missing
user/workspace-scope filter (highest severity on a live multi-user app); (4) error handling
on DB, Google Tasks, and LLM calls so a third-party outage degrades gracefully instead of
crashing. Give me code-level fixes ranked by severity.
```

## Layer 3 — Engine & plumbing: performance, scalability & observability

*Attributes: performance, scalability, observability.*

```
Act as an SRE preparing dlectroflow to run reliably on its live domain. Analyse for:
(1) N+1 and slow Prisma queries, especially anything looping over tasks or calendar events
— suggest single-query or batched rewrites; (2) blocking/expensive work in request paths
(LLM calls, Google Tasks sync) that should be async, queued, or cached; (3) structured logging —
propose a JSON logging strategy with request/user IDs and convert a few key log points;
(4) the 3 metrics that matter most for this app (e.g. LLM latency & error rate, Google Tasks
sync success rate, task-completion funnel) and where to instrument them — these become the
inputs to the #16 weekly health/spend check; (5) horizontal-scaling blockers — any
in-memory state (sessions, caches, locks, LLM rate-limit counters) that must move to the DB
or a shared store. Report with specific files.
```

## Layer 4 — Assembly line: repeatability & deploy (GitLab)

*Attributes: repeatability, availability, scalability.*

```
Act as a DevOps engineer. This repo already has `.gitlab-ci.yml`, a multi-stage
`docker/Dockerfile`, `docker/docker-compose.yml`, `.env.example`, and Vitest — so audit and harden what
exists; do NOT scaffold GitHub Actions. Check: (1) `docker/Dockerfile` is genuinely lean and
multi-stage with no dev deps or secrets in the final image; (2) `.gitlab-ci.yml` runs lint,
`vitest`, a Prisma migration check, and a Docker build on every pipeline, and fails
properly when any stage fails (note: the `format:check` step exists and Prettier is
installed — audit it, do not propose adding it); (3) `docker/docker-compose.yml` spins up
the full stack (app + Postgres) with one command for a new contributor; (4) `.env.example`
lists every variable the app actually reads — diff it against real usage in the code (this
is the canonical home for the `.env` drift check; best turned into a CI job); (5) Prisma
migration safety — are migrations applied deterministically in the pipeline, and is there a
rollback story? Give me the concrete diffs.
```
