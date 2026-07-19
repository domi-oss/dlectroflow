# Phase 8 — Accessibility pass

_#8 Phase 8. Milestone v0.1.0. Branch `feat/a11y-pass`. One MR. No schema._

A focused, cross-app accessibility pass. Four bounded items (per #8) plus the
minimum tests to lock them. Do **not** turn this into an open-ended refactor —
fix these four categories, verify, ship.

## 1. `prefers-reduced-motion`

Honor the OS "reduce motion" setting for non-essential animation — chiefly the
focus-completion **confetti/celebration** (`src/components/focus/celebration.tsx`)
and any `motion`/framer transitions that move or scale prominently. When
`prefers-reduced-motion: reduce` is set, skip or reduce the animation to a static
/ instant state (the reward still shows — just without the motion). Prefer a CSS
media query where the animation is CSS; for JS-driven `motion`, read the media
query (a small `usePrefersReducedMotion` hook, unit-testable) and pass a reduced
variant. Confetti should not render its particle burst under reduce.

## 2. Contrast — WCAG AA

Replace `#aaa` and other sub-AA low-contrast greys with tokens that meet **AA**
(4.5:1 for normal text, 3:1 for large text / UI) in **both** light and dark
themes. Grep for hardcoded `#aaa`/`#ccc`/low-opacity `text-muted` misuse. Prefer
existing Tailwind/theme tokens (`text-muted-foreground` etc.) that are already
AA-tuned; only introduce a new token if none fits. Verify against the actual
background it sits on in each theme.

## 3. Touch targets ≥ 44px

Interactive controls (buttons, toggles, icon-only buttons, links acting as
buttons, the row action affordances) must have a **≥44×44px** hit area. Add
padding / min-size utility classes where a control is currently smaller (common
offenders: icon buttons, the small pill buttons, close/dismiss ✕). Keep the
visual size if desired by expanding the hit area (padding / `::before`),
but the simplest correct fix (min-h/min-w + padding) is preferred.

## 4. Status never colour-only

Anywhere state is conveyed by colour alone, add a text label or icon so it's
perceivable without colour. Known surfaces: the freshness tiers
(Fresh/Aging/Overdue), status pills (`src/components/inbox/status-pill.tsx`),
the Scheduled ✓ / Not-scheduled indicator, any red/green success/error. Most
already carry text — audit and fill the gaps (e.g. a shape/icon or a word).

## Tests (TDD, what's meaningfully testable)

a11y is partly visual, so test the logic and the attribute/structure, and
manually verify the visual bits:
- `usePrefersReducedMotion` (or the pure reduced-motion decision): returns the
  media-query state; celebration/confetti respects it (component test with the
  media query mocked → asserts the burst is not rendered / animation prop is the
  reduced variant).
- Touch-target: component test asserting the min-size classes are present on the
  affected controls (or a focused snapshot of the class list).
- Status-not-colour-only: assert the freshness/status elements render a
  text/aria label, not just a colour class.
- Contrast: not unit-testable reliably — list the changed tokens/values in the
  MR description with the before/after ratio, and eyeball in both themes.

## Notes / out of scope

- Keep changes surgical and additive; don't restructure components.
- No new dependencies (no `jest-axe` unless it's already present).
- Gates: `tsc` clean · `eslint` 0 errors · `vitest` green · verify reduced-motion
  + contrast + targets by eye in the running app (light + dark).
