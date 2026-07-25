# Focus Timer Redesign + Settings — MR ② Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the `/focus/[stepId]` timer page (single/multi-aware hierarchy, a consistent ← Back, four visual styles, symmetric ±time, a segmented step tracker, focus sounds / alarm / keep-awake, a minimal mode, and a first-run customization hint) and add the persisted **Focus timer** settings group that drives it — all built on small, unit-tested pure seams with browser APIs mocked at the edge.

**Architecture:** The timing math and the style resolution are extracted into two DB/React-free seams (`src/lib/focus-timer-clock.ts`, `src/lib/focus-timer-style.ts`) with exhaustive unit tests. All device effects (alarm chime + vibrate, looping lofi player, screen wake-lock) live behind one browser-API boundary module (`src/lib/focus-sounds.ts`) so the timer component stays thin and tests mock the boundary. The visual (`TimerVisual`, 4 styles), the step tracker (`FocusStepTracker`), and the hint (`TimerCustomizationHint`) are small presentational components. The client `FocusTimer` orchestrates phase state + effects. New per-workspace `Settings` columns are added the #38 way (constants.ts source-of-truth + Postgres CHECK + the `enum-constraint-sync` registry + a migration), surfaced by a `FocusTimerSection` (auto-save) and persisted by a new `updateFocusTimerSettings` server action; a `dismissFocusTimerTip` action records the one-time nudge.

**Tech Stack:** Next.js 16, React 19, Prisma 6.19 (Postgres everywhere), TypeScript, Vitest 4 (jsdom + React Testing Library), Playwright e2e (blocking gate), Tailwind 4, shadcn.

## Global Constraints

*(Cross-cutting rules — copied verbatim from the spec. Every task's requirements implicitly include this section.)*

- **Stack:** Next.js 16, React 19, Prisma 6.19 (Postgres everywhere), Vitest 4 (jsdom + React Testing Library), Playwright e2e (blocking gate), Tailwind 4, shadcn.
- **This is a modified Next.js fork.** Before writing any Next-specific code, read the relevant guide in `node_modules/next/dist/docs/`. Heed deprecation notices.
- **Settings enums backed by a DB CHECK constraint MUST use the constants.ts source-of-truth + the `enum-constraint-sync.integration.test.ts` REGISTRY + a Prisma migration (the #38 pattern).** Constraint naming is `<Table>_<column>_check`; adding/removing a value later means a follow-up DROP+ADD migration or the sync test fails.
- **Every new user-facing string goes through `t()` with plain + playful Voice variants.** `t()` returns a **static** string — there is **no `{n}` interpolation**; compose numbers in JSX around static unit strings. Plain voice = no decorative emoji (functional glyphs only: status dots, ✅, ▶/⏸/➕/➖/✓, 🔥, ⏰, 🎧); the emoji anchor is playful-voice only.
- **Stacking:** MR ③ (completion-style) stacks ON TOP of ②. Files ② and ③ both touch — `src/lib/constants.ts`, `src/lib/strings.ts`, `prisma/schema.prisma`, the settings page (`src/app/(app)/settings/page.tsx`), the `enum-constraint-sync` REGISTRY, and migration ordering — are called out in each task and in the Stacking section below. Keep ②'s migrations independent; ③ re-stamps after ②.
- **No app auth-bypass in tests; E2E uses forge-session auth (`npm run test:e2e`).**
- **Honest testing:** jsdom can't compute CSS custom-property colours or real audio/wake-lock — unit-test the pure seams + mapping, mock browser APIs (Wake Lock, Audio, Notification/vibrate) at the boundary, and document any manual visual/behavioral sweep in the plan rather than faking coverage.
- **Per-worktree Postgres for gating:** the sync `*.integration.test.ts` needs a real Postgres. Run `npx prisma generate` after editing the schema, then `npx prisma migrate deploy` against **this worktree's own** Postgres schema (never `migrate dev`) before running DB-touching suites. Seed a new worktree's `node_modules` via a `cp -Rc` CoW clone (or `npm ci`) — **do not regenerate `package-lock.json` locally**.
- **Workspace isolation:** every server action resolves `currentWorkspaceId()` and upserts/queries by it. Focus-timer settings are personalisation (guests keep their own values; no owner gate).
- **Branch / MR:** work in `feat/focus-timer-mr2` (milestone **v0.2.0**). Add **@GitLabDuo as reviewer** (code MR). **Do NOT merge, do NOT push to main**; owner sign-off + GitLabDuo re-review gate the merge.
- **Gates before every push:** `npx tsc --noEmit` clean · `npm run lint` 0 new errors · `npm test` all green (incl. the sync integration test after `migrate deploy`) · `npx next build` compiles (both `/focus` routes render) · `npm run test:e2e` (Chromium) green.
- **Run all commands from the worktree root:** `/Users/gitlab_dlectronique/workdev/dlectroflow/.claude/worktrees/mr2-plan`.

### Stacking on MR ③ (feat/focus-completion-mr3) — coordination

MR ③ (`docs/design/plans/2026-07-20-focus-completion-style-mr3.md`) rebases **onto this branch**. Both MRs append to shared files; MR ③'s plan already documents the reconciliation, but note here what ② lands so ③ re-stamps cleanly:

- **Migration ordering:** ②'s migration is `20260720110000_settings_focus_timer` (Focus-timer columns + CHECKs). ③'s is `20260720120000_settings_completion_style`. ②'s timestamp is strictly **earlier**, so `migrate deploy` applies ② then ③ with no re-stamp needed. If ③'s branch history ever lands a later ② timestamp, ③ re-stamps its own dir to stay greater.
- **`src/lib/constants.ts`:** ② adds `FocusTimerStyle` + `FocusSound`; ③ adds `CompleteTickColor`. Adjacent additions — union, no conflict.
- **`enum-constraint-sync.integration.test.ts` REGISTRY:** ② adds `Settings_focusTimerStyle_check` + `Settings_focusSound_check`; ③ adds `Settings_completeTickColor_check`. Keep all entries + all imports.
- **`src/app/(app)/settings/page.tsx`:** ② mounts `FocusTimerSection`; ③ mounts `AppearanceSection`. Keep both section mounts.
- **`src/lib/strings.ts` + `prisma/schema.prisma`:** both append keys / `Settings` columns. Union both additions.
- **`src/app/actions/settings.ts`:** ② adds `updateFocusTimerSettings` + `dismissFocusTimerTip`; ③ adds `updateAppearanceSettings`. Adjacent additions.

---

## File Structure

**Create:**
- `src/lib/focus-timer-style.ts` — pure style resolution + allowlist (`resolveTimerStyle`). No React/DB. **One responsibility:** map the stored style + voice → the resolved `FocusTimerStyle`.
- `src/lib/focus-timer-style.test.ts` — unit tests for the mapping (allowlist, null → voice default).
- `src/lib/focus-timer-clock.ts` — pure timer math: `mmss`, `applyTimeDelta` (±time with a 60s remaining floor), `netAddedMin`, `timerFraction`. No React/DB. **One responsibility:** the clock arithmetic the component drives its state with.
- `src/lib/focus-timer-clock.test.ts` — unit tests for every math seam.
- `src/lib/focus-sounds.ts` — the browser-API boundary: alarm (chime + vibrate), the looping lofi player, and the screen wake-lock, each degrading silently. **One responsibility:** wrap the device APIs so the component (and tests) never touch them directly.
- `src/lib/focus-sounds.test.ts` — boundary tests with `Audio`/`navigator` stubbed (calls fire; unsupported → no-op, no throw).
- `src/components/focus/timer-visual.tsx` — the 4 visual styles (ring/digits/bar/mug) sharing one always-visible `mm:ss` + "of Nm" readout, reduced-motion aware. **One responsibility:** render the countdown visual.
- `src/components/focus/timer-visual.test.tsx` — RTL: each style renders, the readout is always present (never colour-only), reduced-motion drops the transition.
- `src/components/focus/focus-step-tracker.tsx` — the segmented tracker + `steps ▾` toggle + expandable vertical stepper. **One responsibility:** show multi-step progress (status by shape+glyph, not colour alone).
- `src/components/focus/focus-step-tracker.test.tsx` — RTL: segment states, toggle, expanded glyphs (✓/●/○).
- `src/components/focus/timer-customization-hint.tsx` — the one-time dismissible nudge → `/settings`. **One responsibility:** the first-run callout.
- `src/components/focus/timer-customization-hint.test.tsx` — RTL: copy, ✕ dismiss, tap-through both call `onDismiss`; link → `/settings`.
- `src/components/settings/focus-timer-section.tsx` — **(`"use client"`)** the Focus-timer settings group (style radios + 3 toggles + sound select), auto-save. **One responsibility:** the Focus-timer settings UI.
- `src/components/settings/focus-timer-section.test.tsx` — RTL: seeded state, auto-save each field.
- `src/app/actions/settings.focustimer.test.ts` — node unit test for `updateFocusTimerSettings` + `dismissFocusTimerTip` (allowlists + boolean coercion).
- `prisma/migrations/20260720110000_settings_focus_timer/migration.sql` — the 6 new `Settings` columns + the two CHECK constraints.

**Modify:**
- `prisma/schema.prisma` — add the 6 Focus-timer `Settings` columns (mirror the CHECK value sets in comments, per repo convention).
- `src/lib/constants.ts` — add `FocusTimerStyle` + `FocusSound` pseudo-enums.
- `src/lib/enum-constraint-sync.integration.test.ts` — import the two constants; add their REGISTRY entries.
- `src/app/actions/settings.ts` — add `updateFocusTimerSettings` + `dismissFocusTimerTip`.
- `src/lib/strings.ts` — new voice-aware `focus.timer.*`, `focus.tip.*`, `focusSettings.*` keys.
- `src/components/focus/focus-timer.tsx` — full rewrite: new header hierarchy + ← Back + corner, `TimerVisual`, `FocusStepTracker` (auto-expand), ± clamp + signed note, minimal mode, audio/device effects, first-run hint; remove "Pause for now" + the `gaveup` phase.
- `src/components/focus/focus-timer.test.tsx` — full rewrite for the new behaviour (device effects behind mocks).
- `src/app/(app)/focus/[stepId]/page.tsx` — expanded query: pass the full step list, `getDashboardData` (streak + minutes today), the new settings, `nextStep`, `isSingleTask`, `tipDismissed`.
- `src/app/(app)/settings/page.tsx` — mount `<FocusTimerSection>`.

**Assets added at build time (Task 6):**
- `public/audio/lofi-calm.mp3`, `public/audio/alarm.mp3` — bundled CC0 assets.
- `public/audio/LICENSE.md` — provenance / CC0 attribution note.

**Audited, NO change (documented decision):**
- `src/app/actions/focus.ts` — `giveUpFocus` server action stays exported (the UI stops calling it now that "Pause for now"/`gaveup` are removed, but removing the action is out of MR ② scope). `beginFocus`/`completeFocus`/`requeueFocus`/`proposeNewEstimate` are reused unchanged. The done screen already reads `result.googleSynced` (post-#36) — no reconciliation needed.

---

## Task 1: Schema + `FocusTimerStyle`/`FocusSound` + migration + CHECK + sync registry (#38 pattern)

Add the DB layer for the 6 Focus-timer settings, with the two value-set columns guarded by CHECK constraints kept in lockstep with `constants.ts` by the sync test.

**Files:**
- Modify: `prisma/schema.prisma` (Settings model)
- Modify: `src/lib/constants.ts`
- Create: `prisma/migrations/20260720110000_settings_focus_timer/migration.sql`
- Modify: `src/lib/enum-constraint-sync.integration.test.ts`

**Interfaces:**
- Produces: `FocusTimerStyle = { Ring:"ring"; Digits:"digits"; Bar:"bar"; Mug:"mug" }` + type; `FocusSound = { Off:"off"; LofiCalm:"lofi_calm" }` + type; `Settings.focusTimerStyle: string | null`, `focusMinimalMode/focusKeepAwake/focusAlarmEnabled: boolean`, `focusSound: string`, `focusTimerTipDismissedAt: Date | null`; the constraints `Settings_focusTimerStyle_check` (nullable) + `Settings_focusSound_check`.
- Consumed by: `updateFocusTimerSettings` (Task 2), `resolveTimerStyle` (Task 4), `focus-sounds` (Task 6), `FocusTimerSection` (Task 12), the timer page (Task 11), and the sync test.

- [ ] **Step 1: Add the constants + the sync-test registry entries (red first)**

In `src/lib/constants.ts`, after the `OWNER_BREAKDOWN_*` block, add:

```ts
// ── MR ② — Focus timer redesign (Focus-timer settings) ─────────────────────
// focusTimerStyle + focusSound are String columns guarded by Postgres CHECK
// constraints (Settings_focusTimerStyle_check / Settings_focusSound_check).
// These objects are the single source of truth for the allowed sets; the CHECK
// migration + enum-constraint-sync test mirror them. focusTimerStyle is nullable
// (null → the timer resolves a style from the voice); focusSound defaults "off".
export const FocusTimerStyle = {
  Ring: "ring",
  Digits: "digits",
  Bar: "bar",
  Mug: "mug",
} as const;
export type FocusTimerStyle =
  (typeof FocusTimerStyle)[keyof typeof FocusTimerStyle];

export const FocusSound = {
  Off: "off",
  LofiCalm: "lofi_calm",
} as const;
export type FocusSound = (typeof FocusSound)[keyof typeof FocusSound];
```

In `src/lib/enum-constraint-sync.integration.test.ts`, add `FocusTimerStyle, FocusSound` to the `@/lib/constants` import, and append to the `REGISTRY` array:

```ts
  { constraint: "Settings_focusTimerStyle_check", table: "Settings", column: "focusTimerStyle", values: FocusTimerStyle, nullable: true },
  { constraint: "Settings_focusSound_check", table: "Settings", column: "focusSound", values: FocusSound, nullable: false },
```

- [ ] **Step 2: Run the sync test to verify it fails**

Run: `npm test -- src/lib/enum-constraint-sync.integration.test.ts`
Expected: FAIL — the "has exactly the managed CHECK constraints" case reports `Settings_focusTimerStyle_check` + `Settings_focusSound_check` as expected-but-not-applied (columns/constraints don't exist yet).

- [ ] **Step 3: Add the schema columns**

In `prisma/schema.prisma`, inside `model Settings` (after the Phase 6 notification block, before `updatedAt`), add:

```prisma
  // MR ② — Focus timer redesign (appearance + behaviour). focusTimerStyle
  // (nullable → resolve by voice) + focusSound mirror FocusTimerStyle /
  // FocusSound in src/lib/constants.ts + their CHECK constraints
  // (Settings_focusTimerStyle_check / Settings_focusSound_check).
  focusTimerStyle          String?   // ring | digits | bar | mug (null → voice default)
  focusMinimalMode         Boolean   @default(false)
  focusKeepAwake           Boolean   @default(true)
  focusAlarmEnabled        Boolean   @default(true)
  focusSound               String    @default("off") // off | lofi_calm
  focusTimerTipDismissedAt DateTime?
```

- [ ] **Step 4: Write the migration**

Create `prisma/migrations/20260720110000_settings_focus_timer/migration.sql`:

```sql
-- MR ② — Focus timer redesign (visual/behaviour settings).
--
-- Six per-workspace Settings columns drive the redesigned focus timer. Two are
-- String pseudo-enums whose allowed sets live in src/lib/constants.ts
-- (FocusTimerStyle, FocusSound) and are mirrored by the CHECK constraints below
-- + kept in sync by src/lib/enum-constraint-sync.integration.test.ts (#38).
-- focusTimerStyle is nullable (null → the timer resolves a style from the
-- workspace voice), so its CHECK explicitly allows NULL.

ALTER TABLE "Settings" ADD COLUMN "focusTimerStyle" TEXT;
ALTER TABLE "Settings" ADD COLUMN "focusMinimalMode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "focusKeepAwake" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "focusAlarmEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "focusSound" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "Settings" ADD COLUMN "focusTimerTipDismissedAt" TIMESTAMP(3);

-- Settings.focusTimerStyle ← FocusTimerStyle (ring | digits | bar | mug); NULL → voice default
ALTER TABLE "Settings"
  ADD CONSTRAINT "Settings_focusTimerStyle_check"
  CHECK ("focusTimerStyle" IN ('ring', 'digits', 'bar', 'mug') OR "focusTimerStyle" IS NULL);

-- Settings.focusSound ← FocusSound (off | lofi_calm)
ALTER TABLE "Settings"
  ADD CONSTRAINT "Settings_focusSound_check"
  CHECK ("focusSound" IN ('off', 'lofi_calm'));
```

> **Stacking note (build only):** this dir (`20260720110000_…`) sorts BEFORE MR ③'s `20260720120000_settings_completion_style`, so `migrate deploy` applies ② then ③. Keep it independent — do not fold ③'s columns in here.

- [ ] **Step 5: Regenerate the client, apply, and verify green**

Run: `npx prisma generate`
Run: `npx prisma migrate deploy` (this worktree's Postgres schema)
Run: `npm test -- src/lib/enum-constraint-sync.integration.test.ts`
Expected: PASS — the managed-set case now matches; `Settings_focusTimerStyle_check` permits exactly `{ring,digits,bar,mug}` and carries an `IS NULL` allowance (nullable), and `Settings_focusSound_check` permits exactly `{off,lofi_calm}` with no `IS NULL`.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma "prisma/migrations/20260720110000_settings_focus_timer/migration.sql" src/lib/constants.ts src/lib/enum-constraint-sync.integration.test.ts
git commit -m "feat(#8): Settings focus-timer columns + CHECKs (#38 pattern) for MR ②

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `updateFocusTimerSettings` + `dismissFocusTimerTip` server actions

Persist the Focus-timer preferences (allowlisting the style + sound against the CHECK sets) and record the one-time hint dismissal.

**Files:**
- Modify: `src/app/actions/settings.ts`
- Create: `src/app/actions/settings.focustimer.test.ts`

**Interfaces:**
- Consumes: `prisma` (`@/lib/db`), `currentWorkspaceId` (`@/lib/workspace`), `FocusTimerStyle`/`FocusSound` (`@/lib/constants`, Task 1), `revalidatePath` (`next/cache`).
- Produces:
  - `updateFocusTimerSettings(input: { timerStyle: string | null; minimalMode: boolean; keepAwake: boolean; alarmEnabled: boolean; sound: string }): Promise<void>`
  - `dismissFocusTimerTip(): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/app/actions/settings.focustimer.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const upsert = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/db", () => ({ prisma: { settings: { upsert } } }));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: vi.fn().mockResolvedValue("ws-1"),
  isOwnerRequest: vi.fn().mockResolvedValue(true),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { updateFocusTimerSettings, dismissFocusTimerTip } from "@/app/actions/settings";

beforeEach(() => vi.clearAllMocks());

describe("updateFocusTimerSettings", () => {
  it("persists an allowlisted style + sound and coerces the booleans", async () => {
    await updateFocusTimerSettings({
      timerStyle: "mug",
      minimalMode: true,
      keepAwake: false,
      alarmEnabled: true,
      sound: "lofi_calm",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws-1" },
        update: {
          focusTimerStyle: "mug",
          focusMinimalMode: true,
          focusKeepAwake: false,
          focusAlarmEnabled: true,
          focusSound: "lofi_calm",
        },
      }),
    );
  });

  it("keeps a null style (null → voice default) and does not coerce it away", async () => {
    await updateFocusTimerSettings({
      timerStyle: null,
      minimalMode: false,
      keepAwake: true,
      alarmEnabled: true,
      sound: "off",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ focusTimerStyle: null }) }),
    );
  });

  it("coerces an out-of-set style to null and an out-of-set sound to off (mirrors the CHECKs)", async () => {
    await updateFocusTimerSettings({
      timerStyle: "hourglass",
      minimalMode: false,
      keepAwake: true,
      alarmEnabled: false,
      sound: "spotify",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ focusTimerStyle: null, focusSound: "off" }),
      }),
    );
  });
});

describe("dismissFocusTimerTip", () => {
  it("stamps focusTimerTipDismissedAt with a Date", async () => {
    await dismissFocusTimerTip();
    const call = upsert.mock.calls[0][0];
    expect(call.where).toEqual({ workspaceId: "ws-1" });
    expect(call.update.focusTimerTipDismissedAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/app/actions/settings.focustimer.test.ts`
Expected: FAIL — `updateFocusTimerSettings` / `dismissFocusTimerTip` are not exported.

- [ ] **Step 3: Implement the actions**

In `src/app/actions/settings.ts`, add `FocusTimerStyle, FocusSound` to the `@/lib/constants` import, then append:

```ts
/**
 * MR ② — Focus timer preferences. Workspace-scoped personalisation (guests keep
 * their own values; no owner gate). timerStyle + sound are allowlist-validated
 * against FocusTimerStyle / FocusSound so a bad value can never reach the DB
 * (mirrors the Settings_focusTimerStyle_check / Settings_focusSound_check
 * constraints); an unknown style falls back to null (→ resolve by voice) and an
 * unknown sound falls back to "off". The timer route is force-dynamic (reads
 * settings fresh on load); we revalidate /settings so the section re-seeds.
 */
export async function updateFocusTimerSettings(input: {
  timerStyle: string | null;
  minimalMode: boolean;
  keepAwake: boolean;
  alarmEnabled: boolean;
  sound: string;
}) {
  const workspaceId = await currentWorkspaceId();
  const styles = Object.values(FocusTimerStyle) as string[];
  const focusTimerStyle =
    input.timerStyle && styles.includes(input.timerStyle) ? input.timerStyle : null;
  const sounds = Object.values(FocusSound) as string[];
  const focusSound = sounds.includes(input.sound) ? input.sound : FocusSound.Off;
  const data = {
    focusTimerStyle,
    focusMinimalMode: Boolean(input.minimalMode),
    focusKeepAwake: Boolean(input.keepAwake),
    focusAlarmEnabled: Boolean(input.alarmEnabled),
    focusSound,
  };
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, ...data },
    update: data,
  });
  revalidatePath("/settings");
}

/** MR ② — record that the workspace dismissed the one-time "make this timer
 * yours" hint (via ✕ or by tapping through to settings). One-shot flag; the
 * force-dynamic timer route won't show it again on the next load. */
export async function dismissFocusTimerTip() {
  const workspaceId = await currentWorkspaceId();
  const now = new Date();
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, focusTimerTipDismissedAt: now },
    update: { focusTimerTipDismissedAt: now },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/app/actions/settings.focustimer.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add src/app/actions/settings.ts src/app/actions/settings.focustimer.test.ts
git commit -m "feat(#8): updateFocusTimerSettings + dismissFocusTimerTip actions (allowlisted)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Voice-aware Focus-timer strings

Add every new key the timer + hint + settings section need. Reuse existing keys where they already fit: `action.back` ("← Back"), `action.dismiss` ("Dismiss"/"Not now"), `step.counter` ("Step"/"bite"), `focus.hero.next` ("next →"), `focus.pause`/`focus.resume`/`focus.timesUp`/`focus.yesDone`/`focus.notYet`/`focus.nextStep`, `settings.saved`/`settings.saveError`.

**Files:**
- Modify: `src/lib/strings.ts` (append to the `STRINGS` object, after the launcher block)

**Interfaces:**
- Consumes: `t(key, voice)`, `type Voice`.
- Produces (new `StringKey`s): `focus.timer.completeStep`, `focus.timer.of`, `focus.timer.leftInTask`, `focus.timer.steps`, `focus.tip.body`, `focus.tip.cta`, `focusSettings.heading`, `focusSettings.intro`, `focusSettings.style`, `focusSettings.styleAuto`, `focusSettings.styleRing`, `focusSettings.styleDigits`, `focusSettings.styleBar`, `focusSettings.styleMug`, `focusSettings.minimal`, `focusSettings.minimalHint`, `focusSettings.keepAwake`, `focusSettings.keepAwakeHint`, `focusSettings.alarm`, `focusSettings.alarmHint`, `focusSettings.sound`, `focusSettings.soundHint`, `focusSettings.soundOff`, `focusSettings.soundLofiCalm`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/strings.focustimer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { t } from "@/lib/strings";

describe("focus-timer redesign strings (MR ②)", () => {
  it("timer readout + controls resolve; plain stays free of decorative emoji", () => {
    expect(t("focus.timer.completeStep", "plain")).toBe("✓ Complete step");
    expect(t("focus.timer.of", "plain")).toBe("of");
    expect(t("focus.timer.leftInTask", "plain")).toBe("left in task");
    expect(t("focus.timer.steps", "plain")).toBe("steps");
  });

  it("the first-run hint resolves in both voices", () => {
    expect(t("focus.tip.body", "plain")).toMatch(/make this timer yours/i);
    expect(t("focus.tip.cta", "plain")).toBe("Open settings →");
    expect(t("focus.tip.body", "playful")).not.toBe(t("focus.tip.body", "plain"));
  });

  it("settings labels resolve; the heading gets a playful emoji anchor only in playful", () => {
    expect(t("focusSettings.heading", "plain")).toBe("Focus timer");
    expect(t("focusSettings.heading", "playful")).toBe("⏱️ Focus timer");
    expect(t("focusSettings.styleAuto", "plain")).toBe("Match voice");
    expect(t("focusSettings.soundOff", "plain")).toBe("Off");
    expect(t("focusSettings.soundLofiCalm", "plain")).toBe("Lo-fi (calm)");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/strings.focustimer.test.ts`
Expected: FAIL — keys not in `STRINGS` (TypeScript/lookup error).

- [ ] **Step 3: Add the keys**

In `src/lib/strings.ts`, right after the `"focus.launcher.allClear": { … },` entry, add:

```ts
  // ── Focus timer redesign (MR ②) — timer page, hint, settings group ──────────
  // ✓ / ⏰ / 🎧 / ⏱️ are functional or playful-only glyphs (see the voice note
  // at the top). Numbers are composed in JSX around these static units.
  "focus.timer.completeStep": { plain: "✓ Complete step", playful: "✓ Complete step" },
  "focus.timer.of":           { plain: "of",              playful: "of" },
  "focus.timer.leftInTask":   { plain: "left in task",    playful: "left in task" },
  "focus.timer.steps":        { plain: "steps",           playful: "steps" },
  "focus.tip.body": {
    plain: "Make this timer yours — style, sounds, alarm & more.",
    playful: "✨ Make this timer yours — style, sounds, alarm & more.",
  },
  "focus.tip.cta":            { plain: "Open settings →", playful: "Open settings →" },
  "focusSettings.heading":    { plain: "Focus timer",     playful: "⏱️ Focus timer" },
  "focusSettings.intro": {
    plain: "How the focus timer looks and behaves.",
    playful: "How your focus timer looks and behaves.",
  },
  "focusSettings.style":      { plain: "Timer style",     playful: "Timer style" },
  "focusSettings.styleAuto":  { plain: "Match voice",     playful: "Match voice" },
  "focusSettings.styleRing":  { plain: "Ring",            playful: "Ring" },
  "focusSettings.styleDigits":{ plain: "Digits",          playful: "Digits" },
  "focusSettings.styleBar":   { plain: "Bar",             playful: "Bar" },
  "focusSettings.styleMug":   { plain: "Mug",             playful: "🍵 Mug" },
  "focusSettings.minimal":    { plain: "Minimal / distraction-free", playful: "Minimal / distraction-free" },
  "focusSettings.minimalHint": {
    plain: "Hide the streak, task context and step tracker while the timer runs.",
    playful: "Hide the streak, task context and step tracker while the timer runs.",
  },
  "focusSettings.keepAwake":  { plain: "Keep screen awake", playful: "Keep screen awake" },
  "focusSettings.keepAwakeHint": {
    plain: "Stop the screen dimming while a timer is running (where your device supports it).",
    playful: "Stop the screen dimming while a timer is running (where your device supports it).",
  },
  "focusSettings.alarm":      { plain: "Alarm at time's-up", playful: "⏰ Alarm at time's-up" },
  "focusSettings.alarmHint": {
    plain: "Play a short chime (and vibrate on mobile) when the timer reaches zero.",
    playful: "Play a short chime (and vibrate on mobile) when the timer reaches zero.",
  },
  "focusSettings.sound":      { plain: "Focus sounds",    playful: "🎧 Focus sounds" },
  "focusSettings.soundHint": {
    plain: "Loop a calm background track while you focus.",
    playful: "Loop a calm background track while you focus.",
  },
  "focusSettings.soundOff":       { plain: "Off",         playful: "Off" },
  "focusSettings.soundLofiCalm":  { plain: "Lo-fi (calm)", playful: "Lo-fi (calm)" },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/strings.focustimer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/strings.ts src/lib/strings.focustimer.test.ts
git commit -m "feat(#8): voice-aware strings for the /focus timer redesign + settings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Pure timer-style seam (`focus-timer-style.ts`)

The DB/React-free style resolver: pick a valid `FocusTimerStyle` from the stored setting, falling back to the voice default (mug for playful, ring for plain).

**Files:**
- Create: `src/lib/focus-timer-style.ts`
- Create: `src/lib/focus-timer-style.test.ts`

**Interfaces:**
- Consumes: `FocusTimerStyle` (`@/lib/constants`, Task 1), `type Voice` (`@/lib/strings`).
- Produces: `function resolveTimerStyle(setting: string | null | undefined, voice: Voice): FocusTimerStyle`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/focus-timer-style.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveTimerStyle } from "@/lib/focus-timer-style";

describe("resolveTimerStyle", () => {
  it("returns a stored, allowlisted style verbatim", () => {
    expect(resolveTimerStyle("ring", "plain")).toBe("ring");
    expect(resolveTimerStyle("digits", "playful")).toBe("digits");
    expect(resolveTimerStyle("bar", "plain")).toBe("bar");
    expect(resolveTimerStyle("mug", "plain")).toBe("mug");
  });

  it("falls back to the voice default when unset (null/undefined)", () => {
    expect(resolveTimerStyle(null, "playful")).toBe("mug");
    expect(resolveTimerStyle(null, "plain")).toBe("ring");
    expect(resolveTimerStyle(undefined, "playful")).toBe("mug");
  });

  it("falls back to the voice default for an unknown value", () => {
    expect(resolveTimerStyle("hourglass", "playful")).toBe("mug");
    expect(resolveTimerStyle("", "plain")).toBe("ring");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/focus-timer-style.test.ts`
Expected: FAIL — cannot find module `@/lib/focus-timer-style`.

- [ ] **Step 3: Implement the seam**

Create `src/lib/focus-timer-style.ts`:

```ts
import { FocusTimerStyle } from "@/lib/constants";
import type { Voice } from "@/lib/strings";

/**
 * Resolve the timer visual style. A stored, allowlisted value wins; otherwise
 * (null/unset or an unknown value) fall back to the voice default — mug for the
 * playful voice, ring for plain. Pure: no React/DB. See the spec, Design B.
 */
export function resolveTimerStyle(
  setting: string | null | undefined,
  voice: Voice,
): FocusTimerStyle {
  const allowed = Object.values(FocusTimerStyle) as string[];
  if (setting && allowed.includes(setting)) return setting as FocusTimerStyle;
  return voice === "playful" ? FocusTimerStyle.Mug : FocusTimerStyle.Ring;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/focus-timer-style.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/focus-timer-style.ts src/lib/focus-timer-style.test.ts
git commit -m "feat(#8): pure resolveTimerStyle seam (stored style ?? voice default)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Pure timer-clock seam (`focus-timer-clock.ts`)

The DB/React-free clock arithmetic: format `mm:ss`, apply a signed ±time delta with a remaining floor, derive the signed net-added minutes, and the depletion fraction.

**Files:**
- Create: `src/lib/focus-timer-clock.ts`
- Create: `src/lib/focus-timer-clock.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `const MIN_REMAINING_SEC = 60`
  - `function mmss(totalSec: number): string`
  - `function applyTimeDelta(clock: { totalSec: number; remainingSec: number }, deltaSec: number): { totalSec: number; remainingSec: number }`
  - `function netAddedMin(totalSec: number, plannedSec: number): number`
  - `function timerFraction(remainingSec: number, totalSec: number): number`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/focus-timer-clock.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  MIN_REMAINING_SEC,
  mmss,
  applyTimeDelta,
  netAddedMin,
  timerFraction,
} from "@/lib/focus-timer-clock";

describe("mmss", () => {
  it("formats minutes:seconds, zero-padding seconds and flooring negatives to 0:00", () => {
    expect(mmss(0)).toBe("0:00");
    expect(mmss(9)).toBe("0:09");
    expect(mmss(65)).toBe("1:05");
    expect(mmss(600)).toBe("10:00");
    expect(mmss(-5)).toBe("0:00");
  });
});

describe("applyTimeDelta", () => {
  it("adds time to both total and remaining", () => {
    expect(applyTimeDelta({ totalSec: 600, remainingSec: 300 }, 300)).toEqual({
      totalSec: 900,
      remainingSec: 600,
    });
  });

  it("removes time from both when there is room", () => {
    expect(applyTimeDelta({ totalSec: 600, remainingSec: 300 }, -120)).toEqual({
      totalSec: 480,
      remainingSec: 180,
    });
  });

  it("clamps removal so remaining never drops below the 60s floor (total shrinks by the applied amount only)", () => {
    // remaining 90s, remove 5m: floor at 60s → only 30s actually removed.
    expect(applyTimeDelta({ totalSec: 300, remainingSec: 90 }, -300)).toEqual({
      totalSec: 270,
      remainingSec: MIN_REMAINING_SEC,
    });
  });

  it("is a no-op at the floor", () => {
    expect(applyTimeDelta({ totalSec: 240, remainingSec: 60 }, -300)).toEqual({
      totalSec: 240,
      remainingSec: 60,
    });
  });
});

describe("netAddedMin", () => {
  it("is signed vs the planned duration", () => {
    expect(netAddedMin(900, 600)).toBe(5); // +5m
    expect(netAddedMin(300, 600)).toBe(-5); // −5m
    expect(netAddedMin(600, 600)).toBe(0);
  });
});

describe("timerFraction", () => {
  it("is remaining/total, and 0 when total is 0", () => {
    expect(timerFraction(300, 600)).toBe(0.5);
    expect(timerFraction(0, 600)).toBe(0);
    expect(timerFraction(10, 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/focus-timer-clock.test.ts`
Expected: FAIL — cannot find module `@/lib/focus-timer-clock`.

- [ ] **Step 3: Implement the seam**

Create `src/lib/focus-timer-clock.ts`:

```ts
/**
 * Pure timer arithmetic for the focus timer (MR ②). No React/DOM — the client
 * component drives its state through these so the math is unit-tested in
 * isolation. See the spec, Design B (symmetric ±time, "±Xm" net note).
 */

/** The countdown can never be pushed to/under this by a −time tap. */
export const MIN_REMAINING_SEC = 60;

/** Format whole seconds as `m:ss` (seconds zero-padded); negatives floor to 0:00. */
export function mmss(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Apply a signed time delta (seconds) to the clock. Positive grows total +
 * remaining equally; negative shrinks both, but remaining is clamped to a 60s
 * floor and total only shrinks by the amount actually applied (so elapsed time
 * is preserved and the timer can't be pushed to time-up by a −time tap).
 */
export function applyTimeDelta(
  clock: { totalSec: number; remainingSec: number },
  deltaSec: number,
): { totalSec: number; remainingSec: number } {
  const newRemaining = Math.max(MIN_REMAINING_SEC, clock.remainingSec + deltaSec);
  const applied = newRemaining - clock.remainingSec;
  return { totalSec: clock.totalSec + applied, remainingSec: newRemaining };
}

/** Signed net minutes added vs the planned duration (drives the "±Xm" note). */
export function netAddedMin(totalSec: number, plannedSec: number): number {
  return Math.round((totalSec - plannedSec) / 60);
}

/** Depletion fraction remaining/total in [0,1]; 0 when total is 0. */
export function timerFraction(remainingSec: number, totalSec: number): number {
  return totalSec > 0 ? remainingSec / totalSec : 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/focus-timer-clock.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/focus-timer-clock.ts src/lib/focus-timer-clock.test.ts
git commit -m "feat(#8): pure timer-clock seam — mmss, ±time clamp, net-added, fraction

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Browser-API boundary (`focus-sounds.ts`) + bundled CC0 assets

Wrap the alarm chime + vibration, the looping lofi player, and the screen wake-lock behind one module that degrades silently where unsupported, so the timer component (and tests) never touch these APIs directly.

**Files:**
- Create: `src/lib/focus-sounds.ts`
- Create: `src/lib/focus-sounds.test.ts`
- Create (assets, at build time): `public/audio/lofi-calm.mp3`, `public/audio/alarm.mp3`, `public/audio/LICENSE.md`

**Interfaces:**
- Consumes: `FocusSound` (`@/lib/constants`, Task 1); the DOM `Audio` constructor + `navigator.wakeLock` / `navigator.vibrate` (feature-detected).
- Produces:
  - `const FOCUS_SOUND_SRC: Record<string, string | null>` (keyed by `FocusSound` value → asset path or null)
  - `type Alarm = { play(): void }`; `function createAlarm(): Alarm`
  - `type LoopPlayer = { play(): void; pause(): void; stop(): void }`; `function createLoopPlayer(src: string): LoopPlayer`
  - `type WakeGuard = { release(): void }`; `function acquireWakeLock(): Promise<WakeGuard>`

- [ ] **Step 1: Source + commit the CC0 assets**

Add two short royalty-free **CC0** audio files under `public/audio/`:
- `public/audio/lofi-calm.mp3` — a seamless-looping calm lofi bed (e.g. from a CC0 source such as Pixabay Music / freesound CC0). Keep it small (target < 1.5 MB).
- `public/audio/alarm.mp3` — a short (~1s) chime.

Create `public/audio/LICENSE.md` recording provenance (source URL, author, "CC0 / public domain") for each file. **Do not** add any non-CC0 asset. (Streaming search/playback — YouTube/Spotify/SoundCloud — is explicitly a FUTURE release; nothing here.)

- [ ] **Step 2: Write the failing boundary tests**

Create `src/lib/focus-sounds.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A fake HTMLAudioElement — records construction + play/pause.
const audioPlay = vi.fn().mockResolvedValue(undefined);
const audioPause = vi.fn();
class FakeAudio {
  src: string;
  loop = false;
  currentTime = 0;
  play = audioPlay;
  pause = audioPause;
  constructor(src: string) {
    this.src = src;
  }
}

const vibrate = vi.fn();
const wakeRelease = vi.fn().mockResolvedValue(undefined);
const wakeRequest = vi.fn().mockResolvedValue({ release: wakeRelease });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("Audio", FakeAudio as unknown as typeof Audio);
  vi.stubGlobal("navigator", { vibrate, wakeLock: { request: wakeRequest } });
});
afterEach(() => vi.unstubAllGlobals());

describe("focus-sounds — FOCUS_SOUND_SRC", () => {
  it("maps off → null and lofi_calm → the bundled asset", async () => {
    const { FOCUS_SOUND_SRC } = await import("@/lib/focus-sounds");
    expect(FOCUS_SOUND_SRC.off).toBeNull();
    expect(FOCUS_SOUND_SRC.lofi_calm).toBe("/audio/lofi-calm.mp3");
  });
});

describe("createAlarm", () => {
  it("plays the chime from the start and vibrates on play()", async () => {
    const { createAlarm } = await import("@/lib/focus-sounds");
    createAlarm().play();
    expect(audioPlay).toHaveBeenCalled();
    expect(vibrate).toHaveBeenCalled();
  });
});

describe("createLoopPlayer", () => {
  it("loops, and play/pause/stop drive the element", async () => {
    const { createLoopPlayer } = await import("@/lib/focus-sounds");
    const p = createLoopPlayer("/audio/lofi-calm.mp3");
    p.play();
    expect(audioPlay).toHaveBeenCalled();
    p.pause();
    expect(audioPause).toHaveBeenCalledTimes(1);
    p.stop();
    expect(audioPause).toHaveBeenCalledTimes(2);
  });
});

describe("acquireWakeLock", () => {
  it("requests a screen wake lock and releases via the guard", async () => {
    const { acquireWakeLock } = await import("@/lib/focus-sounds");
    const guard = await acquireWakeLock();
    expect(wakeRequest).toHaveBeenCalledWith("screen");
    guard.release();
    expect(wakeRelease).toHaveBeenCalled();
  });

  it("degrades to a no-op guard when the Wake Lock API is unavailable", async () => {
    vi.stubGlobal("navigator", {}); // no wakeLock
    const { acquireWakeLock } = await import("@/lib/focus-sounds");
    const guard = await acquireWakeLock();
    expect(() => guard.release()).not.toThrow();
    expect(wakeRequest).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- src/lib/focus-sounds.test.ts`
Expected: FAIL — cannot find module `@/lib/focus-sounds`.

- [ ] **Step 4: Implement the boundary**

Create `src/lib/focus-sounds.ts`:

```ts
/**
 * Browser-API boundary for the focus timer's device effects (MR ②). Everything
 * here touches the DOM / navigator and degrades silently where unsupported, so
 * the timer component stays thin and its tests mock this module. Audio must be
 * constructed inside a user gesture (the Start tap) so the browser unlocks
 * later programmatic playback.
 */

import { FocusSound } from "@/lib/constants";

/** Each Focus-sound value → its bundled CC0 asset (null = silent). Files live
 * under public/audio/ with a LICENSE note. Streaming sources are a future
 * release — not here. */
export const FOCUS_SOUND_SRC: Record<string, string | null> = {
  [FocusSound.Off]: null,
  [FocusSound.LofiCalm]: "/audio/lofi-calm.mp3",
};

const ALARM_SRC = "/audio/alarm.mp3";

export type Alarm = { play(): void };
export type LoopPlayer = { play(): void; pause(): void; stop(): void };
export type WakeGuard = { release(): void };

function makeAudio(src: string, loop = false): HTMLAudioElement | null {
  try {
    if (typeof Audio === "undefined") return null;
    const a = new Audio(src);
    a.loop = loop;
    return a;
  } catch {
    return null;
  }
}

/** One-shot alarm — call play() at time's-up; also vibrates on mobile. */
export function createAlarm(): Alarm {
  const audio = makeAudio(ALARM_SRC);
  return {
    play() {
      try {
        if (audio) {
          audio.currentTime = 0;
          void audio.play().catch(() => {});
        }
      } catch {
        /* ignore playback errors */
      }
      try {
        navigator.vibrate?.([200, 100, 200]);
      } catch {
        /* vibrate unsupported */
      }
    },
  };
}

/** Looping background player for the given asset. */
export function createLoopPlayer(src: string): LoopPlayer {
  const audio = makeAudio(src, true);
  return {
    play() {
      try {
        void audio?.play().catch(() => {});
      } catch {
        /* ignore */
      }
    },
    pause() {
      try {
        audio?.pause();
      } catch {
        /* ignore */
      }
    },
    stop() {
      try {
        if (audio) {
          audio.pause();
          audio.currentTime = 0;
        }
      } catch {
        /* ignore */
      }
    },
  };
}

type WakeLockLike = {
  request(type: "screen"): Promise<{ release(): Promise<void> }>;
};

/** Acquire a screen wake lock; returns a release handle (a no-op guard where
 * the Wake Lock API is unsupported). */
export async function acquireWakeLock(): Promise<WakeGuard> {
  try {
    const wl = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!wl) return { release() {} };
    const sentinel = await wl.request("screen");
    return {
      release() {
        void sentinel.release().catch(() => {});
      },
    };
  } catch {
    return { release() {} };
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- src/lib/focus-sounds.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/lib/focus-sounds.ts src/lib/focus-sounds.test.ts public/audio/lofi-calm.mp3 public/audio/alarm.mp3 public/audio/LICENSE.md
git commit -m "feat(#8): focus-sounds boundary (alarm/loop/wake-lock) + bundled CC0 assets

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `TimerVisual` — the 4 countdown styles

A presentational component that renders the chosen style (ring/digits/bar/mug), always showing the readable `mm:ss` + "of Nm" text (status never colour-only), with a reduced-motion variant.

**Files:**
- Create: `src/components/focus/timer-visual.tsx`
- Create: `src/components/focus/timer-visual.test.tsx`

**Interfaces:**
- Consumes: `mmss`, `timerFraction` (`@/lib/focus-timer-clock`, Task 5); `FocusTimerStyle` (`@/lib/constants`); `t`, `Voice` (`@/lib/strings`).
- Produces:
  - `function TimerVisual({ style, remainingSec, totalSec, phase, reducedMotion, voice }: { style: FocusTimerStyle; remainingSec: number; totalSec: number; phase: "setup" | "running" | "paused" | "timeup"; reducedMotion: boolean; voice: Voice }): JSX.Element`

- [ ] **Step 1: Write the failing tests**

Create `src/components/focus/timer-visual.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { TimerVisual } from "@/components/focus/timer-visual";

afterEach(cleanup);

const styles = ["ring", "digits", "bar", "mug"] as const;

describe("TimerVisual", () => {
  it.each(styles)("renders the %s style with the mm:ss + 'of Nm' readout (never colour-only)", (style) => {
    render(
      <TimerVisual style={style} remainingSec={125} totalSec={600} phase="running" reducedMotion={false} voice="plain" />,
    );
    const root = screen.getByTestId(`timer-visual-${style}`);
    expect(within(root).getByText("2:05")).toBeInTheDocument();
    expect(within(root).getByText(/of 10m/)).toBeInTheDocument();
  });

  it("bar style exposes a progressbar with numeric min/now/max", () => {
    render(
      <TimerVisual style="bar" remainingSec={300} totalSec={600} phase="running" reducedMotion={false} voice="plain" />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "10");
    expect(bar).toHaveAttribute("aria-valuenow", "5");
  });

  it("drops the animated transition under reduced motion (mug)", () => {
    const { container } = render(
      <TimerVisual style="mug" remainingSec={300} totalSec={600} phase="running" reducedMotion={true} voice="plain" />,
    );
    expect(container.innerHTML).not.toMatch(/transition-\[height\]/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/components/focus/timer-visual.test.tsx`
Expected: FAIL — cannot find module `@/components/focus/timer-visual`.

- [ ] **Step 3: Implement `TimerVisual`**

Create `src/components/focus/timer-visual.tsx`:

```tsx
import { mmss, timerFraction } from "@/lib/focus-timer-clock";
import type { FocusTimerStyle } from "@/lib/constants";
import { t, type Voice } from "@/lib/strings";

type VisualPhase = "setup" | "running" | "paused" | "timeup";

/** The readable countdown text — always shown, in every style, so time-status
 * is never conveyed by colour/shape alone. */
function Readout({
  remainingSec,
  totalSec,
  voice,
}: {
  remainingSec: number;
  totalSec: number;
  voice: Voice;
}) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-5xl font-semibold tabular-nums">{mmss(remainingSec)}</span>
      <span className="text-muted-foreground text-xs tabular-nums">
        {t("focus.timer.of", voice)} {Math.round(totalSec / 60)}m
      </span>
    </div>
  );
}

/**
 * The countdown visual. Four styles (spec Design B): `ring` (SVG ring), `digits`
 * (readout only), `bar` (linear depleting bar), `mug` (a cup that drains). Each
 * shares the Readout and, at time's-up, tints amber (paired with the visible
 * "0:00" text). `reducedMotion` drops the depletion transition.
 */
export function TimerVisual({
  style,
  remainingSec,
  totalSec,
  phase,
  reducedMotion,
  voice,
}: {
  style: FocusTimerStyle;
  remainingSec: number;
  totalSec: number;
  phase: VisualPhase;
  reducedMotion: boolean;
  voice: Voice;
}) {
  const fraction = timerFraction(remainingSec, totalSec);
  const timeup = phase === "timeup";
  const readout = <Readout remainingSec={remainingSec} totalSec={totalSec} voice={voice} />;

  if (style === "digits") {
    return (
      <div data-testid="timer-visual-digits" className="flex justify-center py-10">
        {readout}
      </div>
    );
  }

  if (style === "bar") {
    return (
      <div data-testid="timer-visual-bar" className="space-y-4">
        <div
          className="bg-secondary h-6 w-full overflow-hidden rounded-full"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={Math.round(totalSec / 60)}
          aria-valuenow={Math.round(remainingSec / 60)}
        >
          <div
            className={`h-full ${timeup ? "bg-amber-500" : "bg-primary"} ${
              reducedMotion ? "" : "motion-safe:transition-[width]"
            }`}
            style={{ width: `${fraction * 100}%` }}
          />
        </div>
        <div className="flex justify-center">{readout}</div>
      </div>
    );
  }

  if (style === "mug") {
    return (
      <div data-testid="timer-visual-mug" className="flex flex-col items-center gap-3">
        <div className="relative h-40 w-32 overflow-hidden rounded-b-3xl rounded-t-md border-4">
          <div
            className={`absolute inset-x-0 bottom-0 ${
              timeup ? "bg-amber-400" : "bg-primary/70"
            } ${reducedMotion ? "" : "motion-safe:transition-[height]"}`}
            style={{ height: `${fraction * 100}%` }}
            aria-hidden="true"
          />
        </div>
        {readout}
      </div>
    );
  }

  // ring (default)
  const R = 110;
  const C = 2 * Math.PI * R;
  return (
    <div data-testid="timer-visual-ring" className="flex justify-center">
      <div className="relative h-64 w-64">
        <svg viewBox="0 0 240 240" className="h-full w-full -rotate-90">
          <circle cx="120" cy="120" r={R} fill="none" className="stroke-secondary" strokeWidth="12" />
          <circle
            cx="120"
            cy="120"
            r={R}
            fill="none"
            className={timeup ? "stroke-amber-500" : "stroke-primary"}
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - fraction)}
            style={reducedMotion ? undefined : { transition: "stroke-dashoffset 1s linear" }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">{readout}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/components/focus/timer-visual.test.tsx`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/components/focus/timer-visual.tsx src/components/focus/timer-visual.test.tsx
git commit -m "feat(#8): TimerVisual — ring/digits/bar/mug with a shared always-on readout

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `FocusStepTracker` — segmented tracker + expandable stepper

The multi-step progress under the header: n segments (done/current/upcoming), a `steps ▾` toggle, and an expandable vertical stepper (`✓`/`●`/`○`). Status is shape+glyph, never colour alone.

**Files:**
- Create: `src/components/focus/focus-step-tracker.tsx`
- Create: `src/components/focus/focus-step-tracker.test.tsx`

**Interfaces:**
- Consumes: `cn` (`@/lib/utils`); `t`, `Voice` (`@/lib/strings`).
- Produces:
  - `type TrackerStep = { id: string; text: string; done: boolean; estMinutes: number; subtaskEmoji: string | null }`
  - `function FocusStepTracker({ steps, currentStepId, expanded, onToggle, voice }: { steps: TrackerStep[]; currentStepId: string; expanded: boolean; onToggle: () => void; voice: Voice }): JSX.Element`

- [ ] **Step 1: Write the failing tests**

Create `src/components/focus/focus-step-tracker.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FocusStepTracker, type TrackerStep } from "@/components/focus/focus-step-tracker";

afterEach(cleanup);

const steps: TrackerStep[] = [
  { id: "s1", text: "Outline", done: true, estMinutes: 5, subtaskEmoji: null },
  { id: "s2", text: "Draft intro", done: false, estMinutes: 20, subtaskEmoji: "✍️" },
  { id: "s3", text: "Polish", done: false, estMinutes: 10, subtaskEmoji: null },
];

describe("FocusStepTracker", () => {
  it("renders one segment per step and marks the current one via aria-current (not colour alone)", () => {
    render(<FocusStepTracker steps={steps} currentStepId="s2" expanded={false} onToggle={() => {}} voice="plain" />);
    const segs = screen.getAllByTestId("tracker-segment");
    expect(segs).toHaveLength(3);
    expect(segs[1]).toHaveAttribute("aria-current", "step");
    expect(segs[0]).not.toHaveAttribute("aria-current");
  });

  it("the steps toggle reports expanded state and fires onToggle", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<FocusStepTracker steps={steps} currentStepId="s2" expanded={false} onToggle={onToggle} voice="plain" />);
    const toggle = screen.getByRole("button", { name: /steps/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(onToggle).toHaveBeenCalled();
  });

  it("when expanded, shows the vertical stepper with ✓ / ● / ○ glyphs + per-step estimates", () => {
    render(<FocusStepTracker steps={steps} currentStepId="s2" expanded onToggle={() => {}} voice="plain" />);
    expect(screen.getByText("Outline")).toBeInTheDocument();
    expect(screen.getByText(/Draft intro/)).toBeInTheDocument();
    expect(screen.getByText("Polish")).toBeInTheDocument();
    // Glyphs present (done ✓, current ●, upcoming ○).
    expect(screen.getByText("✓")).toBeInTheDocument();
    expect(screen.getByText("●")).toBeInTheDocument();
    expect(screen.getAllByText("○").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/20m/)).toBeInTheDocument();
  });

  it("hides the stepper list when collapsed", () => {
    render(<FocusStepTracker steps={steps} currentStepId="s2" expanded={false} onToggle={() => {}} voice="plain" />);
    expect(screen.queryByText("Outline")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/components/focus/focus-step-tracker.test.tsx`
Expected: FAIL — cannot find module `@/components/focus/focus-step-tracker`.

- [ ] **Step 3: Implement `FocusStepTracker`**

Create `src/components/focus/focus-step-tracker.tsx`:

```tsx
import { cn } from "@/lib/utils";
import { t, type Voice } from "@/lib/strings";

export type TrackerStep = {
  id: string;
  text: string;
  done: boolean;
  estMinutes: number;
  subtaskEmoji: string | null;
};

type StepState = "done" | "current" | "upcoming";

function stateOf(step: TrackerStep, currentStepId: string): StepState {
  if (step.done) return "done";
  return step.id === currentStepId ? "current" : "upcoming";
}

/**
 * Multi-step progress for the timer (spec Design B): a segmented bar (done /
 * current / upcoming), a `steps ▾` toggle, and — when expanded — a vertical
 * stepper. Status is carried by shape + glyph + aria-current, not colour alone;
 * the parent auto-expands it on pause / time's-up / complete.
 */
export function FocusStepTracker({
  steps,
  currentStepId,
  expanded,
  onToggle,
  voice,
}: {
  steps: TrackerStep[];
  currentStepId: string;
  expanded: boolean;
  onToggle: () => void;
  voice: Voice;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <ol className="flex flex-1 gap-1" aria-label="step progress">
          {steps.map((s) => {
            const state = stateOf(s, currentStepId);
            return (
              <li
                key={s.id}
                data-testid="tracker-segment"
                aria-current={state === "current" ? "step" : undefined}
                title={state}
                className={cn(
                  "h-1.5 flex-1 rounded-full",
                  state === "done" && "bg-primary",
                  state === "current" && "bg-primary ring-primary/40 ring-2",
                  state === "upcoming" && "bg-secondary",
                )}
              />
            );
          })}
        </ol>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="text-muted-foreground hover:text-foreground inline-flex min-h-[44px] shrink-0 items-center text-xs"
        >
          {t("focus.timer.steps", voice)} {expanded ? "▴" : "▾"}
        </button>
      </div>

      {expanded && (
        <ol className="space-y-1 text-sm">
          {steps.map((s) => {
            const state = stateOf(s, currentStepId);
            const glyph = state === "done" ? "✓" : state === "current" ? "●" : "○";
            return (
              <li key={s.id} className="flex items-center gap-2">
                <span aria-hidden="true">{glyph}</span>
                <span className={cn("min-w-0 flex-1 break-words", state === "current" && "font-semibold")}>
                  {s.subtaskEmoji ? `${s.subtaskEmoji} ` : ""}
                  {s.text}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{s.estMinutes}m</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/components/focus/focus-step-tracker.test.tsx`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/components/focus/focus-step-tracker.tsx src/components/focus/focus-step-tracker.test.tsx
git commit -m "feat(#8): FocusStepTracker — segmented + expandable stepper (status not colour-only)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `TimerCustomizationHint` — the one-time nudge

The dismissible first-run callout pointing at settings.

**Files:**
- Create: `src/components/focus/timer-customization-hint.tsx`
- Create: `src/components/focus/timer-customization-hint.test.tsx`

**Interfaces:**
- Consumes: `next/link`; `t`, `Voice` (`@/lib/strings`).
- Produces: `function TimerCustomizationHint({ voice, onDismiss }: { voice: Voice; onDismiss: () => void }): JSX.Element`

- [ ] **Step 1: Write the failing tests**

Create `src/components/focus/timer-customization-hint.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimerCustomizationHint } from "@/components/focus/timer-customization-hint";

vi.mock("next/link", () => ({
  default: ({ children, href, onClick }: { children: React.ReactNode; href: string; onClick?: () => void }) => (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

describe("TimerCustomizationHint", () => {
  it("shows the customization copy and links to /settings", () => {
    render(<TimerCustomizationHint voice="plain" onDismiss={() => {}} />);
    expect(screen.getByText(/make this timer yours/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open settings/i })).toHaveAttribute("href", "/settings");
  });

  it("the ✕ button dismisses (has a text accessible name)", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<TimerCustomizationHint voice="plain" onDismiss={onDismiss} />);
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("tapping through to settings also dismisses (one-time)", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<TimerCustomizationHint voice="plain" onDismiss={onDismiss} />);
    await user.click(screen.getByRole("link", { name: /open settings/i }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/components/focus/timer-customization-hint.test.tsx`
Expected: FAIL — cannot find module `@/components/focus/timer-customization-hint`.

- [ ] **Step 3: Implement `TimerCustomizationHint`**

Create `src/components/focus/timer-customization-hint.tsx`:

```tsx
import Link from "next/link";
import { t, type Voice } from "@/lib/strings";

/**
 * One-time, dismissible nudge that customization options exist (spec Design B).
 * Gated by focusTimerTipDismissedAt: the parent renders it only when unset, and
 * both the ✕ and tapping through to /settings call onDismiss (which fires
 * dismissFocusTimerTip). The ✕ carries a text accessible name (action.dismiss).
 */
export function TimerCustomizationHint({
  voice,
  onDismiss,
}: {
  voice: Voice;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-50 p-3 text-sm dark:bg-amber-950/20">
      <p className="flex-1">
        {t("focus.tip.body", voice)}{" "}
        <Link href="/settings" onClick={onDismiss} className="font-medium underline">
          {t("focus.tip.cta", voice)}
        </Link>
      </p>
      <button
        type="button"
        aria-label={t("action.dismiss", voice)}
        title={t("action.dismiss", voice)}
        onClick={onDismiss}
        className="hover:bg-accent inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md"
      >
        ✕
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/components/focus/timer-customization-hint.test.tsx`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/components/focus/timer-customization-hint.tsx src/components/focus/timer-customization-hint.test.tsx
git commit -m "feat(#8): TimerCustomizationHint — one-time dismissible nudge to /settings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Rewrite `FocusTimer` (hierarchy, ← Back, ±clamp, tracker, minimal, device effects, hint)

Replace the timer client component: new header hierarchy (task title small, active step large) + corner streak, ← Back → `/focus` (no server call), `TimerVisual`, `FocusStepTracker` (auto-expand on stop), next-step peek, minimal mode, ± with clamp + signed net note, device effects via `focus-sounds`, first-run hint. Remove "Pause for now" + the `gaveup` phase/screen.

**Files:**
- Modify: `src/components/focus/focus-timer.tsx` (full rewrite)
- Modify: `src/components/focus/focus-timer.test.tsx` (full rewrite)

**Interfaces:**
- Consumes: `beginFocus`, `completeFocus`, `requeueFocus`, `proposeNewEstimate`, `type CompleteResult` (`@/app/actions/focus`); `dismissFocusTimerTip` (`@/app/actions/settings`, Task 2); `resolveTimerStyle` (Task 4); `mmss`, `applyTimeDelta`, `netAddedMin` (Task 5); `createAlarm`, `createLoopPlayer`, `acquireWakeLock`, `FOCUS_SOUND_SRC`, `type LoopPlayer`, `type WakeGuard` (Task 6); `TimerVisual` (Task 7); `FocusStepTracker`, `type TrackerStep` (Task 8); `TimerCustomizationHint` (Task 9); `usePrefersReducedMotion`; `Celebration`; `useVoice`; `t`.
- Produces:
  - `type TimerSettings = { timerStyle: string | null; minimalMode: boolean; keepAwake: boolean; alarmEnabled: boolean; sound: string }`
  - `type NextStepPeek = { id: string; text: string; subtaskEmoji: string | null }`
  - `function FocusTimer(props): JSX.Element` with props `{ step: StepInfo; steps: TrackerStep[]; taskId: string; taskTitle: string; parentEmoji: string | null; streak: number; focusMinToday: number; nextStep: NextStepPeek | null; isSingleTask: boolean; addTimeIncrementMin: number; settings: TimerSettings; tipDismissed: boolean }` (`StepInfo = { id; text; estMinutes; subtaskEmoji; order; total; done }`).

- [ ] **Step 1: Rewrite the test (red)**

Replace `src/components/focus/focus-timer.test.tsx` with:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FocusTimer } from "@/components/focus/focus-timer";
import type { TrackerStep } from "@/components/focus/focus-step-tracker";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

vi.mock("@/app/actions/focus", () => ({
  beginFocus: vi.fn().mockResolvedValue("session-1"),
  completeFocus: vi.fn().mockResolvedValue({ ok: true, nextStepId: null, points: 15, googleSynced: false, streak: 1, freshStart: false }),
  requeueFocus: vi.fn().mockResolvedValue({ ok: true }),
  proposeNewEstimate: vi.fn().mockResolvedValue(20),
}));
vi.mock("@/app/actions/settings", () => ({ dismissFocusTimerTip: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/use-prefers-reduced-motion", () => ({ usePrefersReducedMotion: () => false }));
// The Celebration confetti isn't under test here.
vi.mock("@/components/focus/celebration", () => ({ Celebration: () => <div /> }));

// Voice is controlled per-test via this mutable ref.
let mockVoice: "plain" | "playful" = "plain";
vi.mock("@/components/voice-provider", () => ({ useVoice: () => mockVoice }));

// Device-effect boundary — assert calls, never touch real APIs.
const alarmPlay = vi.fn();
const loop = { play: vi.fn(), pause: vi.fn(), stop: vi.fn() };
const wakeRelease = vi.fn();
const createAlarm = vi.fn(() => ({ play: alarmPlay }));
const createLoopPlayer = vi.fn(() => loop);
const acquireWakeLock = vi.fn().mockResolvedValue({ release: wakeRelease });
vi.mock("@/lib/focus-sounds", () => ({
  createAlarm: (...a: unknown[]) => createAlarm(...a),
  createLoopPlayer: (...a: unknown[]) => createLoopPlayer(...a),
  acquireWakeLock: (...a: unknown[]) => acquireWakeLock(...a),
  FOCUS_SOUND_SRC: { off: null, lofi_calm: "/audio/lofi-calm.mp3" },
}));

import { beginFocus, completeFocus } from "@/app/actions/focus";
import { dismissFocusTimerTip } from "@/app/actions/settings";

const STEPS: TrackerStep[] = [
  { id: "s1", text: "Outline", done: true, estMinutes: 5, subtaskEmoji: null },
  { id: "s2", text: "Draft intro", done: false, estMinutes: 1, subtaskEmoji: null },
  { id: "s3", text: "Polish", done: false, estMinutes: 10, subtaskEmoji: null },
];

function base(overrides: Partial<Parameters<typeof FocusTimer>[0]> = {}) {
  return {
    step: { id: "s2", text: "Draft intro", estMinutes: 1, subtaskEmoji: null, order: 2, total: 3, done: false },
    steps: STEPS,
    taskId: "t1",
    taskTitle: "Write report",
    parentEmoji: null,
    streak: 4,
    focusMinToday: 30,
    nextStep: { id: "s3", text: "Polish", subtaskEmoji: null },
    isSingleTask: false,
    addTimeIncrementMin: 5,
    settings: { timerStyle: null, minimalMode: false, keepAwake: true, alarmEnabled: true, sound: "off" },
    tipDismissed: false,
    ...overrides,
  } as Parameters<typeof FocusTimer>[0];
}

async function start(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /start focusing/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVoice = "plain";
});
afterEach(cleanup);

describe("FocusTimer — header, back, hierarchy", () => {
  it("← Back links to /focus (no server call to leave — session stays open)", () => {
    render(<FocusTimer {...base()} />);
    expect(screen.getByRole("link", { name: /back/i })).toHaveAttribute("href", "/focus");
  });

  it("the active step text is larger (text-xl) than the task title (text-sm)", () => {
    render(<FocusTimer {...base()} />);
    const stepHeading = screen.getByRole("heading", { name: /draft intro/i });
    expect(stepHeading.className).toMatch(/text-xl/);
    expect(screen.getByText("Write report").className).toMatch(/text-sm/);
  });

  it("shows the corner streak + minutes today", () => {
    render(<FocusTimer {...base()} />);
    expect(screen.getByText(/🔥4/)).toBeInTheDocument();
    expect(screen.getByText(/30m today/)).toBeInTheDocument();
  });

  it("has NO 'Pause for now' control and never reaches a 'Paused — no guilt' screen", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    expect(screen.queryByRole("button", { name: /pause for now/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/no guilt/i)).not.toBeInTheDocument();
  });
});

describe("FocusTimer — style resolution", () => {
  it("defaults to ring in plain voice", () => {
    render(<FocusTimer {...base()} />);
    expect(screen.getByTestId("timer-visual-ring")).toBeInTheDocument();
  });
  it("defaults to mug in playful voice", () => {
    mockVoice = "playful";
    render(<FocusTimer {...base()} />);
    expect(screen.getByTestId("timer-visual-mug")).toBeInTheDocument();
  });
  it("honours an explicit stored style", () => {
    render(<FocusTimer {...base({ settings: { timerStyle: "digits", minimalMode: false, keepAwake: true, alarmEnabled: true, sound: "off" } })} />);
    expect(screen.getByTestId("timer-visual-digits")).toBeInTheDocument();
  });
});

describe("FocusTimer — ±time with clamp + signed note", () => {
  it("+5m shows a +5m net note; the − button is present", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base({ step: { id: "s2", text: "Draft intro", estMinutes: 10, subtaskEmoji: null, order: 2, total: 3, done: false } })} />);
    await start(user);
    await user.click(screen.getByRole("button", { name: /\+5m/i }));
    expect(screen.getByText(/\+5m/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /−5m|-5m/i })).toBeInTheDocument();
  });
});

describe("FocusTimer — multi-step context + minimal mode", () => {
  it("shows the step tracker + next-step peek for a multi-step task", () => {
    render(<FocusTimer {...base()} />);
    expect(screen.getByRole("button", { name: /steps/i })).toBeInTheDocument();
    expect(screen.getByText(/next →/)).toBeInTheDocument();
  });

  it("hides the multi-step context for single-task focus", () => {
    render(<FocusTimer {...base({ isSingleTask: true })} />);
    expect(screen.queryByRole("button", { name: /steps/i })).not.toBeInTheDocument();
  });

  it("auto-expands the tracker on pause", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    await user.click(screen.getByRole("button", { name: /pause/i }));
    expect(screen.getByRole("button", { name: /steps/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("minimal mode hides the tracker + corner while running", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base({ settings: { timerStyle: null, minimalMode: true, keepAwake: false, alarmEnabled: false, sound: "off" } })} />);
    await start(user);
    expect(screen.queryByRole("button", { name: /steps/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/today/)).not.toBeInTheDocument();
  });
});

describe("FocusTimer — first-run hint gating", () => {
  it("shows the hint when not dismissed; ✕ calls dismissFocusTimerTip and hides it", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base({ tipDismissed: false })} />);
    expect(screen.getByText(/make this timer yours/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(dismissFocusTimerTip).toHaveBeenCalled();
    expect(screen.queryByText(/make this timer yours/i)).not.toBeInTheDocument();
  });

  it("hides the hint when already dismissed", () => {
    render(<FocusTimer {...base({ tipDismissed: true })} />);
    expect(screen.queryByText(/make this timer yours/i)).not.toBeInTheDocument();
  });
});

describe("FocusTimer — device effects behind the boundary", () => {
  it("primes alarm + acquires the wake lock on Start when enabled; no loop when sound is off", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base()} />);
    await start(user);
    expect(beginFocus).toHaveBeenCalledWith("s2", 1);
    expect(createAlarm).toHaveBeenCalled();
    expect(acquireWakeLock).toHaveBeenCalled();
    expect(createLoopPlayer).not.toHaveBeenCalled();
  });

  it("does NOT prime alarm / wake lock / loop when all are disabled", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base({ settings: { timerStyle: null, minimalMode: false, keepAwake: false, alarmEnabled: false, sound: "off" } })} />);
    await start(user);
    expect(createAlarm).not.toHaveBeenCalled();
    expect(acquireWakeLock).not.toHaveBeenCalled();
    expect(createLoopPlayer).not.toHaveBeenCalled();
  });

  it("starts the lofi loop when a sound is chosen", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base({ settings: { timerStyle: null, minimalMode: false, keepAwake: false, alarmEnabled: false, sound: "lofi_calm" } })} />);
    await start(user);
    expect(createLoopPlayer).toHaveBeenCalledWith("/audio/lofi-calm.mp3");
    expect(loop.play).toHaveBeenCalled();
  });
});

describe("FocusTimer — alarm + auto-expand at time's-up (fake timers)", () => {
  it("fires the alarm and auto-expands the tracker when the countdown hits zero", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    render(<FocusTimer {...base()} />); // step estMinutes = 1 → 60s
    await start(user);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(alarmPlay).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /steps/i })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/time's up/i)).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe("FocusTimer — complete", () => {
  it("Complete step calls completeFocus and stops the loop", async () => {
    const user = userEvent.setup();
    render(<FocusTimer {...base({ settings: { timerStyle: null, minimalMode: false, keepAwake: false, alarmEnabled: false, sound: "lofi_calm" } })} />);
    await start(user);
    await user.click(screen.getByRole("button", { name: /complete step/i }));
    expect(completeFocus).toHaveBeenCalled();
    expect(loop.stop).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/focus/focus-timer.test.tsx`
Expected: FAIL — the current component still has the old signature/behaviour ("Pause for now", no `TimerVisual` testids, no ← Back → /focus, etc.).

- [ ] **Step 3: Rewrite `focus-timer.tsx`**

Replace `src/components/focus/focus-timer.tsx` with:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  beginFocus,
  completeFocus,
  requeueFocus,
  proposeNewEstimate,
  type CompleteResult,
} from "@/app/actions/focus";
import { dismissFocusTimerTip } from "@/app/actions/settings";
import { Celebration } from "@/components/focus/celebration";
import { TimerVisual } from "@/components/focus/timer-visual";
import { FocusStepTracker, type TrackerStep } from "@/components/focus/focus-step-tracker";
import { TimerCustomizationHint } from "@/components/focus/timer-customization-hint";
import { resolveTimerStyle } from "@/lib/focus-timer-style";
import { applyTimeDelta, netAddedMin } from "@/lib/focus-timer-clock";
import {
  createAlarm,
  createLoopPlayer,
  acquireWakeLock,
  FOCUS_SOUND_SRC,
  type Alarm,
  type LoopPlayer,
  type WakeGuard,
} from "@/lib/focus-sounds";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import { t } from "@/lib/strings";
import { useVoice } from "@/components/voice-provider";

const DONE_MESSAGES = [
  "Nice — step done!",
  "Boom. That's one off the list. 💪",
  "Look at you, actually doing the thing.",
  "One step closer. That felt good, right?",
  "Done and dusted. Proud of you.",
];

type Phase = "setup" | "running" | "paused" | "timeup" | "reestimate" | "done" | "requeued";

type StepInfo = {
  id: string;
  text: string;
  estMinutes: number;
  subtaskEmoji: string | null;
  order: number;
  total: number;
  done: boolean;
};

export type TimerSettings = {
  timerStyle: string | null;
  minimalMode: boolean;
  keepAwake: boolean;
  alarmEnabled: boolean;
  sound: string;
};

export type NextStepPeek = { id: string; text: string; subtaskEmoji: string | null };

export function FocusTimer({
  step,
  steps,
  taskId,
  taskTitle,
  parentEmoji,
  streak,
  focusMinToday,
  nextStep,
  isSingleTask,
  addTimeIncrementMin,
  settings,
  tipDismissed,
}: {
  step: StepInfo;
  steps: TrackerStep[];
  taskId: string;
  taskTitle: string;
  parentEmoji: string | null;
  streak: number;
  focusMinToday: number;
  nextStep: NextStepPeek | null;
  isSingleTask: boolean;
  addTimeIncrementMin: number;
  settings: TimerSettings;
  tipDismissed: boolean;
}) {
  const router = useRouter();
  const voice = useVoice();
  const reducedMotion = usePrefersReducedMotion();
  const timerStyle = resolveTimerStyle(settings.timerStyle, voice);

  const [phase, setPhase] = useState<Phase>("setup");
  const [plannedMin, setPlannedMin] = useState(step.estMinutes);
  const [totalSec, setTotalSec] = useState(step.estMinutes * 60);
  const [remainingSec, setRemainingSec] = useState(step.estMinutes * 60);
  const elapsedRef = useRef(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [newEst, setNewEst] = useState(step.estMinutes);
  const [result, setResult] = useState<CompleteResult | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [tipVisible, setTipVisible] = useState(!tipDismissed);
  const doneMsgRef = useRef(DONE_MESSAGES[Math.floor(Math.random() * DONE_MESSAGES.length)]);

  // Device-effect handles (created on Start inside the user gesture).
  const alarmRef = useRef<Alarm | null>(null);
  const loopRef = useRef<LoopPlayer | null>(null);
  const wakeRef = useRef<WakeGuard | null>(null);

  const inc = Math.max(1, addTimeIncrementMin || 5);
  const durationMin = () => Math.max(0, Math.round(elapsedRef.current / 60));
  const net = netAddedMin(totalSec, plannedMin * 60);
  const atFloor = remainingSec <= 60;

  const releaseWake = () => {
    wakeRef.current?.release();
    wakeRef.current = null;
  };

  // Countdown ticker.
  useEffect(() => {
    if (phase !== "running") return;
    const id = setInterval(() => {
      elapsedRef.current += 1;
      setRemainingSec((r) => {
        if (r <= 1) {
          clearInterval(id);
          setPhase("timeup");
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [phase]);

  // Focus sound + wake lock follow the "running" phase.
  useEffect(() => {
    if (phase === "running") {
      loopRef.current?.play();
      if (settings.keepAwake && !wakeRef.current) {
        void acquireWakeLock().then((g) => {
          wakeRef.current = g;
        });
      }
    } else {
      loopRef.current?.pause();
      releaseWake();
    }
  }, [phase, settings.keepAwake]);

  // Alarm at time's-up.
  useEffect(() => {
    if (phase === "timeup") alarmRef.current?.play();
  }, [phase]);

  // Auto-expand the step tracker when the timer stops (calm while running,
  // orienting when stopped).
  useEffect(() => {
    if (phase === "paused" || phase === "timeup") setExpanded(true);
  }, [phase]);

  // Cleanup on unmount — ← Back leaves the FocusSession OPEN (no server call),
  // so we only stop local effects here.
  useEffect(
    () => () => {
      loopRef.current?.stop();
      releaseWake();
    },
    [],
  );

  const start = async () => {
    setPending(true);
    const id = await beginFocus(step.id, plannedMin);
    setPending(false);
    if (!id) return;
    // Prime device effects inside the user gesture (unlocks audio playback).
    if (settings.alarmEnabled) alarmRef.current = createAlarm();
    const src = FOCUS_SOUND_SRC[settings.sound] ?? null;
    if (src) loopRef.current = createLoopPlayer(src);
    setSessionId(id);
    setTotalSec(plannedMin * 60);
    setRemainingSec(plannedMin * 60);
    elapsedRef.current = 0;
    setPhase("running");
  };

  const changeTime = (mins: number) => {
    const next = applyTimeDelta({ totalSec, remainingSec }, mins * 60);
    setTotalSec(next.totalSec);
    setRemainingSec(next.remainingSec);
    if (phase === "timeup" && mins > 0) setPhase("running");
  };

  const finishComplete = useCallback(async () => {
    if (!sessionId) return;
    setPending(true);
    const res = await completeFocus(sessionId, {
      durationMin: durationMin(),
      addedMin: Math.max(0, net),
    });
    setPending(false);
    setResult(res);
    loopRef.current?.stop();
    releaseWake();
    setPhase("done");
    router.refresh();
  }, [sessionId, net, router]);

  const startReestimate = async () => {
    setPhase("reestimate");
    setPending(true);
    const suggested = await proposeNewEstimate(step.id);
    setNewEst(suggested);
    setPending(false);
  };

  const confirmRequeue = async () => {
    if (!sessionId) return;
    setPending(true);
    await requeueFocus(sessionId, {
      durationMin: durationMin(),
      addedMin: Math.max(0, net),
      newEstMinutes: newEst,
    });
    setPending(false);
    loopRef.current?.stop();
    releaseWake();
    setPhase("requeued");
  };

  const dismissTip = () => {
    setTipVisible(false);
    void dismissFocusTimerTip();
  };

  const running = phase === "running";
  const showContext = !isSingleTask && !(settings.minimalMode && running);
  const showCorner = !(settings.minimalMode && running);
  const remainingInTask = steps.filter((s) => !s.done).reduce((n, s) => n + s.estMinutes, 0);

  const stepHeading = (
    <div className="min-w-0">
      <p className="text-muted-foreground truncate text-sm font-semibold">
        {parentEmoji ? `${parentEmoji} ` : ""}
        {taskTitle}
      </p>
      <h1 className="text-xl font-bold">
        {step.subtaskEmoji ? `${step.subtaskEmoji} ` : ""}
        {step.text}
      </h1>
    </div>
  );

  // ── End screens ────────────────────────────────────────────────────────────
  if (phase === "done") {
    return (
      <div className="space-y-5 text-center">
        {stepHeading}
        <div className="flex justify-center pt-6">
          <Celebration />
        </div>
        <div className="text-6xl">🎉</div>
        <p className="text-lg font-medium">{doneMsgRef.current}</p>
        {result && (
          <p className="text-muted-foreground text-sm">
            +{result.points} points
            {result.googleSynced ? " · marked complete in Google Tasks ✅" : ""}
          </p>
        )}
        {result?.streak ? (
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {result.freshStart
              ? "🌱 Fresh start — day 1 again, and that's completely okay."
              : `🔥 ${result.streak}-day streak!`}
          </p>
        ) : null}
        <div className="flex flex-col items-center gap-2">
          {nextStep ? (
            <Link
              href={`/focus/${nextStep.id}`}
              className="bg-primary text-primary-foreground rounded-md px-4 py-2 font-medium"
            >
              ▶ {t("focus.nextStep", voice)}
            </Link>
          ) : (
            <p className="text-sm">That was the last step of this task. 🏁</p>
          )}
          <Link href="/focus" className="text-muted-foreground text-sm hover:underline">
            {t("action.back", voice)}
          </Link>
        </div>
      </div>
    );
  }

  if (phase === "requeued") {
    return (
      <div className="space-y-4 text-center">
        {stepHeading}
        <div className="text-5xl">🌱</div>
        <p className="text-lg font-medium">No worries — bumped to {newEst} min.</p>
        <p className="text-muted-foreground text-sm">It&apos;s back on your list with a kinder estimate.</p>
        <Link
          href="/focus"
          className="bg-primary text-primary-foreground inline-block rounded-md px-4 py-2 font-medium"
        >
          {t("action.back", voice)}
        </Link>
      </div>
    );
  }

  // ── Active / setup screen ────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* ← Back → /focus (the launcher is the logical parent; leaving makes no
          server call, so the FocusSession stays open/resumable). */}
      <Link
        href="/focus"
        className="text-muted-foreground hover:text-foreground inline-flex min-h-[44px] items-center text-sm"
      >
        {t("action.back", voice)}
      </Link>

      <div className="flex items-start justify-between gap-2">
        {stepHeading}
        {showCorner && (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            🔥{streak} · {focusMinToday}m today
          </span>
        )}
      </div>

      {tipVisible && <TimerCustomizationHint voice={voice} onDismiss={dismissTip} />}

      {showContext && (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs tabular-nums">
            {t("step.counter", voice)} {step.order} of {step.total} · ~{remainingInTask}m{" "}
            {t("focus.timer.leftInTask", voice)}
          </p>
          <FocusStepTracker
            steps={steps}
            currentStepId={step.id}
            expanded={expanded}
            onToggle={() => setExpanded((e) => !e)}
            voice={voice}
          />
        </div>
      )}

      <TimerVisual
        style={timerStyle}
        remainingSec={remainingSec}
        totalSec={totalSec}
        phase={phase === "reestimate" ? "timeup" : phase}
        reducedMotion={reducedMotion}
        voice={voice}
      />
      {net !== 0 && (
        <p className="text-muted-foreground text-center text-xs tabular-nums">
          {net > 0 ? "+" : "−"}
          {Math.abs(net)}m
        </p>
      )}

      {/* Controls */}
      {phase === "setup" && (
        <div className="flex flex-col items-center gap-3">
          <label className="text-muted-foreground flex items-center gap-2 text-sm">
            Duration
            <input
              type="number"
              min={1}
              value={plannedMin}
              onChange={(e) => {
                const v = Math.max(1, Number(e.target.value) || 1);
                setPlannedMin(v);
                setTotalSec(v * 60);
                setRemainingSec(v * 60);
              }}
              className="border-input w-20 rounded-md border px-2 py-1 text-right"
            />
            min
          </label>
          <button
            onClick={start}
            disabled={pending}
            className="bg-primary text-primary-foreground rounded-full px-8 py-3 text-lg font-medium disabled:opacity-50"
          >
            {t("focus.startTimer", voice)}
          </button>
        </div>
      )}

      {(phase === "running" || phase === "paused") && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={finishComplete}
            disabled={pending}
            className="inline-flex min-h-[44px] items-center rounded-md bg-green-600 px-5 font-medium text-white disabled:opacity-50"
          >
            {t("focus.timer.completeStep", voice)}
          </button>
          <button
            onClick={() => setPhase((p) => (p === "running" ? "paused" : "running"))}
            className="hover:bg-accent inline-flex min-h-[44px] items-center rounded-md border px-4"
          >
            {phase === "running" ? t("focus.pause", voice) : t("focus.resume", voice)}
          </button>
          <button
            onClick={() => changeTime(-inc)}
            disabled={atFloor}
            className="hover:bg-accent inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border disabled:opacity-40"
          >
            −{inc}m
          </button>
          <button
            onClick={() => changeTime(inc)}
            className="hover:bg-accent inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border"
          >
            +{inc}m
          </button>
        </div>
      )}

      {phase === "timeup" && (
        <div className="space-y-3 text-center">
          <p className="text-lg font-medium">{t("focus.timesUp", voice)}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              onClick={finishComplete}
              disabled={pending}
              className="inline-flex min-h-[44px] items-center rounded-md bg-green-600 px-4 font-medium text-white disabled:opacity-50"
            >
              {t("focus.yesDone", voice)}
            </button>
            <button
              onClick={() => changeTime(inc)}
              className="hover:bg-accent inline-flex min-h-[44px] items-center rounded-md border px-4"
            >
              +{inc}m
            </button>
            <button
              onClick={startReestimate}
              disabled={pending}
              className="hover:bg-accent inline-flex min-h-[44px] items-center rounded-md border px-4 disabled:opacity-50"
            >
              {t("focus.notYet", voice)}
            </button>
          </div>
        </div>
      )}

      {phase === "reestimate" && (
        <div className="space-y-3 text-center">
          <p className="font-medium">No problem. Here&apos;s a kinder estimate:</p>
          {pending ? (
            <p className="text-muted-foreground text-sm">Claude is re-estimating…</p>
          ) : (
            <div className="flex items-center justify-center gap-2">
              <input
                type="number"
                min={1}
                value={newEst}
                onChange={(e) => setNewEst(Math.max(1, Number(e.target.value) || 1))}
                className="border-input w-24 rounded-md border px-2 py-1 text-right"
              />
              <span className="text-muted-foreground text-sm">min</span>
              <button
                onClick={confirmRequeue}
                className="bg-primary text-primary-foreground inline-flex min-h-[44px] items-center rounded-md px-4 font-medium"
              >
                Requeue
              </button>
            </div>
          )}
        </div>
      )}

      {/* Next-step peek (below controls). */}
      {showContext && nextStep && (phase === "running" || phase === "paused" || phase === "timeup") && (
        <p className="text-muted-foreground text-center text-xs">
          {t("focus.hero.next", voice)} {nextStep.subtaskEmoji ? `${nextStep.subtaskEmoji} ` : ""}
          {nextStep.text}
        </p>
      )}
    </div>
  );
}
```

> **Note:** the next-step peek reuses `focus.hero.next` ("next →"). The `phase` passed to `TimerVisual` maps `reestimate` → `timeup` (both are post-countdown states) so the type stays the 4-value union.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/components/focus/focus-timer.test.tsx`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/components/focus/focus-timer.tsx src/components/focus/focus-timer.test.tsx
git commit -m "feat(#8): redesign FocusTimer — hierarchy, ←Back, ±clamp, tracker, minimal, device effects, hint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Wire the timer page — steps list, dashboard, settings, next-step

Feed the redesigned `FocusTimer` real data: the full ordered step list (tracker), `getDashboardData` (streak + minutes today), the new settings, the next step (peek + done-screen link), `isSingleTask`, and `tipDismissed`.

**Files:**
- Modify: `src/app/(app)/focus/[stepId]/page.tsx` (full rewrite of the component body)

**Interfaces:**
- Consumes: `prisma`, `getSettings` (`@/lib/db`); `currentWorkspaceId` (`@/lib/workspace`); `getDashboardData` (`@/lib/rewards`); `FocusTimer` (Task 10); `notFound` (`next/navigation`).
- Produces: the default `/focus/[stepId]` route component (`default` + `dynamic`).

- [ ] **Step 1: Rewrite the page**

Replace `src/app/(app)/focus/[stepId]/page.tsx` with:

```tsx
import { notFound } from "next/navigation";
import { prisma, getSettings } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { getDashboardData } from "@/lib/rewards";
import { FocusTimer } from "@/components/focus/focus-timer";

export const dynamic = "force-dynamic";

export default async function FocusPage({
  params,
}: {
  params: Promise<{ stepId: string }>;
}) {
  const workspaceId = await currentWorkspaceId();
  const { stepId } = await params;
  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
    include: { task: true },
  });
  if (!step) notFound();

  const [settings, dashboard, steps, nextStep] = await Promise.all([
    getSettings(workspaceId),
    getDashboardData(workspaceId),
    prisma.step.findMany({
      where: { taskId: step.taskId, task: { workspaceId } },
      orderBy: { order: "asc" },
    }),
    prisma.step.findFirst({
      where: { taskId: step.taskId, done: false, order: { gt: step.order }, task: { workspaceId } },
      orderBy: { order: "asc" },
    }),
  ]);

  return (
    <FocusTimer
      step={{
        id: step.id,
        text: step.text,
        estMinutes: step.estMinutes,
        subtaskEmoji: step.subtaskEmoji,
        order: step.order,
        total: step.total,
        done: step.done,
      }}
      steps={steps.map((s) => ({
        id: s.id,
        text: s.text,
        done: s.done,
        estMinutes: s.estMinutes,
        subtaskEmoji: s.subtaskEmoji,
      }))}
      taskId={step.taskId}
      taskTitle={step.task.title}
      parentEmoji={step.task.parentEmoji}
      streak={dashboard.currentStreak}
      focusMinToday={dashboard.focusMinToday}
      nextStep={nextStep ? { id: nextStep.id, text: nextStep.text, subtaskEmoji: nextStep.subtaskEmoji } : null}
      isSingleTask={step.total <= 1}
      addTimeIncrementMin={settings.addTimeIncrementMin}
      settings={{
        timerStyle: settings.focusTimerStyle,
        minimalMode: settings.focusMinimalMode,
        keepAwake: settings.focusKeepAwake,
        alarmEnabled: settings.focusAlarmEnabled,
        sound: settings.focusSound,
      }}
      tipDismissed={settings.focusTimerTipDismissedAt != null}
    />
  );
}
```

- [ ] **Step 2: Typecheck + build the route**

Run: `npx tsc --noEmit`
Expected: clean (`settings.focusTimerStyle` etc. exist after Task 1's `prisma generate`).
Run: `npx next build`
Expected: compiles; `/focus/[stepId]` renders with no error.

> No DB unit test is added here (mapping is exercised by the seam tests in Tasks 4–5 + the `FocusTimer` RTL in Task 10; the live query is covered by `tsc` + `next build` + the manual sweep in Task 13). `focusStatsToday` is no longer imported here — streak + minutes now come from `getDashboardData`.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/focus/[stepId]/page.tsx"
git commit -m "feat(#8): wire the redesigned timer page — steps list, dashboard, settings, next-step

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: `FocusTimerSection` settings group + mount

The user-facing Focus-timer group: style radios (incl. "Match voice" = null), the minimal/keep-awake/alarm toggles, and the sound select — auto-saving each change like the other settings sections.

**Files:**
- Create: `src/components/settings/focus-timer-section.tsx`
- Create: `src/components/settings/focus-timer-section.test.tsx`
- Modify: `src/app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `updateFocusTimerSettings` (Task 2); `FocusTimerStyle`, `FocusSound` (Task 1); `useSaveStatus`, `SaveIndicator`; `t`, `Voice`; `useRouter`.
- Produces: `function FocusTimerSection({ timerStyle, minimalMode, keepAwake, alarmEnabled, sound, voice }: { timerStyle: string | null; minimalMode: boolean; keepAwake: boolean; alarmEnabled: boolean; sound: string; voice: Voice }): JSX.Element`

- [ ] **Step 1: Write the failing RTL test**

Create `src/components/settings/focus-timer-section.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FocusTimerSection } from "@/components/settings/focus-timer-section";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock("@/app/actions/settings", () => ({
  updateFocusTimerSettings: vi.fn().mockResolvedValue(undefined),
}));
import { updateFocusTimerSettings } from "@/app/actions/settings";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const base = {
  timerStyle: null as string | null,
  minimalMode: false,
  keepAwake: true,
  alarmEnabled: true,
  sound: "off",
  voice: "plain" as const,
};

describe("FocusTimerSection", () => {
  it("seeds the controls from props ('Match voice' when style is null)", () => {
    render(<FocusTimerSection {...base} />);
    expect(screen.getByLabelText(/match voice/i)).toBeChecked();
    expect(screen.getByLabelText(/keep screen awake/i)).toBeChecked();
    expect(screen.getByLabelText(/minimal/i)).not.toBeChecked();
  });

  it("choosing the Mug style auto-saves the full pref set", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(screen.getByLabelText(/^mug/i));
    await waitFor(() =>
      expect(updateFocusTimerSettings).toHaveBeenCalledWith({
        timerStyle: "mug",
        minimalMode: false,
        keepAwake: true,
        alarmEnabled: true,
        sound: "off",
      }),
    );
  });

  it("toggling keep-awake off auto-saves", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.click(screen.getByLabelText(/keep screen awake/i));
    await waitFor(() =>
      expect(updateFocusTimerSettings).toHaveBeenCalledWith(
        expect.objectContaining({ keepAwake: false }),
      ),
    );
  });

  it("choosing a sound auto-saves", async () => {
    const user = userEvent.setup();
    render(<FocusTimerSection {...base} />);
    await user.selectOptions(screen.getByLabelText(/focus sounds/i), "lofi_calm");
    await waitFor(() =>
      expect(updateFocusTimerSettings).toHaveBeenCalledWith(
        expect.objectContaining({ sound: "lofi_calm" }),
      ),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/settings/focus-timer-section.test.tsx`
Expected: FAIL — cannot find module `@/components/settings/focus-timer-section`.

- [ ] **Step 3: Implement the section**

Create `src/components/settings/focus-timer-section.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateFocusTimerSettings } from "@/app/actions/settings";
import { FocusTimerStyle, FocusSound } from "@/lib/constants";
import { t, type Voice } from "@/lib/strings";
import { useSaveStatus, SaveIndicator } from "@/components/settings/use-save-status";

type Prefs = {
  timerStyle: string | null;
  minimalMode: boolean;
  keepAwake: boolean;
  alarmEnabled: boolean;
  sound: string;
};

/**
 * MR ② — the Focus-timer settings group. Auto-saves each change (no Save
 * button), mirroring NotificationsSection. "Match voice" persists a null style
 * (→ the timer resolves ring/mug from the voice). A failed write surfaces a
 * non-blocking error and leaves the controls editable.
 */
export function FocusTimerSection({
  timerStyle,
  minimalMode,
  keepAwake,
  alarmEnabled,
  sound,
  voice,
}: Prefs & { voice: Voice }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { status, markSaving, markSaved, markError } = useSaveStatus();
  const [prefs, setPrefs] = useState<Prefs>({ timerStyle, minimalMode, keepAwake, alarmEnabled, sound });

  const persist = (next: Prefs) =>
    startTransition(async () => {
      markSaving();
      try {
        await updateFocusTimerSettings(next);
        markSaved();
        router.refresh();
      } catch {
        markError();
      }
    });

  const set = <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    persist(next);
  };

  const styleOptions: { value: string; label: string }[] = [
    { value: "", label: t("focusSettings.styleAuto", voice) },
    { value: FocusTimerStyle.Ring, label: t("focusSettings.styleRing", voice) },
    { value: FocusTimerStyle.Digits, label: t("focusSettings.styleDigits", voice) },
    { value: FocusTimerStyle.Bar, label: t("focusSettings.styleBar", voice) },
    { value: FocusTimerStyle.Mug, label: t("focusSettings.styleMug", voice) },
  ];

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{t("focusSettings.heading", voice)}</h2>
        <SaveIndicator status={status} voice={voice} />
      </div>
      <p className="text-muted-foreground text-sm">{t("focusSettings.intro", voice)}</p>

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">{t("focusSettings.style", voice)}</legend>
        {styleOptions.map((o) => (
          <label key={o.value || "auto"} className="flex min-h-[44px] items-center gap-2 text-sm">
            <input
              type="radio"
              name="focusTimerStyle"
              checked={(prefs.timerStyle ?? "") === o.value}
              onChange={() => set("timerStyle", o.value === "" ? null : o.value)}
            />
            {o.label}
          </label>
        ))}
      </fieldset>

      <Toggle
        label={t("focusSettings.minimal", voice)}
        hint={t("focusSettings.minimalHint", voice)}
        checked={prefs.minimalMode}
        onChange={(v) => set("minimalMode", v)}
      />
      <Toggle
        label={t("focusSettings.keepAwake", voice)}
        hint={t("focusSettings.keepAwakeHint", voice)}
        checked={prefs.keepAwake}
        onChange={(v) => set("keepAwake", v)}
      />
      <Toggle
        label={t("focusSettings.alarm", voice)}
        hint={t("focusSettings.alarmHint", voice)}
        checked={prefs.alarmEnabled}
        onChange={(v) => set("alarmEnabled", v)}
      />

      <label className="flex min-h-[44px] items-center justify-between gap-2 text-sm">
        <span className="font-medium">{t("focusSettings.sound", voice)}</span>
        <select
          value={prefs.sound}
          onChange={(e) => set("sound", e.target.value)}
          className="border-input rounded-md border px-2 py-1"
        >
          <option value={FocusSound.Off}>{t("focusSettings.soundOff", voice)}</option>
          <option value={FocusSound.LofiCalm}>{t("focusSettings.soundLofiCalm", voice)}</option>
        </select>
      </label>
    </section>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex min-h-[44px] items-start justify-between gap-3 text-sm">
      <span className="flex flex-col">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground text-xs">{hint}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-5 w-5 shrink-0"
      />
    </label>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/components/settings/focus-timer-section.test.tsx`
Expected: PASS (all cases).

- [ ] **Step 5: Mount the section on the settings page**

In `src/app/(app)/settings/page.tsx`, add the import:

```tsx
import { FocusTimerSection } from "@/components/settings/focus-timer-section";
```

and, immediately after the `<NotificationsSection … />` block (its wrapping `<div className="border-t pt-4">…</div>`), add:

```tsx
      <div className="border-t pt-4">
        <FocusTimerSection
          timerStyle={settings.focusTimerStyle}
          minimalMode={settings.focusMinimalMode}
          keepAwake={settings.focusKeepAwake}
          alarmEnabled={settings.focusAlarmEnabled}
          sound={settings.focusSound}
          voice={voice}
        />
      </div>
```

> **Stacking note:** MR ③ adds its `<AppearanceSection>` mount to this same list — keep both.

- [ ] **Step 6: Typecheck + build**

Run: `npx tsc --noEmit`
Expected: clean.
Run: `npx next build`
Expected: compiles; `/settings` renders the Focus-timer group.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/focus-timer-section.tsx src/components/settings/focus-timer-section.test.tsx "src/app/(app)/settings/page.tsx"
git commit -m "feat(#8): FocusTimerSection settings group (auto-save) + mount on /settings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: a11y sweep, E2E, full gates, refresh the MR

Lock in the 4-item a11y sweep with explicit regression assertions, update/confirm Playwright selectors, run all gates + the manual visual/behavioral sweep, and refresh the MR for review.

**Files:**
- Create: `src/components/focus/focus-timer-a11y.test.tsx`
- Modify: any Playwright spec that drives `/focus/[stepId]` (see Step 2)

**Interfaces:**
- Consumes: `TimerVisual` (Task 7), `FocusStepTracker` (Task 8), `FocusTimer` (Task 10).
- Produces: no new exports (test-only + any inline class/role fixes).

- [ ] **Step 1: Write the a11y regression assertions**

Create `src/components/focus/focus-timer-a11y.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TimerVisual } from "@/components/focus/timer-visual";
import { FocusStepTracker, type TrackerStep } from "@/components/focus/focus-step-tracker";

afterEach(cleanup);

const steps: TrackerStep[] = [
  { id: "s1", text: "Outline", done: true, estMinutes: 5, subtaskEmoji: null },
  { id: "s2", text: "Draft", done: false, estMinutes: 20, subtaskEmoji: null },
];

describe("focus-timer a11y sweep", () => {
  it("time status is text, not colour-only: the readout shows mm:ss + 'of Nm' in every style", () => {
    for (const style of ["ring", "digits", "bar", "mug"] as const) {
      cleanup();
      render(<TimerVisual style={style} remainingSec={65} totalSec={600} phase="timeup" reducedMotion={false} voice="plain" />);
      expect(screen.getByText("1:05")).toBeInTheDocument();
      expect(screen.getByText(/of 10m/)).toBeInTheDocument();
    }
  });

  it("reduced motion removes the ring's stroke transition", () => {
    const { container } = render(
      <TimerVisual style="ring" remainingSec={300} totalSec={600} phase="running" reducedMotion={true} voice="plain" />,
    );
    expect(container.innerHTML).not.toMatch(/stroke-dashoffset 1s linear/);
  });

  it("the step tracker toggle is a ≥44px target with a text accessible name + aria-expanded", () => {
    render(<FocusStepTracker steps={steps} currentStepId="s2" expanded={false} onToggle={() => {}} voice="plain" />);
    const toggle = screen.getByRole("button", { name: /steps/i });
    expect(toggle.className).toMatch(/min-h-\[44px\]/);
    expect(toggle).toHaveAttribute("aria-expanded");
  });

  it("the current step is marked with aria-current (not colour alone)", () => {
    render(<FocusStepTracker steps={steps} currentStepId="s2" expanded onToggle={() => {}} voice="plain" />);
    const segs = screen.getAllByTestId("tracker-segment");
    expect(segs[1]).toHaveAttribute("aria-current", "step");
  });
});
```

- [ ] **Step 2: Run the a11y assertions + update/confirm Playwright selectors**

Run: `npm test -- src/components/focus/focus-timer-a11y.test.tsx`
Expected: PASS if Tasks 7–10 landed the classes/roles as written. If any assertion FAILS, add the missing class/role in the corresponding file (do NOT weaken the assertion), then re-run until green.

Find any e2e spec that drives the timer:
Run: `grep -rEl "/focus/|FocusTimer|Start focusing|Pause for now" e2e tests 2>/dev/null; ls playwright.config.* 2>/dev/null`
- If a spec exists, update its `/focus/[stepId]` selectors to the new roles/labels: `link name:/back/` → `/focus`, the larger step heading, `button name:/complete step/`, `button name:/pause|resume/`, `button name:/[-−+]5m/`, the `steps ▾` toggle, and remove any "Pause for now" / "no guilt" assertions (deleted). Keep forged-session auth.
- If none exists, record that in the MR description (as MR ① did — there was no Playwright infra on the focus branch).

- [ ] **Step 3: Full gates**

Run: `npx tsc --noEmit && npm run lint`
Expected: `tsc` clean · lint 0 new errors.
Run: `npx prisma migrate deploy` (ensure this worktree's Postgres is migrated), then `npm test`
Expected: all vitest suites green — the new seams (`focus-timer-style`, `focus-timer-clock`, `focus-sounds`), the components (`timer-visual`, `focus-step-tracker`, `timer-customization-hint`, `focus-timer`, `focus-timer-a11y`), the settings (`focus-timer-section`, `settings.focustimer`), the strings suite, and the `enum-constraint-sync.integration.test.ts` (now incl. the two new constraints).
Run: `npx next build`
Expected: compiles; `/focus` + `/focus/[stepId]` + `/settings` render.
Run: `npm run test:e2e`
Expected: Chromium suite green (forged-session auth).

- [ ] **Step 4: Manual verification (use the `run` / `verify` project skill)**

jsdom can't compute custom-property colours or drive real audio/wake-lock, so sweep these by hand in the running app:
- **Contrast (WCAG-AA, light + dark):** the corner streak, the amber time's-up tint on each visual, the paused/upcoming tracker segments, the hint card, the settings labels.
- **Reduced-motion:** with OS "reduce motion" on, the ring/bar/mug depletion is instant (no transition); the Celebration stays static.
- **≥44px:** every control (Complete step, Pause/Resume, −/+, steps toggle, ✕ hint, ← Back, settings rows).
- **Status not colour-only:** the mm:ss readout is always visible; the tracker uses shape/glyph + aria-current.
- **Device behaviour:** with a real device — alarm chime + vibrate at time's-up; the lofi loop plays while running, pauses on pause, stops on complete/leave; keep-awake holds the screen while running and releases on pause/end/← Back; minimal mode hides the chrome while running.
- Toggle voice → playful defaults the style to **mug**, plain to **ring**; playful adds emoji anchors, plain stays emoji-free (bar functional glyphs).

Record the results in the MR description.

- [ ] **Step 5: Commit any a11y fixes**

```bash
git add src/components/focus/focus-timer-a11y.test.tsx src/components/focus/timer-visual.tsx src/components/focus/focus-step-tracker.tsx src/components/focus/focus-timer.tsx
git commit -m "test(#8): a11y sweep for the /focus timer (44px, aria-current, reduced-motion, status-not-colour-only)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Push + refresh the MR (do NOT merge)**

```bash
git push -u origin feat/focus-timer-mr2
```
Then open/refresh the MR for `feat/focus-timer-mr2`:
- **Milestone:** v0.2.0.
- **Reviewer:** add **@GitLabDuo** (code MR).
- **Description:** MR ② = the redesigned focus **timer** + its **Focus-timer settings** group; note the 6 new `Settings` columns (2 CHECK-guarded, #38 pattern), the bundled CC0 audio + LICENSE, that MR ③ stacks on top and re-stamps its migration after this one, and the manual-sweep results from Step 4.
Wait for GitLabDuo's review + apply sensible suggestions before any merge; owner sign-off gates the merge.

---

## Self-Review (author checklist — completed)

**1. Spec coverage (Design B timer + Design C Focus-timer settings + a11y + Testing + Files):**
- ← Back in a consistent place → `/focus`, no server call (session stays open) → Task 10 (shell) + test. ✅
- Active step title slightly LARGER than the task title → Task 10 (`text-xl` step vs `text-sm` task) + assertion. ✅
- "Option B" on-page actions (bigger/fewer, ≥44px: Complete step · Pause/Resume · −/+ · time's-up trio) → Task 10. ✅
- Progress indication (step X of Y · ~Nm left, segmented tracker + expand, timer fraction) → Tasks 8 + 10. ✅
- Four timer styles ring/digits/bar/mug, default mug (playful)/ring (plain), enum + DB CHECK (#38) → Tasks 1 (constants/CHECK/sync), 4 (resolve), 7 (visual). ✅ *(spec says four; see Flags re: the task brief's "three" wording.)*
- Alarm at time's-up (setting) → Tasks 1/6/10 (fires at timeup behind the boundary). ✅
- Minimal / distraction-free (setting) → Tasks 1/10 (hides chrome while running). ✅
- Keep screen awake (setting; Wake Lock) → Tasks 1/6/10 (acquire while running, release on stop/unmount, silent degrade). ✅
- Audio: optional CC0 lofi loop (setting); YouTube/Spotify/SoundCloud explicitly future → Tasks 1/6 (asset + FOCUS_SOUND_SRC, no streaming) /10 (loop follows running). ✅
- First-time helper nudge (one-time, gated on `focusTimerTipDismissedAt`) → Tasks 1/2 (`dismissFocusTimerTip`) /9 (hint) /10 (gating). ✅
- a11y 4-item sweep (reduced-motion · WCAG-AA both themes · ≥44px · status-not-colour-only) → wired in Tasks 7–10, asserted in Task 13, manual contrast/behaviour in Task 13 Step 4. ✅
- Focus-timer settings group surfaced with auto-save → Task 12. ✅
- Value-set columns via constants.ts + CHECK + sync registry + migration (#38) → Task 1. ✅
- Every new string via `t()` with plain + playful → Task 3 (+ reuse of existing keys). ✅
- Remove "Pause for now" + `gaveup` phase → Task 10 (asserted absent). ✅
- Symmetric ±time with clamp (remaining ≥ 1:00) + signed net "±Xm" → Tasks 5 (math) /10 (UI). ✅

**2. Placeholder scan:** No "TBD"/"similar to Task N"/"add error handling"/"handle edge cases". Every code step carries real code; every test step carries real assertions; every run step carries an exact command + expected output. The only intentionally-not-inlined artifacts are the two binary CC0 audio files (sourced + committed in Task 6 Step 1, with a LICENSE) — binaries can't live in a plan. ✅

**3. Type consistency:**
- `FocusTimerStyle` / `FocusSound` (Task 1) are consumed by `resolveTimerStyle` (Task 4), `updateFocusTimerSettings` (Task 2), `FOCUS_SOUND_SRC` (Task 6), `FocusTimerSection` (Task 12), and the sync REGISTRY (Task 1). ✅
- `resolveTimerStyle(setting, voice): FocusTimerStyle` (Task 4) feeds `TimerVisual.style: FocusTimerStyle` (Task 7) via `FocusTimer` (Task 10). ✅
- `applyTimeDelta`/`netAddedMin`/`mmss`/`timerFraction` (Task 5) are consumed by `FocusTimer` (Task 10) + `TimerVisual` (Task 7) with matching signatures. ✅
- `focus-sounds` exports `createAlarm/createLoopPlayer/acquireWakeLock/FOCUS_SOUND_SRC` + types `Alarm/LoopPlayer/WakeGuard` (Task 6), all imported with those exact names in `FocusTimer` (Task 10) and mocked identically in its test. ✅
- `TrackerStep` (Task 8) is the element type of `FocusTimer.steps` (Task 10), produced by the page's `steps.map(...)` (Task 11). ✅
- `TimerSettings` (Task 10) is exactly what the page builds from `settings.focus*` (Task 11) and mirrors `updateFocusTimerSettings`'s input (Task 2) + `FocusTimerSection`'s props (Task 12). ✅
- `dismissFocusTimerTip(): Promise<void>` (Task 2) is called by `FocusTimer` (Task 10) and `TimerCustomizationHint` via `onDismiss` (Task 9). ✅

**Known deviations / decisions (documented):**
- **Style count:** implemented **four** styles (ring/digits/bar/mug) per the spec's Design B + settings table, not "three" — the task brief's "three … and a third — bar and mug" is internally contradictory; the spec (source of truth) is unambiguous. Flagged in the return.
- **Minimal mode + corner** hide **while running** (consistent with the spec's audio/device bullet), reappearing when stopped (auto-expand orients the user) — a small reconciliation of the two spec bullets. Flagged.
- **`addTimeIncrementMin` / `defaultFromEstimate`** (listed "(existing)" in the spec's Focus-timer group) are **not** newly surfaced in `FocusTimerSection` — they have no current settings UI and adding them is out of MR ② scope; `addTimeIncrementMin` is still consumed by the timer's ±buttons. Flagged.
- **`giveUpFocus`** server action stays exported (UI no longer calls it); removing it is out of scope.
- **CC0 sound set** ships `off` + `lofi_calm` only (the spec's "1–2 bundled CC0 loops"); `FocusSound` + the CHECK are the extension point for more loops later.
