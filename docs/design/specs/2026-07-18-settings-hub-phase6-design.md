# Phase 6 — Settings hub finish (auto-save · Notifications · Daily-review nudge)

_#8 Phase 6. Milestone v0.1.0. Branch `feat/settings-hub`. One MR._

The `/settings` route + flattening + Integrations already shipped (!26/!27/!56).
Remaining scope, per #8 (owner 2026-07-18): **auto-save**, a **Notifications**
section, and a **Daily-review nudge**. Client-triggered delivery only — **no
server cron** (mirrors the existing end-of-day round-up in
`src/components/dashboard/roundup-card.tsx`).

## 1. Auto-save the settings (drop the Save button)

The voice toggle and breakdown-model picker already persist on change. Convert
the remaining Save-button-gated settings on `/settings` — the freshness/aging
thresholds (`agingThresholdMinutes`, `agingHours`, `overdueHours`,
`wayOverdueHours`) and any other Save-gated fields — to **auto-save on change**
(debounced for the numeric inputs), and **remove the Save button**. Each
auto-save calls the existing workspace-scoped settings action and shows a small,
transient "Saved" affordance (reuse whatever the voice/model pickers show; if
nothing, a subtle inline "Saved ✓" that fades). Auto-save must be resilient: a
failed write surfaces a non-blocking error and leaves the input editable.

## 2. Notifications section — per-type toggles

A new **Notifications** section on `/settings` with **separate** toggles (owner
decision: per-type, not a single master switch). All are gated at delivery time
by the browser Notification permission (reuse `src/lib/notifications.ts`:
`notificationsSupported`, `notificationPermission`, `requestNotificationPermission`,
`showReminder`). If permission is not yet granted, enabling a toggle prompts for
it (same UX as `roundup-card.tsx`).

- **End-of-day round-up** — `notifyRoundup Boolean @default(true)`. Gates the
  *browser notification* fired by the existing round-up (currently ungated
  except by permission). The in-app recap is unaffected. Wire `roundup-card.tsx`
  to skip `showReminder` when `notifyRoundup` is false.
- **Aging reminders** — `notifyAging Boolean @default(true)`. Gates browser
  notifications for items that age past threshold. **Implementation note:**
  verify whether aging→notification firing already exists in the inbox; if it
  does, gate it on this flag. If it is NOT already wired, this MR only persists
  the preference (do **not** build aging-notification firing from scratch here —
  that stays out of scope) and the toggle governs it once/if it lands.
- **Daily-review nudge** — `notifyDailyReview Boolean @default(false)` (opt-in;
  default off so it doesn't double-notify with the round-up at the same time) +
  `dailyReviewNudgeTime String @default("17:00")` (HH:mm). See §3.

## 3. Daily-review nudge behaviour

A client component (model it on `roundup-card.tsx`) active while the app is open
(mount in the dashboard/inbox area). When `notifyDailyReview` is on and
permission granted, at/after `dailyReviewNudgeTime` it fires **one** browser
notification per day ("Time for your daily review →"), guarded by a
`localStorage` day-key (`dlectroflow-review-nudge-fired-YYYY-MM-DD`, mirroring the
round-up's guard). Clicking it focuses the app and routes to the inbox (or
dashboard). No server job; if the app isn't open at the time, it fires on the
next open that day. A demo/"trigger now" override is optional (skip unless cheap).

## 4. Schema (additive migration)

Add to `Settings` (named migration, `prisma generate` run):
```
notifyRoundup       Boolean  @default(true)
notifyAging         Boolean  @default(true)
notifyDailyReview   Boolean  @default(false)
dailyReviewNudgeTime String  @default("17:00")
```
No backfill. Guest vs owner: same as existing settings (workspace-scoped);
guests keep their own values, no email involved.

## 5. Copy / voice

All new labels + the nudge text go through `t(key, voice)` in both `plain` and
`playful`. Plain stays emoji/jargon-free; the `→` in link text is a functional
glyph (allowed).

## 6. Tests (TDD)

- Settings action: persists each new field; workspace-scoped; validates
  `dailyReviewNudgeTime` is HH:mm.
- Auto-save: changing a freshness input calls the action (debounced); no Save
  button rendered; failure path leaves the field editable + shows an error.
- Notifications section: renders the three toggles; toggling calls the action;
  permission prompt path.
- Daily-review nudge (pure helper): given `now`, `dailyReviewNudgeTime`,
  `notifyDailyReview`, and the day-key state → decides fire / don't-fire.
  Extract this decision into a pure function for unit testing (don't test the
  browser Notification directly).
- String-map completeness for the new keys (both voices).

## 7. Out of scope

True persisted pause (#27), server-scheduled notifications, building
aging-notification firing from scratch, email for the nudge.
