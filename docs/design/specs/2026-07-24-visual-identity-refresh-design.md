# dlectroflow — Visual Identity Refresh (design spec)

**Date:** 2026-07-24
**Status:** Draft for review
**Owner:** Domi (you@example.com)

## 1. Goal

Give dlectroflow a distinctive visual identity of its own, replacing the stock
shadcn/base-nova **zero-chroma grayscale** it ships today (every token is
`oklch(… 0 0)`). The identity is derived from the app icon and tuned for an
ADHD audience: **warm & encouraging in daily use, never overstimulating**, with
a vibrant **neon signature** reserved for moments that deserve a dopamine hit.

## 2. Locked decisions

| Decision | Choice |
|---|---|
| Scope | Full identity refresh |
| Personality | Warm & encouraging (ADHD-safe: supportive, not loud) |
| Brand source | The **app icon** — purple→pink/magenta gradient on near-black (lightning = momentum, refresh-ring = reset, "S" = flow). **No cyan.** (The `domi-oss-group-logo.png` hexagon is the GitLab *group* logo, not the app's — it does not drive the palette.) |
| Daily palette | **Vivid magenta** — saturated rose/magenta primary, brand-colored section headers, on warm off-white |
| Neon signature | Purple→pink gradient on near-black, reserved for hero moments (§6) |
| Typography | **Figtree** for headings + body (one warm humanist family) |
| A11y typeface picker | Figtree (default) / Atkinson Hyperlegible / OpenDyslexic / System — user-selectable in Settings (§5.2) |
| Rollout | One token-layer rewrite re-skins the whole app → bespoke polish on ~6 hero surfaces |
| Dark mode | Becomes the **full neon environment**; light mode is the warm daily default |

## 3. Color system

All values below are **anchor hexes** (from the approved mockups). Implementation
converts to OKLCH (the repo's token format) and **tunes each pair to WCAG-AA**
before landing — the hexes fix the intent, §4 fixes the contrast floor.

### 3.1 Light mode (warm daily · vivid magenta)

| Token | Value | Notes |
|---|---|---|
| `--background` | `#fdf6fa` | warm off-white, whisper of pink |
| `--foreground` | `#241a2b` | warm near-black (slight purple) |
| `--card` | `#ffffff` | rows/cards |
| `--card-foreground` | `#241a2b` | |
| `--primary` | `#bd2e82` (AA text token, 5.42:1) | white-on-magenta surfaces; vibrant `#e0479e` lives in `--color-brand-magenta` (§3.3) for non-text — see §4 |
| `--primary-foreground` | `#ffffff` | |
| `--secondary` | `#f3ecfb` | soft purple surface |
| `--secondary-foreground` | `#4a2f6b` | |
| `--accent` | `#fbe9f3` | soft pink surface |
| `--accent-foreground` | `#8a1f5e` | |
| `--muted` | `#f6eef3` | |
| `--muted-foreground` | `#8a7a88` | timestamps, meta (verify AA on `--card`) |
| `--border` | `#f2dfeb` | |
| `--input` | `#f2dfeb` | |
| `--ring` | `#e0479e` | focus ring (visible, AA non-text 3:1) |
| `--destructive` | keep warm red (`~oklch(0.58 0.22 25)`) | do **not** map to magenta |
| `--radius` | `0.85rem` (up from `0.625rem`) | rounder = friendlier |

### 3.2 Dark mode (full neon environment)

| Token | Value | Notes |
|---|---|---|
| `--background` | `#0c0a14` | near-black purple |
| `--foreground` | `#e7dced` | |
| `--card` | `#171223` | lifted surface |
| `--popover` | `#171223` | |
| `--primary` | `#f45fb0` | brighter pink for dark bg (AA on near-black) |
| `--primary-foreground` | `#1a0f18` | |
| `--secondary` | `#241a33` | |
| `--muted` | `#211a2e` | |
| `--muted-foreground` | `#b9acc4` | |
| `--border` | `oklch(1 0 0 / 12%)` | |
| `--ring` | `#c39bff` | |

### 3.3 Brand primitives (new `@theme` tokens)

```
--color-brand-purple:  #9b5cf0;
--color-brand-magenta: #e0479e;
--color-brand-pink:    #f45fb0;
--gradient-brand: linear-gradient(100deg, #9b5cf0, #e0479e);
--shadow-glow: 0 8px 22px -8px rgba(224,71,158,.7);   /* light CTAs */
--shadow-glow-dark: 0 0 34px -4px rgba(224,71,158,.6); /* dark hero */
```

`--gradient-brand` + the glow shadows are the **only** places the raw gradient
appears — everything else uses the semantic tokens above so the whole app
re-skins from one file.

### 3.4 Status / semantic colors — preserved, not overridden

The refresh restyles **brand chrome**, not **meaning**. Do not repaint semantic
state with brand color:

- **Completion** keeps its existing green tick (the repo's proven AA
  `green-700` / `dark:green-400` pairing, configurable black/green) — green =
  "done" is a universal signal; leave `--tick-color` logic alone.
- **Aging/freshness** semantics (`freshnessTier`, `isAging`) keep their existing
  meaning; the nudge tier gets a **warm amber** treatment (`#f0a63d` dot / warm
  surface) that reads as gentle-warning without clashing. Map brand hues onto
  the **existing** tiers; invent no new states.
- **Destructive** stays red.

## 4. Accessibility

- **WCAG-AA is a hard gate.** Every text/background pair must clear 4.5:1 (body)
  / 3:1 (≥18.6px bold, non-text). The one known risk: vibrant magenta `#e0479e`
  with white text = **3.77:1** (computed) — fails normal text, passes only large
  bold. **Fix = two magentas:** keep `#e0479e` as the *brand-fill* token for
  non-text (dots, gradient, accents), and use the AA *text* token
  **`--primary` = `#bd2e82` (5.42:1)** for white-on-magenta (buttons/badges).
  **Decision (belt-and-suspenders):** `#bd2e82` *and* primary-CTA labels sized
  **≥18.6px bold** — so text-on-magenta clears AA with headroom regardless of
  size, and CTAs get larger, clearer tap targets (an ADHD win). The gradient CTA
  nudges its pink stop to `#bd2e82` too. All verified with axe.
- **Reduced motion** is already respected app-wide (`prefers-reduced-motion` in
  `globals.css` + `usePrefersReducedMotion` for Motion). The neon glow/celebration
  work must honor it too (no new always-on animation).
- **Focus visibility:** `--ring` must be clearly visible on both themes.
- **Dyslexia/legibility typeface picker** — see §5.2.
- Existing `@axe-core/playwright` suite is extended to assert contrast on the new
  tokens in both light and dark.

## 5. Typography

### 5.1 Brand default — Figtree

- Load **Figtree** via `next/font/google` (weights 400/500/700/800), exposing a
  CSS variable; wire `--font-sans` **and** `--font-heading` to it (headings use
  800, body 400/500). Keep `--font-geist-mono` for mono.
- The `@theme inline` block already maps `--font-heading: var(--font-sans)` —
  point both at Figtree.

### 5.2 A11y typeface picker (Settings → Appearance)

A user-selectable typeface, applied via a `data-font` attribute on the app-shell
wrapper (same pattern as the existing completion-style `data-*` attributes set in
`(app)/layout.tsx`). CSS rules resolve `data-font` → `--font-sans`/`--font-heading`.

| Option | Source | Loading |
|---|---|---|
| **Figtree** (default) | Google Fonts, OFL | `next/font/google` |
| **Atkinson Hyperlegible** | Braille Institute, OFL | `next/font/google` |
| **OpenDyslexic** | SIL OFL | self-host woff2 via `next/font/local` (`public/fonts/` or `src/fonts/`) — not on Google Fonts |
| **System** | — | `ui-sans-serif, system-ui, …` (zero download) |

- Setting persists with the other appearance prefs (existing settings store /
  server action path — mirror `appearance-section.tsx`).
- Only the **body/UI** font swaps; the brand gradient/heading *weight* stays.
- Licenses (all free): Figtree OFL, Atkinson Hyperlegible OFL, OpenDyslexic SIL OFL.

## 6. Hero surfaces (bespoke polish after the token swap)

The token layer re-skins all ~40 components automatically. These ~6 surfaces get
hand-tuned so the identity actually *sings* (this is where the neon lives):

1. **Focus timer** — `focus/timer-visual`, `focus-timer`, `timer-style-preview`:
   neon gradient ring + glow on near-black; the icon's refresh-ring/lightning motif.
2. **Completion celebration** — `focus/celebration`, `completion/done-pill`:
   gradient burst / dopamine moment (reduced-motion safe).
3. **Focus launcher** — `focus/focus-launcher`: gradient CTA, momentum framing.
4. **Inbox** — `inbox/*` (rows, `status-pill`, `sub-header`, aging nudge):
   warm daily treatment, brand-colored section labels, amber aging tier.
5. **Welcome / empty states** — `inbox/welcome-card`, `guest/*`: warm, encouraging,
   a small brand moment for first-run.
6. **Nav & theme** — `nav/app-menu`, `nav/back-link`, `theme-toggle`: gradient
   avatar, brand accent, dark/light parity.

## 7. Rollout plan

- **Phase 0 — Token + font foundation.** Rewrite `globals.css` `:root` + `.dark`
  with §3 tokens; add brand primitives + gradient/glow; bump `--radius`; wire
  Figtree via `next/font`. *Instantly re-skins the whole app.* Est: ~2–3h.
- **Phase 1 — A11y tuning.** Convert to OKLCH, verify every pair AA (light +
  dark) with axe, darken label magenta (§4). Est: ~1–2h.
- **Phase 2 — Typeface picker.** Settings option + `data-font` wiring + font
  loading (incl. self-hosted OpenDyslexic). Tests. Est: ~2–3h.
- **Phase 3 — Hero-surface polish.** The ~6 surfaces in §6. Est: ~3–5h.
- **Phase 4 — QA.** Visual pass across all screens in both themes; run vitest +
  Playwright + axe; drive the app to confirm. Est: ~1–2h.

Total rough estimate: **~1.5–2 days** of focused work, shippable incrementally
(Phase 0 alone already transforms the app and can ship first).

## 8. Testing & verification

- Existing stack: **vitest** (unit/RTL), **Playwright** E2E (+ `@axe-core/playwright`).
- Extend axe assertions to the new tokens (contrast) in light + dark.
- Add a test for the typeface setting (persists + applies the right `data-font`).
- Manual/`/run` visual pass on Inbox, Focus, Celebration, Launcher, Settings,
  Welcome — both themes + each typeface option.
- No visual-regression harness exists today; out of scope to add one now (§9).

## 9. Out of scope (YAGNI)

- New component library / Storybook / design-system package extraction.
- Multi-theme system beyond light + dark (no user-tunable accent hues).
- Visual-regression snapshot infrastructure.
- Re-architecting components — this is a reskin + targeted polish, not a rewrite.
- Touching semantic status colors' *meaning* (§3.4).

## 10. Risks / notes

- **AGENTS.md warning:** this is a non-standard Next.js build — read
  `node_modules/next/dist/docs/` before writing font/config code.
- Magenta-label contrast (§4) is the one real color risk; caught by axe.
- OpenDyslexic must be self-hosted (not on Google Fonts) — verify woff2 licensing
  file ships with it.
- `next/font` + Tailwind 4 `@theme` variable wiring should be validated early
  (Phase 0) since it gates everything downstream.
