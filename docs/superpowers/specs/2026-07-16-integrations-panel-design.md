# Integrations Panel + invalid_grant Token Cleanup — Design

**Date:** 2026-07-16 · **Issue:** #21 P2 (last sub-item) + #22 · **Approach:** A (approved)

## Problem

Three related gaps from the #21 audit and #22:

1. **Status lies.** `refreshAccessToken()` returns `null` on any failure without distinguishing
   `invalid_grant` (dead/revoked refresh token). Dead tokens stay in the DB and
   `getGoogleStatus().connected` reports `true` forever.
2. **Connect UI is buried.** The only Google connect affordance renders inside a task's
   breakdown view, immediately after saving a breakdown. There is no disconnect anywhere.
3. **Wording is Reclaim-specific** (#22): "Send to Reclaim (via Google Tasks)" etc., though the
   integration is Google Tasks; Reclaim is an optional downstream sync.

## Design

### Schema

`GoogleAuth` gains `needsReconnect Boolean @default(false)`. Additive migration only.
States: never-connected (no tokens, flag false) · connected (tokens present) ·
reconnect-needed (tokens cleared, flag true).

### `src/lib/google.ts`

- `refreshAccessToken()`: on non-2xx, parse the error body. `error === "invalid_grant"` →
  clear `accessToken`/`refreshToken`/`expiresAt`, set `needsReconnect: true`, return `null`.
  All other failures remain transient: return `null` without mutating stored tokens.
- `getGoogleStatus()` returns `{ configured, connected, needsReconnect }`.
- New `disconnectGoogle()`: best-effort `POST https://oauth2.googleapis.com/revoke`
  (prefer refresh token, fall back to access token, decrypted just-in-time), then delete the
  row. Revoke failure is logged and never blocks deletion. Idempotent when no row exists.
- `storeTokens()` resets `needsReconnect` to `false` (successful (re)connect heals the flag).

### Actions

- New owner-gated server action `disconnectGoogleAction()` (rejects non-owner requests the
  same way other owner actions do).
- `pushStepsToGoogleTasks` failure union gains `"reconnect_required"`, returned when the
  status flag is set (or when a push fails because refresh hit `invalid_grant`).

### UI

- **`src/components/settings/integrations-panel.tsx`** — descriptor-driven card list.
  A descriptor = `{ id, name, description, status, connectHref, disconnect? }`. Google is the
  only descriptor today; future integrations (LLM, email, calendar) add descriptors — no
  speculative backend abstraction now (their shapes are unknown).
  Card: status pill — Connected / Not connected / Reconnect needed / Not configured —
  plus Connect|Reconnect link (`/api/google/oauth/start`) and Disconnect button with an
  inline confirm step. Rendered on `/settings`, owner-only.
- **Breakdown-chat schedule section**: when `needsReconnect`, the schedule button degrades
  to a "Reconnect Google →" link. Wording genericized (#22): button "📅 Send to Google
  Tasks"; helper copy mentions Reclaim only as "a Reclaim-synced list is scheduled
  automatically".
- **README**: integration/scheduling wording matches the above. Stale mentions in
  `docs/dlectroflow-plan.md` / wireframe docs stay as-is (tracked under #21 P6).

## Error handling

- Disconnect is idempotent; revoke best-effort.
- Migration additive; no backfill required (existing connected row keeps `false`).
- Guests: settings page/actions remain owner-gated; no guest-visible change.

## Testing

- `google.test.ts`: `invalid_grant` clears tokens + sets flag; transient errors clear nothing;
  disconnect revokes + deletes (and tolerates revoke failure); status shape includes the flag;
  reconnect resets the flag.
- RTL: panel renders all four pill states; disconnect requires confirm; connect href correct.
- Breakdown-chat: reconnect CTA renders when flagged.
- Full suite stays green; runtime verify: local prod-build pass through connect → disconnect →
  reconnect with the dev Postgres.

## Out of scope

Reclaim card (write path unused; OAuth routes stay URL-reachable) · scheduling entry points on
task rows (separate spec) · provider backend framework.
