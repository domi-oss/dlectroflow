# Visual Identity Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace dlectroflow's default zero-chroma shadcn/base-nova grayscale with a warm-and-encouraging identity derived from the app icon (purple→pink magenta on near-black), applied via one token layer plus bespoke polish on the hero surfaces, with a Figtree default typeface and an accessibility typeface picker.

**Architecture:** All color/type/radius lives in CSS custom properties in `src/app/globals.css`, consumed through Tailwind 4's `@theme inline` map — so rewriting that one file re-skins all ~40 components at once. Fonts are wired with `next/font` in `src/app/layout.tsx`; a user-selectable typeface is applied at the app shell via a `data-font` attribute (mirroring the existing `completionRootAttrs` pattern) that keys `--font-sans`/`--font-heading` in `globals.css`. Hero surfaces then get hand-tuned against the real new tokens.

**Tech Stack:** Next 16.2.10 (App Router, RSC), React 19, Tailwind 4 (`@theme inline`), `next/font` (google + local), Prisma (SQLite; enum-like columns are `String` + CHECK constraint), vitest + @testing-library/react, Playwright + @axe-core/playwright.

## Global Constraints

- **WCAG-AA is a hard gate:** 4.5:1 for normal text, 3:1 for ≥18.6px-bold text and non-text (borders/icons/focus ring). Verified with axe in **both** light and dark.
- **Two magentas:** `--primary` = `#bd2e82` (white-on-magenta, 5.42:1). Vibrant `#e0479e` = `--color-brand-magenta`, for **non-text only** (dots, gradient, fills). Primary-CTA labels are **≥18.6px bold**.
- **Neon signature** (purple→pink gradient on near-black) is reserved for hero moments only (focus timer, celebration, launcher, empty states, dark mode) — never general chrome.
- **Do not repaint semantic meaning:** completion tick stays green (existing AA `green-700`/`green-400`, configurable), aging tier stays warm amber, destructive stays red. Brand hues map onto existing states; invent no new states.
- **Reduced motion:** `prefers-reduced-motion` is already honored app-wide; any new animation must respect it (no always-on motion).
- **Node ≥ 20.19.0** (`engines.node`).
- **Non-standard Next.js 16:** read `node_modules/next/dist/docs/` before writing any font/config code; heed deprecation notices (per `AGENTS.md`).
- **Fonts (all OFL/free):** Figtree + Atkinson Hyperlegible via `next/font/google`; OpenDyslexic self-hosted via `next/font/local`; "System" = native stack.
- **SQLite enum pattern:** new enum-like columns are `String @default(...)` with a `Settings_<col>_check` CHECK constraint + a mirror constant in `src/lib/constants.ts` (follow `completeTickColor` / `focusTimerStyle`).
- **Commits:** conventional commits; end each message with the repo's Co-Authored-By trailer.

---

## Phase 0 — Token + font foundation

*Lands the whole new look in one pass. Token values below are the **approved anchor hexes** (valid CSS custom-property values); Phase 1 converts them to OKLCH and tunes for AA.*

### Task 0.1: Wire the four typefaces in the root layout

**Files:**
- Modify: `src/app/layout.tsx`
- Create: `src/fonts/opendyslexic/` (self-hosted woff2) + `src/fonts/opendyslexic.ts`
- Test: `src/app/layout.test.tsx`

**Interfaces:**
- Produces: CSS variables on `<html>`: `--font-figtree`, `--font-atkinson`, `--font-opendyslexic` (and existing `--font-geist-mono`). Consumed by `globals.css` `data-font` rules (Task 0.2) and `@theme` (Task 0.3).

- [ ] **Step 1: Acquire the OpenDyslexic woff2 files.** Add a source for the OFL webfont, e.g. `npm i -D @fontsource/opendyslexic` (regenerate the lockfile in the CI image per repo convention), then copy `node_modules/@fontsource/opendyslexic/files/opendyslexic-latin-400-normal.woff2` and `-700-normal.woff2` into `src/fonts/opendyslexic/`. Confirm the package ships the SIL OFL `LICENSE`.

- [ ] **Step 2: Write the failing test** (`src/app/layout.test.tsx`):

```tsx
import { render } from "@testing-library/react";
import RootLayout from "./layout";

test("root <html> carries every typeface CSS variable", () => {
  const { container } = render(
    <RootLayout>
      <div>child</div>
    </RootLayout>,
  );
  const html = container.querySelector("html")!;
  // next/font sets `--font-*` via a className that also exposes the variable name.
  expect(html.className).toMatch(/--font-figtree|__variable/);
});
```

- [ ] **Step 3: Run it, expect FAIL.** `npm test -- layout.test` → fails (variables not wired yet).

- [ ] **Step 4: Implement.** In `src/app/layout.tsx`, add the fonts and expose their variables on `<html>` (keep Geist Mono for `--font-geist-mono`):

```tsx
import { Figtree, Atkinson_Hyperlegible, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";

const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
  weight: ["400", "500", "700", "800"],
});
const atkinson = Atkinson_Hyperlegible({
  variable: "--font-atkinson",
  subsets: ["latin"],
  weight: ["400", "700"],
});
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const openDyslexic = localFont({
  variable: "--font-opendyslexic",
  src: [
    { path: "../fonts/opendyslexic/opendyslexic-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/opendyslexic/opendyslexic-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
});
```

Then set the class on `<html>`:

```tsx
className={`${figtree.variable} ${atkinson.variable} ${openDyslexic.variable} ${geistMono.variable} h-full antialiased`}
```

- [ ] **Step 5: Run it, expect PASS.** `npm test -- layout.test`.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(ui): wire Figtree + Atkinson + OpenDyslexic via next/font"`

### Task 0.2: Rewrite color/radius tokens + brand primitives in globals.css

**Files:**
- Modify: `src/app/globals.css` (`@theme inline`, `:root`, `.dark`)

**Interfaces:**
- Produces: the full semantic token set consumed by every component; new `@theme` tokens `--color-brand-purple`, `--color-brand-magenta`, `--color-brand-pink`, `--gradient-brand`, `--shadow-glow`, `--shadow-glow-dark`; `--font-sans`/`--font-heading` default to Figtree.

- [ ] **Step 1: Point the font tokens at Figtree.** In the `@theme inline` block, set:

```css
--font-sans: var(--font-figtree);
--font-heading: var(--font-figtree);
/* --font-mono stays var(--font-geist-mono) */
```

- [ ] **Step 2: Add brand primitives** to `@theme inline`:

```css
--color-brand-purple: #9b5cf0;
--color-brand-magenta: #e0479e; /* non-text fills only */
--color-brand-pink: #f45fb0;
--gradient-brand: linear-gradient(100deg, #9b5cf0, #e0479e);
--shadow-glow: 0 8px 22px -8px rgba(224, 71, 158, 0.55);
--shadow-glow-dark: 0 0 34px -4px rgba(224, 71, 158, 0.6);
```

- [ ] **Step 3: Rewrite `:root` (light — warm daily / vivid magenta).** Replace the grayscale values:

```css
--background: #fdf6fa;
--foreground: #241a2b;
--card: #ffffff;
--card-foreground: #241a2b;
--popover: #ffffff;
--popover-foreground: #241a2b;
--primary: #bd2e82;            /* AA text magenta, 5.42:1 */
--primary-foreground: #ffffff;
--secondary: #f3ecfb;
--secondary-foreground: #4a2f6b;
--muted: #f6eef3;
--muted-foreground: #6f6475;   /* darkened from mockup #8a7a88 for AA on --card */
--accent: #fbe9f3;
--accent-foreground: #8a1f5e;
--destructive: #c0392b;        /* warm red, keep semantic */
--border: #f2dfeb;
--input: #f2dfeb;
--ring: #bd2e82;
--radius: 0.85rem;             /* friendlier, up from 0.625rem */
/* chart-1..5: derive from brand — magenta, purple, pink, amber, teal */
--chart-1: #e0479e;
--chart-2: #9b5cf0;
--chart-3: #f45fb0;
--chart-4: #f0a63d;
--chart-5: #4bb3b3;
```

- [ ] **Step 4: Rewrite `.dark` (full neon environment):**

```css
--background: #0c0a14;
--foreground: #e7dced;
--card: #171223;
--card-foreground: #e7dced;
--popover: #171223;
--popover-foreground: #e7dced;
--primary: #f45fb0;            /* brighter pink for dark bg */
--primary-foreground: #1a0f18;
--secondary: #241a33;
--secondary-foreground: #e7dced;
--muted: #211a2e;
--muted-foreground: #b9acc4;
--accent: #2a1b3d;
--accent-foreground: #f4d9ea;
--destructive: #e06052;
--border: oklch(1 0 0 / 12%);
--input: oklch(1 0 0 / 15%);
--ring: #c39bff;
```

- [ ] **Step 5: Verify the app builds + renders re-skinned.** `npm run dev`, open `/inbox` in light and dark (toggle). Expected: warm magenta light theme, near-black neon dark theme; no unstyled/black-on-black regions. (Visual gate — no unit test for raw token values.)

- [ ] **Step 6: Commit.** `git add src/app/globals.css && git commit -m "feat(ui): warm-magenta + neon token system (light + dark)"`

### Task 0.3: Gradient/glow utility + primary-CTA label sizing

**Files:**
- Modify: `src/app/globals.css` (a small `@layer components` block)
- Modify: `src/components/ui/button.tsx` (add a `brand` gradient variant + ensure lg size ≥18.6px bold)

**Interfaces:**
- Consumes: `--gradient-brand`, `--shadow-glow` (Task 0.2).
- Produces: a `.btn-brand` / button `variant="brand"` used by hero CTAs in Phase 3.

- [ ] **Step 1: Read the current button variants.** `src/components/ui/button.tsx` uses `class-variance-authority`; note the existing `variant`/`size` maps.

- [ ] **Step 2: Add the brand variant.** In the `cva` config add:

```ts
// variants.variant:
brand:
  "text-white [background-image:var(--gradient-brand)] shadow-[var(--shadow-glow)] " +
  "text-base font-bold hover:brightness-105 focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
```

Ensure the label lands ≥18.6px bold (Tailwind `text-base` = 16px is < threshold; use `text-lg` **or** rely on the darker `#bd2e82` path — for the gradient CTA use `text-lg font-bold` so 3:1 applies). Adjust the size map if needed.

- [ ] **Step 3: Write a test** (`src/components/ui/button.test.tsx`): renders `<Button variant="brand">Go</Button>`, asserts the element has the gradient background-image class and `font-bold`.

- [ ] **Step 4: Run → fail → implement → pass.** `npm test -- button.test`.

- [ ] **Step 5: Commit.** `git commit -am "feat(ui): brand gradient button variant"`

---

## Phase 1 — Accessibility tuning

### Task 1.1: Convert tokens to OKLCH (mechanical, no visual change)

**Files:** Modify `src/app/globals.css`.

- [ ] **Step 1:** Convert every hex added in Phase 0 to OKLCH (use `culori` REPL or a converter) so the file matches the repo's existing token format. Keep values numerically equivalent.
- [ ] **Step 2:** `npm run dev`, diff the rendered look against Phase 0 (should be identical). Commit: `style(ui): express brand tokens in OKLCH`.

### Task 1.2: Axe contrast gate in light + dark

**Files:**
- Create: `e2e/a11y-contrast.spec.ts`

**Interfaces:**
- Consumes: the running app (Playwright `webServer` from `playwright.config.ts`), `@axe-core/playwright`.

- [ ] **Step 1: Write the failing test** (`e2e/a11y-contrast.spec.ts`):

```ts
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const PAGES = ["/inbox", "/settings", "/focus"];

for (const path of PAGES) {
  for (const theme of ["light", "dark"] as const) {
    test(`no contrast violations: ${path} (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => {
        try { localStorage.setItem("df-theme", t); } catch {}
      }, theme);
      await page.goto(path);
      const results = await new AxeBuilder({ page })
        .withRules(["color-contrast"])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
```

- [ ] **Step 2: Run it.** `npm run test:e2e -- a11y-contrast`. Expected: any pair under threshold FAILS here (this is the gate).

- [ ] **Step 3: Fix each violation** by darkening/lightening the offending token (stay within the approved hue family; never put white text on `--color-brand-magenta`). Re-run until green.

- [ ] **Step 4: Commit.** `git commit -am "test(a11y): axe contrast gate (light+dark) + token fixes"`

---

## Phase 2 — Settings typeface picker

*Mirrors the `completeTickColor` appearance pref end-to-end: constant → schema String + CHECK → action upsert → `*RootAttrs` helper at the app shell → `globals.css` rule → picker UI.*

### Task 2.1: Typeface constant + font resolution helper

**Files:**
- Modify: `src/lib/constants.ts`
- Create: `src/lib/typeface.ts`
- Test: `src/lib/typeface.test.ts`

**Interfaces:**
- Produces: `Typeface` const (`figtree|atkinson|opendyslexic|system`); `typefaceRootAttrs(settings) → { "data-font": Typeface }` (mirrors `completionRootAttrs`).

- [ ] **Step 1: Add the constant** to `src/lib/constants.ts`:

```ts
export const Typeface = {
  Figtree: "figtree",
  Atkinson: "atkinson",
  OpenDyslexic: "opendyslexic",
  System: "system",
} as const;
export type Typeface = (typeof Typeface)[keyof typeof Typeface];
```

- [ ] **Step 2: Write the failing test** (`src/lib/typeface.test.ts`):

```ts
import { typefaceRootAttrs } from "./typeface";
import { Typeface } from "./constants";

test("maps a known typeface to the data-font attr", () => {
  expect(typefaceRootAttrs({ typeface: Typeface.OpenDyslexic }))
    .toEqual({ "data-font": "opendyslexic" });
});
test("unknown value degrades to figtree", () => {
  expect(typefaceRootAttrs({ typeface: "bogus" }))
    .toEqual({ "data-font": "figtree" });
});
```

- [ ] **Step 3: Run → fail.** `npm test -- typeface.test`.

- [ ] **Step 4: Implement** `src/lib/typeface.ts`:

```ts
import { Typeface } from "@/lib/constants";

const KNOWN = new Set<string>(Object.values(Typeface));

/** App-shell root attribute; globals.css keys --font-sans/--font-heading off it. */
export function typefaceRootAttrs(settings: { typeface: string }): {
  "data-font": Typeface;
} {
  const t = KNOWN.has(settings.typeface)
    ? (settings.typeface as Typeface)
    : Typeface.Figtree;
  return { "data-font": t };
}
```

- [ ] **Step 5: Run → pass. Commit.** `git commit -am "feat(settings): typeface constant + data-font helper"`

### Task 2.2: Persist the typeface preference

**Files:**
- Modify: `prisma/schema.prisma` (Settings model) + new migration
- Modify: `src/app/actions/settings.ts` (`updateAppearanceSettings`)
- Modify: `src/lib/db.ts` if `getSettings` hand-picks fields (confirm it returns `typeface`)

- [ ] **Step 1: Add the column** to `model Settings` (near the MR③ completion fields):

```prisma
// #40 — user-selected UI typeface (a11y). Mirrors Typeface in src/lib/constants.ts.
typeface String @default("figtree")
```

- [ ] **Step 2: Create the migration + CHECK constraint.** `npm run db:migrate -- --name add_typeface_pref`, then in the generated SQL add (mirroring the `Settings_focusSound_check` precedent):

```sql
ALTER TABLE "Settings" ADD CONSTRAINT "Settings_typeface_check"
  CHECK ("typeface" IN ('figtree','atkinson','opendyslexic','system'));
```

(If SQLite/Prisma requires table-rebuild for CHECK, follow the existing constraint migrations' pattern in `prisma/migrations/`.)

- [ ] **Step 3: Extend `updateAppearanceSettings`.** Add `typeface` to its input type and the upsert `create`/`update` payloads (validate against `Object.values(Typeface)`, default `figtree`). Follow the existing `completeTickColor` handling in the same function.

- [ ] **Step 4: Test** (`src/app/actions/settings.test.ts` or existing): call `updateAppearanceSettings` with `typeface: "opendyslexic"`, assert the row persists it; with a bogus value, assert it falls back to `figtree`. Run → fail → implement → pass.

- [ ] **Step 5: Commit.** `git commit -am "feat(settings): persist typeface preference"`

### Task 2.3: Apply data-font at the app shell + globals.css rules

**Files:**
- Modify: `src/app/(app)/layout.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Apply the attr.** In `(app)/layout.tsx`, spread it onto the same shell wrapper that already carries `completionRootAttrs(settings)`:

```tsx
import { typefaceRootAttrs } from "@/lib/typeface";
// ...
<div
  className="flex min-h-full flex-col"
  {...completionRootAttrs(settings)}
  {...typefaceRootAttrs(settings)}
>
```

- [ ] **Step 2: Add the resolution rules** to `globals.css` (outside `@theme`, e.g. near the completion-style block):

```css
[data-font="atkinson"]     { --font-sans: var(--font-atkinson);     --font-heading: var(--font-atkinson); }
[data-font="opendyslexic"] { --font-sans: var(--font-opendyslexic); --font-heading: var(--font-opendyslexic); }
[data-font="system"]       { --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
                             --font-heading: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
/* figtree = the @theme default, no override needed */
```

- [ ] **Step 3: Verify.** `npm run dev` → Settings, switch typeface, confirm the whole app re-renders in each font (incl. OpenDyslexic self-hosted). Commit: `feat(settings): apply typeface at app shell`.

### Task 2.4: Typeface picker UI + live preview

**Files:**
- Modify: `src/components/settings/appearance-section.tsx`
- Modify: `src/lib/strings.ts` (new `appearance.typeface*` copy, both voices)
- Test: `src/components/settings/appearance-section.test.tsx`

- [ ] **Step 1: Write the failing test.** Extend `appearance-section.test.tsx`: render with `typeface="figtree"`, click the "OpenDyslexic" radio, assert `updateAppearanceSettings` is called with `typeface: "opendyslexic"` and the preview node carries `data-font="opendyslexic"`.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.** Add `typeface` to `AppearancePrefs`, a radio `fieldset` iterating `Object.values(Typeface)` (labels from `t("appearance.typefaceFigtree"…)`), persisting via the existing optimistic `persist()`. Add a live preview `<p {...typefaceRootAttrs(prefs)}>` sample sentence so the choice is visible immediately (same pattern as the completion preview). Note in copy that OpenDyslexic/Atkinson aid dyslexia/low-vision.

- [ ] **Step 4: Run → pass. Commit.** `git commit -am "feat(settings): typeface picker UI + live preview"`

---

## Phase 3 — Hero-surface polish

*Token swap already re-skinned these; here they earn the neon signature. Each task: read the current component, apply the treatment, keep behavior/tests green, verify with the app + axe. These are visual-polish tasks — the diff is authored against the live component, not pre-fabricated. Acceptance criteria are concrete.*

### Task 3.1: Focus timer — neon ring
**Files:** `src/components/focus/timer-visual.tsx`, `focus-timer.tsx`, `timer-style-preview.tsx`.
**Acceptance:** the running-timer visual uses `--gradient-brand` + `--shadow-glow-dark` glow on a near-black field (all four timer styles: ring/digits/bar/mug); reduced-motion disables the sweep animation; axe clean; existing focus-timer tests still pass. Commit per component.

### Task 3.2: Completion celebration
**Files:** `src/components/focus/celebration.tsx`, `src/components/completion/done-pill.tsx`.
**Acceptance:** completion moment uses the gradient as a brief dopamine burst, honoring `usePrefersReducedMotion` (no motion when reduced); the green semantic tick is unchanged; existing celebration tests pass.

### Task 3.3: Focus launcher CTA
**Files:** `src/components/focus/focus-launcher.tsx`.
**Acceptance:** primary "start focus" CTA uses `Button variant="brand"` (gradient, ≥18.6px bold label); keyboard focus ring visible; tests pass.

### Task 3.4: Inbox treatment + logo (folds in #13)
**Files:** `src/components/inbox/*` (`inbox-view`, `status-pill`, `sub-header`, `welcome-card`), `src/app/(app)/layout.tsx` (header).
**Acceptance:** section labels carry brand color; aging tier reads as warm amber; the app-icon logo appears in the header/nav; status is never color-only (keep text/glyph); axe clean; inbox tests pass.

### Task 3.5: Welcome / empty states
**Files:** `src/components/inbox/welcome-card.tsx`, `src/components/guest/*`.
**Acceptance:** first-run/empty states get a warm brand moment (subtle gradient accent + logo), encouraging copy; no overstimulation; tests pass.

### Task 3.6: Nav & theme toggle
**Files:** `src/components/nav/app-menu.tsx`, `nav/back-link.tsx`, `src/components/theme-toggle.tsx`.
**Acceptance:** nav uses brand accent + gradient avatar; theme toggle parity across light/dark; focus states visible; tests pass.

---

## Phase 4 — QA & sign-off

### Task 4.1: Full verification pass
- [ ] `npm test` (vitest) green.
- [ ] `npm run test:e2e` (Playwright incl. axe-contrast spec) green.
- [ ] `npm run lint` + `tsc` clean.
- [ ] Manual `/run` visual pass: Inbox, Focus (all 4 timer styles), Celebration, Launcher, Settings, Welcome/empty — in **light + dark** and across **all four typefaces** (spot-check OpenDyslexic).
- [ ] Confirm reduced-motion (`prefers-reduced-motion`) disables new animation.
- [ ] Update `#40` task checkboxes; open MR with `@GitLabDuo` as reviewer + milestone v0.3.0.

---

## Self-Review

- **Spec coverage:** §3 tokens → Task 0.2/1.1; §3.3 primitives → 0.2; §4 a11y → 1.1/1.2 + 0.3 (label sizing); §5.1 Figtree → 0.1/0.2; §5.2 picker → Phase 2; §6 hero surfaces → Phase 3 (all six mapped); §3.4 semantics preserved → constraints + 3.2/3.4 acceptance; §7 rollout → phase order; §8 testing → 1.2/4.1. Logo placement (#13) → 3.4/3.5. ✅ No gaps.
- **Placeholder scan:** Phase 0–2 carry complete code; Phase 3 tasks are deliberately treatment-level (visual polish authored against live components) with concrete acceptance criteria — flagged as such, not vague TODOs.
- **Type consistency:** `Typeface` values (`figtree/atkinson/opendyslexic/system`) are identical across constant, CHECK constraint, `typefaceRootAttrs`, globals.css rules, and the picker. `typefaceRootAttrs` mirrors `completionRootAttrs`'s shape.
