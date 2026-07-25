# Workspace-access Phase 2: guest cost controls, per-role models, local scheduling

**Date:** 2026-07-07
**Status:** Approved (design) — pending spec review before implementation planning
**Repo:** `gl-demo-ultimate-dtop/dlectroflow` (id 84020916)
**Builds on:** `docs/design/specs/2026-07-06-workspace-access-design.md` (Phase 1, shipped in MR !18)

## Problem

Phase 1 shipped owner login + isolated per-browser guest sandboxes, with every
data row scoped by `workspaceId`. What it did **not** do is bound the cost/abuse
surface: a guest can currently call the (Opus-tier) breakdown endpoint without
limit, on the owner's API credits. Phase 2 adds the guest cost controls, makes
the breakdown model configurable per role (and owner-selectable), gives guests a
genuinely useful *local* scheduling path that touches no owner credentials, and
surfaces guest status in the UI.

## Goals

- **Bound guest AI spend** with a per-guest allowance and a hard global daily
  ceiling — while keeping the "wow" of a live AI breakdown for guests.
- **Right-size the model per role** and let the owner pick their breakdown model
  from Settings (config seam formalised in Phase 1).
- **Give guests a usable scheduling payoff** (`.ics` calendar export) that needs
  no OAuth, no owner credentials, and costs nothing.
- **Make guest mode legible** — a dismissible intro banner plus a persistent
  status chip (allowance remaining + sandbox time left).
- **Pull the guest sandbox TTL forward** from Phase 3 so the countdown is real.

## Non-goals (this build)

- **Scheduled bulk purge** of expired guest workspaces — stays Phase 3. Phase 2
  does *opportunistic* purge on access only.
- **Self-serve accounts / persistent personal workspaces** — backlog.
- **Bring-your-own-LLM / local-model adapters** — only the config seam exists;
  no new adapter is built (BYOK is a "coming soon" banner line).
- **Perfect anonymous-abuse prevention** — impossible without login. IP-hash
  scoping raises the bar; the global cap is the hard cost ceiling (see below).
- **Live external scheduling for guests** (Google Tasks / Reclaim) — owner-only,
  unchanged from Phase 1.

## 1. Per-role breakdown model + owner Settings selector

The breakdown model is chosen by workspace role, read through the Phase-1 LLM
config seam:

- **Guest → Haiku 4.5** (`claude-haiku-4-5`), fixed. Cheapest available model;
  ample for a sandbox breakdown. Not user-selectable (it is a cost lever).
- **Owner → selectable** in **Settings ▸ Breakdown model**:
  - `claude-haiku-4-5` — *"Fastest, cheapest."*
  - `claude-sonnet-4-6` — *"Balanced."* **(default)**
  - `claude-opus-4-8` — *"Deepest reasoning, slower."*
  - `claude-fable-5` — **shown but disabled / greyed-out**, with a *rotating*
    tongue-in-cheek locked reason (pool of ~6, random with no immediate repeat;
    a fresh line each time the dropdown/panel opens). Seed lines include:
    - *"Our most capable model. Also $50/M tokens. To split 'clean the kitchen' into 3 steps? We love you, but no."*
    - *"We tried it. It wrote a dissertation on the philosophy of procrastination instead of your task. Disabled for everyone's safety."*
    - *"Reserved for problems harder than 'remember to buy milk.' 💸"*
    - *"Bringing a frontier reasoning model to a to-do list felt… irresponsible."*
    - (+2 more in the same voice)

**Storage & validation:**
- New nullable field `breakdownModel String?` on the owner's `Settings` row.
- The breakdown route resolves the model as: owner → `Settings.breakdownModel`
  → env `OWNER_BREAKDOWN_MODEL` → hard default `claude-sonnet-4-6`; guest → env
  `GUEST_BREAKDOWN_MODEL` → hard default `claude-haiku-4-5`.
- The resolved string is **validated server-side against an allowlist**
  (`claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-8`) before use; an
  off-allowlist value falls back to the role default. Never pass a raw
  client-supplied model string to the API. `claude-fable-5` is deliberately
  **not** in the allowlist (the UI already disables it; the server enforces it).
- **Per-model request params:** the current route uses adaptive thinking / a
  large `max_tokens` tuned for Opus. When switching models, send only params the
  target model supports (e.g. do **not** send `effort` to Haiku 4.5). This is an
  implementation note for the plan, not a design choice.

## 2. Guest AI allowance + global cap (one clock, IP-scoped)

- **Per-guest allowance: 5 breakdowns per salted-hash(client IP) over a rolling
  24h window.** The allowance is keyed on the **hashed IP, not the guest
  cookie** — so clearing cookies / opening incognito yields a fresh *empty
  sandbox* but **not** a fresh AI allowance. This closes the casual
  "restart-for-more" hole.
- **Global cap: 10 distinct guest IPs per UTC calendar day.** Once 10 distinct
  guest IP-hashes have used AI today, any *new* guest IP gets the fallback (a
  guest already counted today keeps their remaining personal allowance).
- **Owner: unlimited.**
- **The allowance counts breakdowns only.** For guests, focus-timer
  re-estimate, daily spark, and end-of-day rollup **always use their existing
  local/canned generators** — never a Claude call.

**Honest limitations (documented, accepted):** shared IPs (office/school/mobile
NAT) mean legitimate visitors behind one IP share the 5; a determined evader
with a VPN or rotating mobile IP can still cycle sandboxes. No anonymous scheme
beats this without login. The **global cap is the hard cost ceiling** regardless
of evasion: worst case is 10 IPs × 5 = **50 guest breakdowns/day** total.

**Privacy:** store only a **salted hash** of the client IP (salt from a secret
env var), plus a short-lived counter — never the raw IP. Counters expire with
their window / day.

### Data model

- `Workspace` (Phase 1): add `expiresAt DateTime` (guest sandbox TTL, §3).
- New `GuestAiUsage` — per-IP rolling window counter:
  `{ ipHash String @unique, count Int, windowStartedAt DateTime, updatedAt }`.
  On a guest breakdown: if `now - windowStartedAt >= GUEST_AI_WINDOW_HOURS`,
  reset `count = 0`, `windowStartedAt = now`; block when `count >= quota`; else
  increment.
- New `GuestDailyActivity` — distinct-guest tally for the global cap:
  `{ day String, ipHash String, @@id([day, ipHash]) }` where `day` is the UTC
  date. Presence of a `(day, ipHash)` row = "this guest used AI today"; the count
  of rows for today = distinct guests today. On a guest's *first* breakdown of
  the day, insert the row; if the row is absent **and** today's count `>= cap`,
  the global cap is hit → fallback.

Both tables are keyed by `ipHash` and hold no PII beyond the salted hash.

## 3. Guest sandbox lifetime (pulled forward from Phase 3)

- Each guest sandbox gets a **24h TTL** (`Workspace.expiresAt = createdAt + 24h`,
  tunable via `GUEST_SANDBOX_TTL_HOURS`).
- **On expiry:** the guest session token / workspace is treated as invalid at
  request resolution → the visitor is issued a **fresh, empty sandbox** (new
  `Workspace` + guest cookie).
- **Opportunistic purge:** when an expired guest workspace is encountered on
  access, its rows are deleted (cascade). The **scheduled bulk purge job stays
  Phase 3** — Phase 2 relies on purge-on-access only.
- The owner workspace is never given an `expiresAt` and is never purged.

## 4. Non-silent fallback UX

When a guest breakdown is blocked (personal allowance exhausted, global cap hit)
**or** any Claude call errors, the breakdown **still runs via the local canned
generator** and steps are still added to the task. The response carries a
`fallbackReason` (`"quota" | "global_cap" | "error"`) so the UI can show a
**quirky, non-silent** "out of AI tokens for today" message plus a short canned
reassurance ("you can still break tasks down and add them to your focus list").
Final micro-copy TBD during implementation; the *behavior* (visible, friendly,
still-functional) is fixed.

## 5. Guest indicator (banner + persistent chip)

- **Intro banner** — guests only, top of page, **dismissible per session**
  (a `sessionStorage` flag; reappears on a fresh browser session, which matches
  the ephemeral sandbox). Copy (owner-approved, adjusted to reflect that guests
  *do* get calendar export and the per-session allowance):

  > 👋 You're in guest mode — a private sandbox just for this browser session.
  > You get 5 AI-powered task breakdowns per session (on a speedy model), plus
  > the focus timer, rewards, and one-click calendar export — all yours. Live
  > integrations (Google/Reclaim) are owner-only for now. Self-hosted option and
  > BYOK coming soon.

- **Persistent chip** — after the banner is dismissed, an always-visible compact
  chip stays in the header/corner:

  > 🎫 Guest · ⚡ 3/5 breakdowns · ⏳ 18h left

  - The **⚡ meter** shows breakdowns remaining for this IP-hash window (reflects
    the server-side allowance — stays depleted across cookie clears).
  - The **⏳ countdown** shows time until *this sandbox* expires (from
    `Workspace.expiresAt`), ticking live client-side.
  - Clicking the chip re-expands the full banner.
  - Allowance-remaining + `expiresAt` are provided to the client on page load
    (server-rendered or a small read-only endpoint); the countdown is computed
    client-side from `expiresAt`.

## 6. Local scheduling — `.ics` "Add to calendar"

A guest (and the owner) can export a broken-down task to their **own** calendar
with no OAuth, no owner credentials, and no token cost:

- An **"Add to calendar"** action on a broken-down task (and/or the focus view)
  generates an **`.ics` file** and downloads it.
- One `VEVENT` per step, **sequenced from a start time** (default: the next top
  of the hour) using each step's **duration estimate** (fallback duration for
  steps without one, e.g. 25m). Back-to-back scheduling.
- **Floating local time** (no `TZID`) so events land at the intended wall-clock
  time in whatever calendar the user imports into.
- Generation is self-contained (string-built `.ics`); no external calls.
- Available to **guests and owner** — for the owner this is a no-integration
  alternative to the Google/Reclaim live sync.

## 7. Dark mode toggle (Settings)

A dark/light appearance toggle, available to **everyone** (owner and guest):

- Persisted **client-side in `localStorage`** (`df-theme` = `light` | `dark`) — no
  DB, no server round-trip, works identically for guests and owner.
- Applied by toggling the `dark` class on `<html>`; the app already ships the
  `.dark` CSS variable block (Tailwind v4 `@custom-variant dark`), so no new
  styling is needed — only the class toggle + persistence.
- A small **inline no-FOUC script** in the root layout `<head>` reads
  `localStorage` and sets the class **before hydration**, so there is no
  light-flash on load for a dark-mode user.
- The toggle control lives in the **Settings surface** (the inbox Settings
  panel), rendered for owner and guest alike.

## Identity & role resolution (unchanged from Phase 1)

Owner vs guest workspace resolution, the signed guest token, the owner allowlist,
and the owner-only integration gate are all Phase 1 mechanisms and are reused
as-is. Phase 2 adds: reading the **client IP** for the guest allowance (trust the
ingress-set forwarded header — document exactly which one, given ingress-nginx
sits in front in prod), hashing it with the secret salt, and the sandbox-expiry
check at resolution time.

## Config / secrets

New/confirmed environment configuration (all tunable; prod values via CI/CD
variables or baked into `.gitlab-ci.yml` as appropriate, consistent with
Phase 1):

- `GUEST_AI_QUOTA_PER_WINDOW=5` — breakdowns per IP-hash per window.
- `GUEST_AI_WINDOW_HOURS=24` — rolling allowance window.
- `GUEST_GLOBAL_DAILY_GUEST_CAP=10` — distinct guest IPs/UTC-day (circuit breaker).
- `GUEST_SANDBOX_TTL_HOURS=24` — guest sandbox lifetime.
- `OWNER_BREAKDOWN_MODEL=claude-sonnet-4-6` — owner default when Settings unset.
- `GUEST_BREAKDOWN_MODEL=claude-haiku-4-5` — guest model.
- `GUEST_IP_HASH_SALT` — **secret**, salts the IP hash (must be set in prod;
  reuse the Phase-1 boot guard pattern to fail fast if guest features are on but
  the salt is missing).

## Suggested build order

1. **Data model + config seam:** `Workspace.expiresAt`, `Settings.breakdownModel`,
   `GuestAiUsage`, `GuestDailyActivity`; migration; env plumbing + model
   allowlist helper.
2. **Per-role model resolution in the breakdown route** (+ owner Settings
   dropdown UI with the greyed-out rotating Fable line).
3. **Guest allowance + global cap enforcement** (IP hashing, both counters) with
   the non-silent fallback response.
4. **Guests never hit Claude outside breakdowns** — route re-estimate/spark/
   rollup to canned for guest workspaces.
5. **Sandbox TTL + expiry → fresh sandbox + opportunistic purge.**
6. **Guest banner + persistent chip** (allowance + live countdown).
7. **`.ics` "Add to calendar"** export (guest + owner).
8. **Owner breakdown-model picker** in Settings (server action + UI, greyed-out
   rotating Fable line).
9. **Dark mode toggle** (root-layout no-FOUC script + toggle in Settings).

## Testing

- **Allowance:** guest over `GUEST_AI_QUOTA_PER_WINDOW` → canned fallback,
  **no Claude call**; response `fallbackReason: "quota"`.
- **IP scoping:** two different guest cookies from the **same hashed IP** share
  one allowance (clearing cookies does not refresh it).
- **Global cap:** an 11th distinct guest IP in a UTC day → fallback
  (`fallbackReason: "global_cap"`); a guest already counted today keeps their
  remaining personal allowance.
- **Owner:** unlimited breakdowns; model = `Settings.breakdownModel` when set,
  else env/default; an off-allowlist stored value falls back to default;
  `claude-fable-5` can never be selected/honored.
- **Guest non-breakdown AI:** focus re-estimate / spark / rollup for a guest
  workspace never call Claude.
- **Sandbox lifecycle:** past-`expiresAt` guest → fresh empty workspace issued +
  old workspace rows purged on access; owner workspace never expires/purges.
- **`.ics`:** correct `VEVENT` per step, sequential start times, durations from
  estimates, floating local time; downloads for both guest and owner.
- **Fallback UX:** blocked/errored breakdown still adds steps and surfaces the
  quirky message.
- **Prod boot guard:** guest features enabled but `GUEST_IP_HASH_SALT` unset →
  hard fail at boot (mirrors Phase 1's auth-secret guard).
- **Dark mode:** toggling persists to `localStorage` and flips the `dark` class;
  a dark-mode user reloading sees **no light flash** (no-FOUC script); toggle is
  present for both guest and owner.

## Backlog (spec'd, not built)

- Scheduled bulk purge of expired guest workspaces (Phase 3 — GitLab schedule →
  secret-protected purge endpoint).
- Self-serve accounts + per-user integrations; "claim guest data into an
  account."
- BYOK / local-model adapter behind the `LLM_PROVIDER` seam.
- Stronger anonymous-abuse controls (device fingerprinting, proof-of-work) —
  only if the global cap proves insufficient in practice.
