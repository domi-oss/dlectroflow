# App-wide Completion Style (Appearance settings) — MR ③ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an app-wide **completion style** the user controls from a new **Appearance** settings group: `completeStrikethrough` (line-through finished text, default on) + `completeTickColor` (the ✓ glyph colour, `green`|`black`, default green). Implement it **once** at the app shell (Design D) — the two settings become root data attributes → CSS custom properties, and every completion render site (task-steps done rows, inbox done rows, the Library Done-view `ProgressPill`) references two shared class names, so they all follow the setting automatically. Both colours meet WCAG-AA in light **and** dark; status stays glyph+text (never colour-only).

**Architecture:** A pure, DB-free `src/lib/completion-style.ts` is the single seam: `completionRootAttrs(settings)` maps the two settings → `{ "data-complete-strike", "data-tick" }`, and two exported class constants (`COMPLETE_TICK`, `COMPLETE_TEXT`) resolve their colour/decoration from CSS custom properties keyed off those attributes in `globals.css`. The app shell (`(app)/layout.tsx`) already fetches `getSettings(wsId)`; we spread `completionRootAttrs(settings)` on its outer wrapper so the vars cascade to every route. The render sites drop their hard-coded `line-through` / `text-green-600` for the shared classes. A new client `AppearanceSection` (auto-save, mirroring `NotificationsSection`) persists the two fields via a new `updateAppearanceSettings` server action; the two value-set/boolean columns are added with a migration, a `CompleteTickColor` constants set, a Postgres CHECK constraint, and an `enum-constraint-sync` registry entry — **consistent with #38**.

**Tech Stack:** Next.js (modified fork — see Global Constraints), React (Server Components + client settings island), Prisma/Postgres, TypeScript, Vitest + Testing Library (jsdom for component tests; a Postgres-backed `*.integration.test.ts` for the CHECK ↔ constants sync).

## Global Constraints

*(Cross-cutting rules copied verbatim from the spec + repo conventions. Every task's requirements implicitly include this section.)*

- **This is a modified Next.js fork.** Before writing any Next-specific code, read the relevant guide in `node_modules/next/dist/docs/`. Heed deprecation notices.
- **MR ③ scope only.** This MR is the Appearance group + app-wide completion style. **EXCLUDE the timer and the launcher** (those are MRs ②/①). The only new schema is the two Appearance `Settings` columns; no other model changes.
- **#38 CHECK pattern (mandatory for `completeTickColor`).** `src/lib/constants.ts` is the single source of truth for the value set. A migration adds a `Settings_completeTickColor_check` CHECK constraint mirroring it exactly (naming `<Table>_<column>_check`), and `src/lib/enum-constraint-sync.integration.test.ts` gains a REGISTRY entry deriving its expected values from the imported constant object. Adding/removing a value later means a follow-up DROP+ADD migration or the sync test fails.
- **Implement once, not per-component (Design D).** The completion treatment lives in ONE place (`completion-style.ts` + `globals.css` + the layout root attrs). Render sites only reference `COMPLETE_TICK` / `COMPLETE_TEXT`; never re-hardcode `line-through` or a tick colour.
- **a11y — status is never colour-only.** Every done indicator is **glyph + text**: the ✓ keeps its `aria-label`/`title` "done"; finished text keeps the ✓ alongside it. `completeTickColor` only changes the glyph *colour*, never removes the glyph or its accessible name.
- **WCAG-AA in light AND dark for both tick colours.** `green` uses a 700-weight in light and a lighter 400-weight in dark (the repo's proven `text-green-700 dark:text-green-400` pairing, expressed as OKLCH custom-property values). `black` maps to `--foreground` (near-black on light, near-white on dark), so it is AA by construction in both themes.
- **Voice-aware strings:** all user-facing text resolves via `t(key, voice)`. `t()` returns a **static** string — no `{n}` interpolation. Plain voice carries no decorative emoji (functional glyphs only: ✓, ✅). New Appearance keys follow this.
- **Auto-save like the others:** the Appearance section uses `useSaveStatus` + `SaveIndicator` and persists on every change (no Save button), exactly like `NotificationsSection`. A failed write surfaces a non-blocking error and leaves controls editable.
- **Workspace isolation:** the action resolves `currentWorkspaceId()` and upserts by it (guests keep their own values; no owner gate — this is a personalisation, not an outbound/privileged setting).
- **App-wide revalidation:** `updateAppearanceSettings` calls `revalidatePath("/", "layout")` because the completion style affects every route's shell (same as `updateVoice`).
- **Per-worktree Postgres for gating:** the sync `*.integration.test.ts` needs a real Postgres. Run `npx prisma generate` after editing the schema, `npx prisma migrate deploy` against **this worktree's own** Postgres schema (never `migrate dev`), then the test. Seed worktree `node_modules` via `cp -Rc` CoW clone; do not regenerate `package-lock.json` locally.
- **Branch / MR:** work in `feat/focus-completion-mr3` (milestone **v0.2.0**). Add **@GitLabDuo as reviewer** (code MR). **Do NOT merge, do NOT push to main**; owner sign-off + GitLabDuo re-review gate the merge.
- **Gates before every push:** `npx tsc --noEmit` clean · `npm run lint` 0 new errors · `npm test` all green (incl. the sync integration test after `migrate deploy`) · `npx next build` compiles.
- **Run all commands from the worktree root:** `/Users/gitlab_dlectronique/workdev/dlectroflow/.claude/worktrees/mr3-plan` (build) — the plan DOC is committed on `feat/focus-completion-mr3`.

### Stacking on MR ② (feat/focus-timer-mr2) — coordination

MR ③'s **build** rebases onto MR ②'s branch (not main). Both MRs touch the same files; reconcile as follows when rebasing:

- **Migration ordering:** ②'s migration adds the Focus-timer columns (+ CHECK for `focusTimerStyle`, `focusSound`). ③'s migration (this plan: `20260720120000_settings_completion_style`) **must sort AFTER ②'s** in `prisma/migrations/`. If ②'s timestamp is later-or-equal on rebase, **re-stamp ③'s migration directory** to a strictly-greater timestamp so `migrate deploy` applies ② then ③.
- **`src/lib/constants.ts`:** ② adds `FocusTimerStyle` / `FocusSound`; ③ adds `CompleteTickColor`. Keep all three — no conflict beyond adjacent additions.
- **`enum-constraint-sync.integration.test.ts` REGISTRY:** ② adds `Settings_focusTimerStyle_check` + `Settings_focusSound_check`; ③ adds `Settings_completeTickColor_check`. Keep all entries + all imports.
- **`src/app/(app)/settings/page.tsx`:** ② mounts `FocusTimerSection`; ③ mounts `AppearanceSection`. Keep both section mounts in the shared list.
- **`src/lib/strings.ts` + `prisma/schema.prisma`:** both append keys / `Settings` columns. Union both additions.
- **`settings-panel.tsx`:** ③ removes the inline "Appearance"+ThemeToggle block (moved into `AppearanceSection`); ② does not touch this block. Low conflict risk.

For the plan DOC and its standalone build/test, branching off `main` is fine — `main` already has the #38 CHECK migration (`20260719171754_add_status_check_constraints`), the sync test, and the #36 drop-reclaim migration merged.

---

## File Structure

**Create:**
- `prisma/migrations/20260720120000_settings_completion_style/migration.sql` — add `Settings.completeStrikethrough` (Bool, default true) + `Settings.completeTickColor` (String, default 'green') + `Settings_completeTickColor_check` CHECK. **One responsibility:** the DB delta for the Appearance settings.
- `src/lib/completion-style.ts` — the single completion-style seam: pure `completionRootAttrs(settings)` + the shared `COMPLETE_TICK` / `COMPLETE_TEXT` class constants. **One responsibility:** map settings → root attrs, and expose the classes render sites consume. No React/DB.
- `src/lib/completion-style.test.ts` — unit tests for the mapping + that the classes read the CSS custom properties.
- `src/app/actions/settings.appearance.test.ts` — node unit test for `updateAppearanceSettings` (boolean coercion + tick-colour allowlist mirroring the CHECK).
- `src/components/settings/appearance-section.tsx` — **(`"use client"`)** the Appearance group: theme toggle + the two completion controls, auto-save, with a live preview. **One responsibility:** the Appearance settings UI.
- `src/components/settings/appearance-section.test.tsx` — RTL: seeded state, auto-save each field, live-preview reflects pending choice, ✓ has a text accessible name.

**Modify:**
- `prisma/schema.prisma` — add the two `Settings` columns (mirror the CHECK value set in a comment, per repo convention).
- `src/lib/constants.ts` — add the `CompleteTickColor` pseudo-enum ({green, black}).
- `src/lib/enum-constraint-sync.integration.test.ts` — import `CompleteTickColor`; add the `Settings_completeTickColor_check` REGISTRY entry.
- `src/app/actions/settings.ts` — add `updateAppearanceSettings` (allowlist-validated tick colour, `revalidatePath("/", "layout")`).
- `src/app/globals.css` — data-attr → `--tick-color` / `--complete-decoration` custom-property rules (light + dark).
- `src/app/(app)/layout.tsx` — spread `completionRootAttrs(settings)` on the shell wrapper.
- `src/components/breakdown/task-steps.tsx` — done step: `line-through` → `COMPLETE_TEXT`, `text-green-600` ✓ → `COMPLETE_TICK`.
- `src/components/breakdown/task-steps.test.tsx` — update the done-step assertion from `line-through` to the shared classes.
- `src/components/inbox/inbox-view.tsx` — done row text (`:1179`) + reopen-picker "stays done" preview (`:1312`): `line-through` → `COMPLETE_TEXT`.
- `src/app/(app)/library/page.tsx` — `ProgressPill`: green border/text + ✅ → `COMPLETE_TICK`-driven treatment (✓ glyph inherits `--tick-color`; border via `border-[color:var(--tick-color)]`).
- `src/lib/strings.ts` — new voice-aware `appearance.*` keys.
- `src/app/(app)/settings/page.tsx` — mount `<AppearanceSection>` with the two fields + voice.
- `src/components/settings/settings-panel.tsx` — remove the inline "Appearance"+`ThemeToggle` block + the now-unused `ThemeToggle` import (moved into `AppearanceSection`, so Appearance is a single group).

**Audited, NO change (documented decision):**
- `src/components/focus/focus-timer.tsx` done screen — a celebration surface (🎉 + a "marked complete in Google Tasks ✅" sync confirmation), not a per-item completion-status render: no strikethrough text, and its ✅ is a confirmation glyph, not the themeable status ✓. Left as-is.
- `src/components/inbox/complete-button.tsx` — triggers completion; it is not a done-state render. No change.

---

## Task 1: Schema + `CompleteTickColor` + migration + CHECK + sync registry (#38 pattern)

Add the DB layer for the two Appearance settings, with the value-set column guarded by a CHECK constraint kept in lockstep with `constants.ts` by the sync test.

**Files:**
- Modify: `prisma/schema.prisma` (Settings model)
- Modify: `src/lib/constants.ts`
- Create: `prisma/migrations/20260720120000_settings_completion_style/migration.sql`
- Modify: `src/lib/enum-constraint-sync.integration.test.ts`

**Interfaces:**
- Produces: `CompleteTickColor = { Green: "green"; Black: "black" }` + type; `Settings.completeStrikethrough: boolean`, `Settings.completeTickColor: string`; the `Settings_completeTickColor_check` constraint.
- Consumed by: `updateAppearanceSettings` (Task 2), `completionRootAttrs`/layout (Tasks 3–4), `AppearanceSection` (Task 6), and the sync test.

- [ ] **Step 1: Add the constant + the sync-test registry entry (red first)**

In `src/lib/constants.ts`, after the `WorkspaceKind` block, add:

```ts
// ── MR ③ — app-wide completion style (Appearance settings) ─────────────────
// completeTickColor is a String column guarded by a Postgres CHECK constraint
// (Settings_completeTickColor_check). This object is the single source of truth
// for the allowed set; the CHECK migration + enum-constraint-sync test mirror it.
export const CompleteTickColor = {
  Green: "green",
  Black: "black",
} as const;
export type CompleteTickColor =
  (typeof CompleteTickColor)[keyof typeof CompleteTickColor];
```

In `src/lib/enum-constraint-sync.integration.test.ts`, add `CompleteTickColor` to the `@/lib/constants` import, and append to the `REGISTRY` array:

```ts
  { constraint: "Settings_completeTickColor_check", table: "Settings", column: "completeTickColor", values: CompleteTickColor, nullable: false },
```

- [ ] **Step 2: Run the sync test to verify it fails**

Run: `npm test -- src/lib/enum-constraint-sync.integration.test.ts`
Expected: FAIL — the "has exactly the managed CHECK constraints" case reports `Settings_completeTickColor_check` as expected-but-not-applied (the migration/column don't exist yet).

- [ ] **Step 3: Add the schema columns**

In `prisma/schema.prisma`, inside `model Settings` (after the Phase 6 notification block, before `updatedAt`), add:

```prisma
  // MR ③ — app-wide completion style (Appearance). completeTickColor mirrors
  // CompleteTickColor in src/lib/constants.ts + Settings_completeTickColor_check.
  completeStrikethrough Boolean  @default(true)
  completeTickColor     String   @default("green") // green | black
```

- [ ] **Step 4: Write the migration**

Create `prisma/migrations/20260720120000_settings_completion_style/migration.sql`:

```sql
-- MR ③ — app-wide completion style (Appearance settings).
--
-- Two per-workspace Settings columns drive the app-wide completion treatment
-- (line-through on finished text + the ✓ glyph colour). completeTickColor is a
-- String pseudo-enum: its allowed set lives in src/lib/constants.ts
-- (CompleteTickColor) and is mirrored by the CHECK below + kept in sync by
-- src/lib/enum-constraint-sync.integration.test.ts (#38 pattern).

ALTER TABLE "Settings" ADD COLUMN "completeStrikethrough" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "completeTickColor" TEXT NOT NULL DEFAULT 'green';

-- Settings.completeTickColor ← CompleteTickColor (green | black)
ALTER TABLE "Settings"
  ADD CONSTRAINT "Settings_completeTickColor_check"
  CHECK ("completeTickColor" IN ('green', 'black'));
```

> **Stacking note (build only):** on rebase onto MR ②, ensure this directory sorts **after** ②'s migration; re-stamp the timestamp if ②'s is later-or-equal.

- [ ] **Step 5: Regenerate the client, apply, and verify green**

Run: `npx prisma generate`
Run: `npx prisma migrate deploy` (this worktree's Postgres schema)
Run: `npm test -- src/lib/enum-constraint-sync.integration.test.ts`
Expected: PASS — the managed-set case now matches, and `Settings_completeTickColor_check` permits exactly `{green, black}` (a non-nullable column, so no `IS NULL` allowance).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma "prisma/migrations/20260720120000_settings_completion_style/migration.sql" src/lib/constants.ts src/lib/enum-constraint-sync.integration.test.ts
git commit -m "feat(#8): Settings completion-style columns + CHECK (#38 pattern) for MR ③

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `updateAppearanceSettings` server action

Persist the two Appearance fields, allowlist-validating the tick colour (mirrors the CHECK) and revalidating the whole layout (app-wide).

**Files:**
- Modify: `src/app/actions/settings.ts`
- Create: `src/app/actions/settings.appearance.test.ts`

**Interfaces:**
- Consumes: `prisma` (`@/lib/db`), `currentWorkspaceId` (`@/lib/workspace`), `CompleteTickColor` (`@/lib/constants`), `revalidatePath` (`next/cache`).
- Produces: `updateAppearanceSettings(input: { completeStrikethrough: boolean; completeTickColor: string }): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `src/app/actions/settings.appearance.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const upsert = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/db", () => ({ prisma: { settings: { upsert } } }));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: vi.fn().mockResolvedValue("ws-1"),
  isOwnerRequest: vi.fn().mockResolvedValue(true),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { updateAppearanceSettings } from "@/app/actions/settings";

beforeEach(() => vi.clearAllMocks());

describe("updateAppearanceSettings", () => {
  it("persists a boolean strike + an allowlisted tick colour", async () => {
    await updateAppearanceSettings({ completeStrikethrough: false, completeTickColor: "black" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws-1" },
        update: { completeStrikethrough: false, completeTickColor: "black" },
      }),
    );
  });

  it("coerces an out-of-set tick colour back to green (mirrors the CHECK)", async () => {
    await updateAppearanceSettings({ completeStrikethrough: true, completeTickColor: "purple" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { completeStrikethrough: true, completeTickColor: "green" },
      }),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/app/actions/settings.appearance.test.ts`
Expected: FAIL — `updateAppearanceSettings` is not exported.

- [ ] **Step 3: Implement the action**

In `src/app/actions/settings.ts`, add `CompleteTickColor` to the `@/lib/constants` import, then append:

```ts
/**
 * MR ③ — app-wide completion style (Appearance). Workspace-scoped personalisation
 * (guests keep their own values; no owner gate). completeTickColor is
 * allowlist-validated against CompleteTickColor — anything else falls back to
 * green, matching the Settings_completeTickColor_check CHECK constraint so a
 * bad value can never reach the DB. Revalidates the whole layout because the
 * completion treatment is applied app-wide in (app)/layout.tsx (like voice).
 */
export async function updateAppearanceSettings(input: {
  completeStrikethrough: boolean;
  completeTickColor: string;
}) {
  const workspaceId = await currentWorkspaceId();
  const completeTickColor = (Object.values(CompleteTickColor) as string[]).includes(
    input.completeTickColor,
  )
    ? input.completeTickColor
    : CompleteTickColor.Green;
  const data = {
    completeStrikethrough: Boolean(input.completeStrikethrough),
    completeTickColor,
  };
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, ...data },
    update: data,
  });
  revalidatePath("/", "layout");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/app/actions/settings.appearance.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/app/actions/settings.ts src/app/actions/settings.appearance.test.ts
git commit -m "feat(#8): updateAppearanceSettings action (tick-colour allowlist, app-wide revalidate)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Pure completion-style seam (`completion-style.ts`)

The DB/React-free heart of Design D: map the two settings to root data attributes, and expose the two class names every render site uses.

**Files:**
- Create: `src/lib/completion-style.ts`
- Create: `src/lib/completion-style.test.ts`

**Interfaces:**
- Produces:
  - `function completionRootAttrs(settings: { completeStrikethrough: boolean; completeTickColor: string }): { "data-complete-strike": "on" | "off"; "data-tick": "green" | "black" }`
  - `const COMPLETE_TICK: string` (✓ colour → `--tick-color`)
  - `const COMPLETE_TEXT: string` (finished-text decoration → `--complete-decoration`)
- Consumed by: layout (Task 4), all render sites (Task 5), `AppearanceSection` preview (Task 6).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/completion-style.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  completionRootAttrs,
  COMPLETE_TICK,
  COMPLETE_TEXT,
} from "@/lib/completion-style";

describe("completionRootAttrs", () => {
  it("maps the defaults (strike on + green)", () => {
    expect(
      completionRootAttrs({ completeStrikethrough: true, completeTickColor: "green" }),
    ).toEqual({ "data-complete-strike": "on", "data-tick": "green" });
  });

  it("maps strike off + black", () => {
    expect(
      completionRootAttrs({ completeStrikethrough: false, completeTickColor: "black" }),
    ).toEqual({ "data-complete-strike": "off", "data-tick": "black" });
  });

  it("falls back to green for any unknown tick colour", () => {
    expect(
      completionRootAttrs({ completeStrikethrough: true, completeTickColor: "purple" }),
    ).toMatchObject({ "data-tick": "green" });
  });
});

describe("shared completion classes", () => {
  it("the tick colour + text decoration read the CSS custom properties", () => {
    expect(COMPLETE_TICK).toContain("var(--tick-color)");
    expect(COMPLETE_TEXT).toContain("var(--complete-decoration)");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/completion-style.test.ts`
Expected: FAIL — cannot find module `@/lib/completion-style`.

- [ ] **Step 3: Implement the seam**

Create `src/lib/completion-style.ts`:

```ts
/**
 * App-wide completion styling (MR ③, Design D). The two Appearance settings are
 * applied ONCE at the app shell as root data attributes (see (app)/layout.tsx);
 * globals.css keys the --tick-color / --complete-decoration custom properties
 * off those attributes, and every completion render site simply uses the two
 * shared class names below. Implement once — never re-hardcode `line-through`
 * or a tick colour in a component.
 */

/** Root data attributes for the app-shell wrapper. `black` maps (via CSS) to
 * --foreground so it is WCAG-AA in both themes; `green` resolves to a 700-weight
 * in light and a 400-weight in dark. Any unknown colour degrades to green. */
export function completionRootAttrs(settings: {
  completeStrikethrough: boolean;
  completeTickColor: string;
}): { "data-complete-strike": "on" | "off"; "data-tick": "green" | "black" } {
  return {
    "data-complete-strike": settings.completeStrikethrough ? "on" : "off",
    "data-tick": settings.completeTickColor === "black" ? "black" : "green",
  };
}

/** The ✓ done-glyph colour — resolves from --tick-color. Always pair the glyph
 * with a text accessible name so status is never colour-only. */
export const COMPLETE_TICK = "text-[color:var(--tick-color)]";

/** Finished-text decoration — resolves from --complete-decoration
 * (line-through | none). Replaces hard-coded `line-through` at every site. */
export const COMPLETE_TEXT = "[text-decoration-line:var(--complete-decoration)]";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/completion-style.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/completion-style.ts src/lib/completion-style.test.ts
git commit -m "feat(#8): pure completion-style seam — root attrs + shared classes (Design D)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: CSS custom properties + app-shell root wiring

Turn the root data attributes into the two custom properties (light + dark), and set them once in the layout from the workspace settings.

**Files:**
- Modify: `src/app/globals.css`
- Modify: `src/app/(app)/layout.tsx`

**Interfaces:**
- Consumes: `completionRootAttrs` (Task 3), `getSettings(wsId)` (already fetched in the layout).
- Produces: `--tick-color` + `--complete-decoration` cascading from the shell.

- [ ] **Step 1: Add the custom-property rules**

In `src/app/globals.css`, immediately after the closing brace of the `.dark { … }` block (before `@layer base`), add:

```css
/* MR ③ — app-wide completion style (Design D). The Appearance settings are
 * applied once on the app-shell wrapper as data-* attributes (see
 * (app)/layout.tsx); these rules resolve them into the two custom properties
 * every completion render site consumes (COMPLETE_TICK / COMPLETE_TEXT in
 * src/lib/completion-style.ts). Both tick colours meet WCAG-AA in light + dark:
 * `black` maps to --foreground (near-black on light, near-white on dark);
 * `green` uses a 700-weight in light and a 400-weight in dark (the repo's proven
 * text-green-700 / dark:text-green-400 pairing, as OKLCH). */
:root {
  --complete-decoration: line-through;
  --tick-color: oklch(0.527 0.154 150.069); /* ~green-700 */
}
[data-complete-strike="off"] {
  --complete-decoration: none;
}
[data-tick="green"] {
  --tick-color: oklch(0.527 0.154 150.069); /* ~green-700, AA on light */
}
[data-tick="black"] {
  --tick-color: var(--foreground);
}
.dark [data-tick="green"] {
  --tick-color: oklch(0.792 0.209 151.711); /* ~green-400, AA on dark */
}
```

> `.dark [data-tick="black"]` needs no rule — `--foreground` is already the near-white dark value. `.dark` is applied on `<html>` (see `theme-toggle.tsx`), and the shell wrapper carrying `data-tick` is a descendant, so the `.dark [data-tick=…]` selector matches.

- [ ] **Step 2: Wire the layout root**

In `src/app/(app)/layout.tsx`, add the import:

```ts
import { completionRootAttrs } from "@/lib/completion-style";
```

and spread the attrs on the outermost wrapper (the `settings` row is already fetched at line ~33). Change:

```tsx
    <div className="flex min-h-full flex-col">
```

to:

```tsx
    <div className="flex min-h-full flex-col" {...completionRootAttrs(settings)}>
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit`
Expected: clean (`settings` structurally satisfies the `completionRootAttrs` param — it carries `completeStrikethrough` + `completeTickColor` after Task 1's `prisma generate`).
Run: `npx next build`
Expected: compiles; the app shell renders with `data-complete-strike` / `data-tick` present.

- [ ] **Step 4: Commit**

```bash
git add src/app/globals.css "src/app/(app)/layout.tsx"
git commit -m "feat(#8): wire app-wide completion CSS vars from Appearance settings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Point the completion render sites at the shared treatment

Audit + convert every completion render site to the two shared classes, dropping hard-coded `line-through` / green literals so they follow the setting.

**Files:**
- Modify: `src/components/breakdown/task-steps.tsx`
- Modify: `src/components/breakdown/task-steps.test.tsx`
- Modify: `src/components/inbox/inbox-view.tsx`
- Modify: `src/app/(app)/library/page.tsx`

**Interfaces:**
- Consumes: `COMPLETE_TICK`, `COMPLETE_TEXT` (Task 3).
- Produces: no new exports (in-place class swaps + updated assertions).

- [ ] **Step 1: Update the `task-steps` done-step assertion (red)**

`src/components/breakdown/task-steps.test.tsx:88` currently asserts `title.className` contains `"line-through"`. Replace that assertion, and add a tick assertion, so the test pins the shared classes instead:

```ts
    // Done step uses the app-wide completion treatment (Design D), not a
    // hard-coded line-through / green.
    expect(title.className).toContain("[text-decoration-line:var(--complete-decoration)]");
    const tick = screen.getByLabelText("done");
    expect(tick.className).toContain("text-[color:var(--tick-color)]");
    expect(tick).toHaveTextContent("✓");
```

(If the existing test does not already grab the ✓ element, add the `getByLabelText("done")` lookup as shown.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/components/breakdown/task-steps.test.tsx`
Expected: FAIL — the done text still renders `line-through`, and the ✓ still uses `text-green-600`.

- [ ] **Step 3: Convert `task-steps.tsx`**

In `src/components/breakdown/task-steps.tsx`, add to the imports:

```ts
import { COMPLETE_TICK, COMPLETE_TEXT } from "@/lib/completion-style";
```

In the done branch (currently lines ~128-135), change the text span and the ✓ span:

```tsx
              <span className={cn("text-muted-foreground flex-1", COMPLETE_TEXT)}>
                {s.subtaskEmoji ? `${s.subtaskEmoji} ` : ""}
                {s.text}
              </span>
              <span className="text-muted-foreground text-xs">{s.estMinutes}m</span>
              <span className={COMPLETE_TICK} title="done" aria-label="done">
                ✓
              </span>
```

(`cn` is already imported.)

- [ ] **Step 4: Convert the inbox done rows**

In `src/components/inbox/inbox-view.tsx`, add to the imports:

```ts
import { COMPLETE_TEXT } from "@/lib/completion-style";
```

Change the archived/done row title (line ~1179):

```tsx
                              <span className={COMPLETE_TEXT}>{item.text}</span> {pencil(item)}
```

Change the reopen-picker "stays done" preview (line ~1312) — `cn` is already imported here:

```tsx
              <span className={cn(!checked.has(s.id) && `${COMPLETE_TEXT} opacity-70`)}>
```

- [ ] **Step 5: Convert the Library `ProgressPill`**

In `src/app/(app)/library/page.tsx`, add to the imports:

```ts
import { COMPLETE_TICK } from "@/lib/completion-style";
```

Rewrite `ProgressPill` (lines ~231-237) so the pill's ✓ glyph + border follow `--tick-color` (`cn` is already imported). Swap the ✅ emoji (fixed green) for a ✓ glyph that inherits the tick colour:

```tsx
    <span
      className={cn(
        "shrink-0 rounded-full border border-[color:var(--tick-color)] px-2 py-0.5 text-xs",
        COMPLETE_TICK,
      )}
    >
      {item.stepsTotal > 0
        ? `✓ ${item.stepsDone}/${item.stepsTotal} ${t("progress.done", voice)}`
        : `✓ ${t("progress.done", voice)}`}
    </span>
```

- [ ] **Step 6: Run the tests + typecheck**

Run: `npm test -- src/components/breakdown/task-steps.test.tsx`
Expected: PASS (done step now uses the shared classes).
Run: `npx tsc --noEmit`
Expected: clean.

> **Testing note (documented decision):** the "done step" assertion above is the unit-level proof that a render site honours the shared treatment. The inbox done row and Library `ProgressPill` swaps are mechanical (identical class substitution) — covered by `tsc` + the manual light/dark sweep in Task 7 (their host files are large integrated components not worth isolating for a class-name assertion). The end-to-end colour resolution (CSS custom properties → rendered colour) is a visual check, since jsdom does not compute custom-property cascades.

- [ ] **Step 7: Commit**

```bash
git add src/components/breakdown/task-steps.tsx src/components/breakdown/task-steps.test.tsx src/components/inbox/inbox-view.tsx "src/app/(app)/library/page.tsx"
git commit -m "feat(#8): point completion render sites at the shared app-wide treatment

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Appearance settings section (auto-save) + strings + mount

The user-facing group: theme + the two completion controls, auto-saving each change, with a live preview that uses the exact shared treatment.

**Files:**
- Create: `src/components/settings/appearance-section.tsx`
- Create: `src/components/settings/appearance-section.test.tsx`
- Modify: `src/lib/strings.ts`
- Modify: `src/app/(app)/settings/page.tsx`
- Modify: `src/components/settings/settings-panel.tsx`

**Interfaces:**
- Consumes: `updateAppearanceSettings` (Task 2), `CompleteTickColor` (Task 1), `completionRootAttrs`/`COMPLETE_TICK`/`COMPLETE_TEXT` (Task 3), `useSaveStatus`/`SaveIndicator`, `ThemeToggle`, `t`/`Voice`, `cn`.
- Produces: `function AppearanceSection({ completeStrikethrough, completeTickColor, voice }): JSX.Element`.

- [ ] **Step 1: Add the strings**

In `src/lib/strings.ts`, at the end of the `STRINGS` object (after the notifications block), add:

```ts
  // ── MR ③ — Appearance (theme + app-wide completion style) ──────────────────
  // ✓ is a functional glyph (allowed in plain).
  "appearance.heading":         { plain: "Appearance",  playful: "🎨 Appearance" },
  "appearance.theme":           { plain: "Theme",       playful: "Theme" },
  "appearance.completionIntro": { plain: "How finished to-dos and steps look across the app.", playful: "How your checked-off bites look across the app." },
  "appearance.strike":          { plain: "Strike through completed", playful: "Strike through completed" },
  "appearance.tick":            { plain: "Tick colour",  playful: "Tick colour" },
  "appearance.tickGreen":       { plain: "Green",        playful: "Green" },
  "appearance.tickBlack":       { plain: "Black",        playful: "Black" },
  "appearance.previewText":     { plain: "Done to-do",   playful: "Done to-do" },
```

- [ ] **Step 2: Write the failing RTL test**

Create `src/components/settings/appearance-section.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppearanceSection } from "@/components/settings/appearance-section";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock("@/app/actions/settings", () => ({
  updateAppearanceSettings: vi.fn().mockResolvedValue(undefined),
}));
import { updateAppearanceSettings } from "@/app/actions/settings";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const base = { completeStrikethrough: true, completeTickColor: "green", voice: "plain" as const };

describe("AppearanceSection", () => {
  it("seeds the strike toggle + tick-colour radios from props", () => {
    render(<AppearanceSection {...base} />);
    expect(screen.getByLabelText(/strike through completed/i)).toBeChecked();
    expect(screen.getByLabelText("Green")).toBeChecked();
    expect(screen.getByLabelText("Black")).not.toBeChecked();
  });

  it("turning strike off auto-saves the full pref set", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    await user.click(screen.getByLabelText(/strike through completed/i));
    await waitFor(() =>
      expect(updateAppearanceSettings).toHaveBeenCalledWith({
        completeStrikethrough: false,
        completeTickColor: "green",
      }),
    );
  });

  it("choosing Black auto-saves + repaints the live preview via root data attrs", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    await user.click(screen.getByLabelText("Black"));
    await waitFor(() =>
      expect(updateAppearanceSettings).toHaveBeenCalledWith({
        completeStrikethrough: true,
        completeTickColor: "black",
      }),
    );
    expect(screen.getByTestId("completion-preview")).toHaveAttribute("data-tick", "black");
  });

  it("the preview reflects strike off before the server round-trip", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection {...base} />);
    await user.click(screen.getByLabelText(/strike through completed/i));
    expect(screen.getByTestId("completion-preview")).toHaveAttribute("data-complete-strike", "off");
  });

  it("the preview ✓ carries a text accessible name (status not colour-only)", () => {
    render(<AppearanceSection {...base} />);
    expect(screen.getByLabelText("done")).toHaveTextContent("✓");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- src/components/settings/appearance-section.test.tsx`
Expected: FAIL — cannot find module `@/components/settings/appearance-section`.

- [ ] **Step 4: Implement the section**

Create `src/components/settings/appearance-section.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateAppearanceSettings } from "@/app/actions/settings";
import { CompleteTickColor } from "@/lib/constants";
import {
  completionRootAttrs,
  COMPLETE_TICK,
  COMPLETE_TEXT,
} from "@/lib/completion-style";
import { ThemeToggle } from "@/components/theme-toggle";
import { t, type Voice } from "@/lib/strings";
import { useSaveStatus, SaveIndicator } from "@/components/settings/use-save-status";
import { cn } from "@/lib/utils";

type AppearancePrefs = {
  completeStrikethrough: boolean;
  completeTickColor: string;
};

/**
 * MR ③ — the Appearance group (Design C). Theme (light/dark) + the app-wide
 * completion style (Design D). Auto-saves each change (same pattern as
 * NotificationsSection). The completion controls carry a LIVE preview whose ✓ +
 * strike resolve from the same CSS custom properties the whole app uses, scoped
 * to the pending choice via completionRootAttrs — so the preview updates
 * instantly, before the server round-trip re-paints the shell.
 */
export function AppearanceSection({
  completeStrikethrough,
  completeTickColor,
  voice,
}: AppearancePrefs & { voice: Voice }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { status, markSaving, markSaved, markError } = useSaveStatus();
  const [prefs, setPrefs] = useState<AppearancePrefs>({
    completeStrikethrough,
    completeTickColor,
  });

  const persist = (next: AppearancePrefs) => {
    setPrefs(next); // optimistic: the live preview reflects the pending choice
    startTransition(async () => {
      markSaving();
      try {
        await updateAppearanceSettings(next);
        markSaved();
        router.refresh();
      } catch {
        markError();
      }
    });
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">{t("appearance.heading", voice)}</h2>
        <SaveIndicator status={status} voice={voice} />
      </div>

      {/* Theme (moved here so Appearance is a single group). */}
      <div className="space-y-1">
        <span className="text-muted-foreground text-xs">{t("appearance.theme", voice)}</span>
        <div>
          <ThemeToggle />
        </div>
      </div>

      {/* App-wide completion style (Design D). */}
      <p className="text-muted-foreground text-sm">{t("appearance.completionIntro", voice)}</p>

      <label className="flex items-center gap-2 font-medium">
        <input
          type="checkbox"
          checked={prefs.completeStrikethrough}
          onChange={(e) => persist({ ...prefs, completeStrikethrough: e.target.checked })}
        />
        {t("appearance.strike", voice)}
      </label>

      <fieldset className="space-y-1">
        <legend className="text-muted-foreground text-xs">{t("appearance.tick", voice)}</legend>
        {(Object.values(CompleteTickColor) as string[]).map((c) => (
          <label key={c} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="complete-tick-color"
              checked={prefs.completeTickColor === c}
              onChange={() => persist({ ...prefs, completeTickColor: c })}
            />
            {t(c === CompleteTickColor.Black ? "appearance.tickBlack" : "appearance.tickGreen", voice)}
          </label>
        ))}
      </fieldset>

      {/* Live preview — the exact shared classes, scoped to the pending choice
          via the root data attributes. Status is glyph + text, never colour
          alone. */}
      <div
        {...completionRootAttrs(prefs)}
        data-testid="completion-preview"
        className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
      >
        <span className={cn("flex-1", COMPLETE_TEXT)}>{t("appearance.previewText", voice)}</span>
        <span className={COMPLETE_TICK} aria-label="done" title="done">✓</span>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- src/components/settings/appearance-section.test.tsx`
Expected: PASS (all five cases).

- [ ] **Step 6: Mount the section + remove the duplicate Appearance block**

In `src/app/(app)/settings/page.tsx`, add the import:

```tsx
import { AppearanceSection } from "@/components/settings/appearance-section";
```

and mount it right after the `<SettingsPanel … />` element (before the Notifications block):

```tsx
      <div className="border-t pt-4">
        <AppearanceSection
          completeStrikethrough={settings.completeStrikethrough}
          completeTickColor={settings.completeTickColor}
          voice={voice}
        />
      </div>
```

In `src/components/settings/settings-panel.tsx`, delete the now-duplicate inline Appearance section (lines ~250-253):

```tsx
      <section className="space-y-2 border-t pt-4">
        <h2 className="font-semibold">Appearance</h2>
        <ThemeToggle />
      </section>
```

and remove the now-unused import (line ~12): `import { ThemeToggle } from "@/components/theme-toggle";`.

- [ ] **Step 7: Typecheck + gates for the touched suites**

Run: `npx tsc --noEmit`
Expected: clean (no unused `ThemeToggle`; `settings.completeStrikethrough`/`completeTickColor` exist on the Prisma row).
Run: `npm test -- src/components/settings/settings-panel.test.tsx src/components/settings/appearance-section.test.tsx`
Expected: PASS (settings-panel test has no Appearance/theme assertions, so removing that block is safe).

- [ ] **Step 8: Commit**

```bash
git add src/lib/strings.ts src/components/settings/appearance-section.tsx src/components/settings/appearance-section.test.tsx "src/app/(app)/settings/page.tsx" src/components/settings/settings-panel.tsx
git commit -m "feat(#8): Appearance settings group (theme + auto-save completion style) for MR ③

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: a11y sweep, full gates, E2E check, refresh the MR

**Files:**
- Modify: any Playwright spec that references completion styling / the settings Appearance block (see Step 2 — likely none).

**Interfaces:** none.

- [ ] **Step 1: a11y sweep (both themes)**

- **Status not colour-only:** confirm every converted site keeps the ✓ glyph + its "done" accessible name (`task-steps` done ✓, the Library `ProgressPill` ✓, the Appearance preview ✓); `completeTickColor` only recolours the glyph, never removes it. The done text keeps the ✓ beside it.
- **WCAG-AA (light + dark):** eyeball the ✓ / pill in the running app under both `green` (light `~green-700`, dark `~green-400`) and `black` (`--foreground`, i.e. near-black light / near-white dark) against card + border backgrounds; adjust the OKLCH green shade if any pair fails AA. Record the check.
- **Reduced motion:** N/A — this MR adds no animation/transition (only a static line-through + glyph colour). The existing global `prefers-reduced-motion` block is untouched.

- [ ] **Step 2: E2E selectors**

Run: `grep -rEl "line-through|completeTick|Appearance|Strike through|data-tick" e2e tests 2>/dev/null; ls playwright.config.* 2>/dev/null`
Expected: no completion-style / Appearance references (and, per MR ①'s finding, likely no Playwright infra in-tree). If a settings or done-state spec exists, update its selectors to the new Appearance controls (`checkbox name:/strike through completed/`, `radio name:/green|black/`) and the `✓`-based done treatment, then re-run `npm run test:e2e`. Record the finding in the MR description.

- [ ] **Step 3: Full gates**

Run: `npx prisma generate && npx prisma migrate deploy` (worktree Postgres — ensures the sync integration test has the constraint)
Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: `tsc` clean · lint 0 new errors · all vitest green — including `completion-style.test.ts`, `settings.appearance.test.ts`, `appearance-section.test.tsx`, the updated `task-steps.test.tsx`, and `enum-constraint-sync.integration.test.ts` (now covering `Settings_completeTickColor_check`).
Run: `npx next build`
Expected: compiles; `/settings` renders the Appearance group and the shell carries `data-complete-strike` / `data-tick`.

- [ ] **Step 4: Manual verification (use the `run` / `verify` project skill)**

- `/settings` → the single **Appearance** group shows the theme toggle, the "Strike through completed" checkbox, the Green/Black tick radios, and a live preview; each change shows "Saved ✓".
- Toggle strike off → the preview's text loses its line-through immediately; a done step on `/tasks/[id]` and a done inbox row also lose it after refresh.
- Switch tick to Black → the preview ✓, task-steps done ✓, and the Library Done-view pill all render in the foreground colour (monochrome) instead of green; switch to Green → all return to green.
- Flip to dark mode → green stays legible (lighter shade), black becomes near-white; both readable.
- Toggle voice → the Appearance heading gains its 🎨 in playful; controls stay functional-glyph-only in plain.

- [ ] **Step 5: Push (do NOT merge)**

```bash
git push origin feat/focus-completion-mr3
```

Open/refresh the MR (milestone **v0.2.0**), add **@GitLabDuo** as reviewer, and note in the description: MR ③ is Appearance/completion-style only (no timer/launcher); it **stacks on MR ②** (rebase build onto `feat/focus-timer-mr2` — migration ordering after ②'s, shared `settings/page.tsx`/`constants.ts`/`strings.ts`/sync-registry unioned). Request GitLabDuo re-review; wait for Duo + apply sensible suggestions before any merge (owner signs off).

---

## Self-Review (author checklist — completed)

**1. Spec coverage (Design C + Design D + a11y + Data model + Scope):**
- New `Settings.completeStrikethrough` (Bool, default true) + `completeTickColor` (String green|black, default green) → Task 1 (schema). ✅
- Migration + CHECK constraint for `completeTickColor` mirroring #38 → Task 1 (migration + `Settings_completeTickColor_check`). ✅
- `constants.ts` value set + enum-constraint-sync registry entry → Task 1 (`CompleteTickColor` + REGISTRY). ✅
- New **Appearance** settings-section, auto-save like the others → Task 6 (`AppearanceSection` + `useSaveStatus`/`SaveIndicator`), Task 2 (`updateAppearanceSettings`). ✅
- **App-wide implementation** via root class / CSS custom properties set in `layout.tsx` from the two settings → Task 3 (`completionRootAttrs`), Task 4 (globals.css vars + layout spread). ✅
- Audit + update completion render sites to read the shared treatment (✓ colour + line-through) → Task 5 (task-steps, inbox done rows, Library `ProgressPill`), with focus-timer done screen + `CompleteButton` explicitly audited as no-change. ✅
- a11y: status glyph+text never colour-only; green & black both WCAG-AA in light + dark → Global Constraints + Task 4 (OKLCH light/dark + `black`=`--foreground`) + Task 7 (sweep). ✅
- **Scope:** timer + launcher EXCLUDED — no `focus-timer.tsx` behaviour change, no launcher files, no `focusTimerStyle`/`focusSound`/audio/wake-lock. ✅

**2. Stacking on ② handled:** migration ordering (re-stamp after ②'s), shared `constants.ts` / `strings.ts` / `schema.prisma` (union additions), shared sync-test REGISTRY (keep all entries), shared `settings/page.tsx` (both section mounts), and the ③-only `settings-panel.tsx` Appearance-block removal — all called out in Global Constraints → "Stacking on MR ②". Plan DOC branches off main (which already carries #38 + #36). ✅

**3. Placeholder scan:** No "TBD"/"similar to Task N"/"add validation"/"handle edge cases". Every code step carries real code; every test step carries real assertions; every run step carries an exact command + expected output. ✅

**4. Type consistency:**
- `CompleteTickColor` (Task 1) is consumed by `updateAppearanceSettings` (Task 2 allowlist), the sync REGISTRY (Task 1), and `AppearanceSection` radios (Task 6). ✅
- `completionRootAttrs(settings: { completeStrikethrough: boolean; completeTickColor: string })` (Task 3) is fed the whole Prisma `Settings` row in the layout (structural subset — Task 4) and the local `prefs` in the section preview (Task 6). ✅
- `COMPLETE_TICK` / `COMPLETE_TEXT` (Task 3) consumed by task-steps, inbox, Library (Task 5) and the section preview (Task 6); asserted in `completion-style.test.ts` + `task-steps.test.tsx`. ✅
- `updateAppearanceSettings({ completeStrikethrough, completeTickColor })` (Task 2) is exactly what `AppearanceSection.persist` calls (Task 6) and what the action test asserts (Task 2). ✅
- `getSettings` returns the two new columns after `prisma generate` (Task 1); the settings page passes them to `AppearanceSection` (Task 6) and the layout reads them (Task 4). ✅

**Known deviations (documented, spec-faithful):**
- **Single Appearance group:** the spec's Design C "Appearance group" collides with the pre-existing inline "Appearance" (theme toggle) in `settings-panel.tsx`. Resolved by moving `ThemeToggle` into the new `AppearanceSection` and deleting the inline block, so there is one Appearance group (theme + completion style) — matches the spec's intent and avoids two identical headings. (Task 6.)
- **`ProgressPill` glyph swap:** the Library Done-view pill used a fixed-green ✅ emoji; swapped to a ✓ glyph so it can inherit `--tick-color` (green→black actually changes the pill). Wording ("done") unchanged. (Task 5.)
- **`black` = `--foreground`:** "black" is interpreted as a monochrome/foreground tick (near-black in light, near-white in dark) rather than literal `#000`, so it stays WCAG-AA in dark mode — the only sensible reading of "black … WCAG-AA in light + dark". (Task 4.)
- **Render-site test scope:** the "done step" carries the unit-tested shared classes (`task-steps.test.tsx`); the inbox/Library swaps are identical class substitutions verified by `tsc` + the manual light/dark sweep, since custom-property colour resolution isn't computed in jsdom. (Task 5 note.)
- **Focus done screen untouched:** audited as a celebration/confirmation surface (no status-list ✓, no strikethrough), so it is deliberately excluded from the treatment. (File Structure "Audited, NO change".)
