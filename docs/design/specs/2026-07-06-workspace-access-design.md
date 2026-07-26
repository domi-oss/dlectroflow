# Workspace-scoped access: owner login + guest sandboxes

**Date:** 2026-07-06
**Status:** Approved (design) — pending spec review before implementation planning
**Repo:** `gl-demo-ultimate-dtop/dlectroflow` (id 84020916)

## Problem

The production app (https://dlectroflow.dev) is open to the internet
with a **persistent, shared** data layer. Anyone visiting can see and pollute the
owner's Brain Dump inbox — which is meant to be a private "safe space". There is
currently **no auth and no data scoping**: no `userId`/workspace on any model, no
middleware, no auth library. `ReclaimAuth`/`GoogleAuth` are single global rows.

## Goals

- The owner's data becomes **private** — reachable only after the owner signs in.
- **No hard wall:** any visitor can land and *use* the app immediately (friends,
  family, curious customers), in their own isolated sandbox.
- Guests can use the AI (the "wow" feature) but **cost/abuse is bounded**, and
  guests can **never** touch the owner's connected accounts (Google/Reclaim/email).
- Keep the door open to (a) full self-serve multi-user and (b) open-source /
  self-hosting, by building **config seams** now — without building every
  adapter yet.

## Non-goals (this build)

Documented as **backlog**, not built here:

- Self-serve accounts for other people (persistent personal workspaces).
- Bring-your-own-LLM / local model adapters (only the *config seam* is built).
- Per-user integration tokens (Google/Reclaim/email stay owner-only globals).
- "Claim your guest data into an account" migration.
- Generic self-host `docker-compose` and genericized Helm chart.

## Core model: workspaces

Every user-data row belongs to a **workspace**. Two kinds:

- **Owner workspace** — singleton, persistent, private. The owner's *current
  data is backfilled into it* (nothing lost). Reachable only with a valid owner
  session.
- **Guest workspace** — one per browser (signed guest cookie), created lazily on
  first write, ephemeral (48h TTL), capped.

### Data model (Prisma migration)

- New `Workspace` table: `id` (uuid), `kind` (`owner` | `guest`), `createdAt`,
  `lastSeenAt`.
- Add `workspaceId` (FK → Workspace) to top-level models: `BrainDumpItem`,
  `Task`, `FocusSession`, `DayRollup`, `RewardEvent`, `Streak`, `StreakRecord`,
  `Badge`, `DailySpark`, `Settings`. Child models (`Step`, `BreakdownTurn`)
  inherit scope via their parent `Task`.
- **Backfill migration:** create the owner workspace; assign all existing rows to
  it.
- `ReclaimAuth` / `GoogleAuth` remain **owner-only global rows** (not
  workspace-scoped).
- All reads/writes are scoped by the current `workspaceId`, resolved per request.

## Identity & access

### Owner authentication (config-driven, provider-abstracted)

- A small provider interface: `buildAuthorizeUrl()` / `exchangeCode()` /
  `fetchIdentity()`. **Only the GitLab implementation is built now**; the seam
  makes adding Google/others trivial.
- Config:
  - `AUTH_PROVIDER` (e.g. `gitlab`) — selects the provider.
  - `OWNER_ALLOWLIST` — comma-separated allowed identities (ids/emails).
  - This instance: `AUTH_PROVIDER=gitlab`, `OWNER_ALLOWLIST=1234567`.
- Flow: `/login` → "Sign in with {provider}" → `/api/auth/{provider}/start`
  (authorize URL, PKCE + signed `state` cookie, minimal identity scope
  e.g. GitLab `read_user`) → `/api/auth/{provider}/callback` → fetch identity →
  if identity ∈ `OWNER_ALLOWLIST` set signed owner session cookie, redirect `/`;
  else 403 "not authorized" (visitor stays a guest).
- `/api/auth/logout` clears the owner cookie (falls back to guest).
- MFA is inherited from the identity provider — nothing to build.
- Implementation mirrors the existing hand-rolled OAuth in `src/lib/google.ts` /
  `src/lib/reclaim.ts`. New small dependency: **`jose`** (sign/encrypt cookies).
  Auth.js (next-auth) was considered and rejected for now (heavy dep, shaky on
  Next 16.2); revisit only if full multi-user warrants it.

### Guest identity

- No login. On first request without any session, middleware issues a signed
  `{kind:"guest", wsId:<uuid>}` cookie. The guest `Workspace` row is created
  lazily on first write.

### Middleware (`src/middleware.ts`)

Not a wall — it **resolves workspace context** for every request:

- Owner cookie present + valid → owner workspace.
- Else guest cookie (issued if missing) → that guest workspace.
- **Public/untouched:** `/api/health` (k8s probe — must stay 200 unauthenticated),
  Next static assets, `/login`, `/api/auth/*`.
- **Owner-only** (else 403 / redirect to `/login`): integration connect + OAuth
  callbacks for Google/Reclaim, and integration settings.

## Guest cost & abuse controls

- **AI quota:** guests get **5 breakdowns/day/guest** + a **global daily cap**
  (circuit breaker). Over limit → graceful local fallback (canned breakdown).
  Owner: unlimited.
- **Scheduling:** guest "schedule" is **always the local fallback** — never the
  owner's Google Tasks / Reclaim / email. Connect buttons hidden for guests.
- **Item caps** per guest (e.g. 50 brain-dump items / 20 tasks) to bound abuse.
- Counters tracked per workspace (daily reset).

## Guest banner

Guests only, dismissible per session:

> "Guest mode — AI is rate-limited on purpose and scheduling is local-only.
> Your own account + bring-your-own-AI is coming."

## Lifecycle / cleanup

- Guest workspace purged after **48h of inactivity** (`lastSeenAt`), cascading
  its rows.
- Cleanup runs via a **GitLab pipeline schedule** hitting a secret-protected
  purge endpoint (`/api/admin/cleanup-guests`, guarded by a shared secret) —
  consistent with the existing rescan / Renovate schedules. (Opportunistic
  purge-on-access is a cheap secondary safety net.)

## LLM config seam (for future BYO-LLM / self-host)

- The app already reads the model key from `process.env` provider-agnostically.
  Formalize an `LLM_PROVIDER` + key/endpoint config seam and document it in
  `.env.example`. **Anthropic implementation only** for now; local /
  OpenAI-compatible adapters are backlog.

## Config / secrets

New/confirmed environment configuration:

- `AUTH_PROVIDER`, `OWNER_ALLOWLIST` — owner auth (config-driven).
- `GITLAB_OAUTH_CLIENT_ID` / `GITLAB_OAUTH_CLIENT_SECRET` — GitLab OAuth
  application (redirect URIs: prod
  `https://dlectroflow.dev/api/auth/gitlab/callback` + local
  `http://localhost:3000/api/auth/gitlab/callback`, scope `read_user`).
- `AUTH_SESSION_SECRET` — random 32+ bytes (cookie signing/encryption).
- `GUEST_AI_DAILY_QUOTA=5`, `GUEST_AI_GLOBAL_DAILY_CAP=<n>`, `GUEST_TTL_HOURS=48`,
  guest item caps — tunable.
- `LLM_PROVIDER` (+ existing model key) — LLM config seam.
- `GUEST_CLEANUP_SECRET` — guards the purge endpoint.
- Reuses existing `PUBLIC_ORIGIN` (host-header fix) for redirect URIs.

**Fail-safe:** in production the app **hard-fails at boot** if owner auth secrets
(`AUTH_SESSION_SECRET`, provider client id/secret, `OWNER_ALLOWLIST`) are unset —
so it can never accidentally deploy with the owner's data reachable. Mirrors the
existing `PUBLIC_ORIGIN` prod guard.

## Suggested build order

So the owner's data is protected ASAP with no throwaway work:

1. **Workspace model + backfill + scoping + owner login (GitLab) + guest cookie.**
   → owner data becomes private; guests get fresh empty sandboxes. Deploy.
2. **Guest AI rate-limiting + local-only sync enforcement + banner.**
3. **Guest lifecycle cleanup (48h) + item caps.**

Config seams (auth provider abstraction, `OWNER_ALLOWLIST`, LLM seam) land in
step 1 since that's where the auth/config code is written.

## Testing

- Workspace scoping isolation: a guest cannot read/write owner rows (and vice
  versa); two guests are isolated.
- Middleware: no session → guest cookie issued; owner cookie → owner workspace;
  `/api/health` stays public 200; static assets pass.
- Owner auth: identity ∈ `OWNER_ALLOWLIST` → owner session; not in list → 403,
  stays guest. `state`/PKCE validated.
- Owner-only gate: guest hitting integration connect/callbacks → 403.
- Guest AI quota: over `GUEST_AI_DAILY_QUOTA` → local fallback, not a Claude call.
- Guest scheduling never calls Google/Reclaim/email.
- Cleanup: guest workspace past TTL is purged (rows cascade); owner workspace
  never purged.
- Prod boot guard: missing owner secrets → hard fail in production.
- Manual prod smoke: `/api/health` 200 unauthenticated; `/` usable as guest;
  GitLab round-trip logs the owner into their private data.

## Backlog (spec'd, not built)

- Self-serve accounts (persistent personal workspaces) + per-user integrations.
- Bring-your-own-LLM / local-model adapters behind the `LLM_PROVIDER` seam.
- "Claim guest data into an account" on sign-up.
- Open-source / self-host: full git-history secret scan + rotation (hard gate
  before making the repo public), license + `SECURITY.md` + `CONTRIBUTING.md`,
  public namespace (separate from the internal demo group), generic
  `docker-compose` + genericized Helm chart (your GKE/Secrets-Manager specifics
  become a private overlay).
