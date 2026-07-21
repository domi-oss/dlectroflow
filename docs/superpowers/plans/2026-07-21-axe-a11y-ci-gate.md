# Axe Accessibility CI Gate — Implementation Plan (issue #31)

> Mechanical WCAG (contrast, labels, roles, focus order) checked per-MR with
> `@axe-core/playwright`, built on top of the existing Playwright E2E smoke
> harness (MR !89). Runs as a **blocking** CI gate before `build_image`.

## Design choices

**Reuse the smoke harness, don't reinvent it.** The axe spec lives in `e2e/`
and inherits everything the smoke suite already established: the forged-owner
`storageState` (from `e2e/global-setup.ts`), the `webServer` boot (`next start`
with the prod boot-guard env in `playwright.config.ts`), serial execution
(`workers: 1`), and the shared capture/triage helpers in `e2e/helpers.ts`. No
new auth path, no new server boot, no application-source changes. In CI the axe
spec runs inside the **same `e2e_test` job** — it is just another `*.spec.ts`
under `testDir` — so `npx playwright test` already picks it up and it is already
wired into `build_image.needs` as a blocking gate. That is the lowest-risk way
to satisfy "a CI job runs axe against the core flow" without a second Postgres
service, a second image pull, or a second `next build`.

**Core-flow route coverage.** The acceptance criteria name the flow
inbox/capture → clarify → schedule → focus → reward. These map to real routes:
`/inbox` (capture), `/tasks/[taskId]` (the breakdown/clarify chat **and** the
`TaskSchedule` control live on the same task-detail page, so one scan covers
clarify + schedule), `/focus/[stepId]` (the focus timer) plus `/focus` (the
launcher), and `/dashboard` (rewards/streaks/badges). `/library` is added as a
core navigation hub. Static routes are scanned by a parametrized loop; the two
dynamic routes are reached by driving the real UI with the existing helpers —
`startBreakdown` creates the task server-side (no AI needed) and navigates to
`/tasks/[id]`; `ensureFocusStep` + "▶ Start Focus" reaches `/focus/[stepId]`
(both patterns already proven by the smoke specs).

**Baseline allowlist so the gate starts green, fails on NEW issues.** Each scan
runs `AxeBuilder` with the WCAG 2.0/2.1 A + AA tags and keeps only
serious/critical violations. Every such violation is fingerprinted as
`ruleId::targetSelector` and compared against a checked-in baseline
(`e2e/a11y/axe-baseline.json`, keyed by route). The gate fails only on
fingerprints **not** in the baseline — i.e. a new rule, or an existing rule on a
new element. The baseline is generated/refreshed by running the spec with
`A11Y_UPDATE_BASELINE=1` (documented in the helper + README). This makes the
first pipeline green while still catching regressions per-MR. We fail on
`serious`+`critical` only (not `moderate`/`minor`) — that is the conventional
axe blocking threshold and keeps the gate high-signal.

## Files

- `e2e/a11y/axe-core-flow.spec.ts` (new) — the spec: static-route loop + a
  dynamic-flow test (clarify/schedule/focus).
- `e2e/a11y/axe-helpers.ts` (new) — `AxeBuilder` wrapper, WCAG tags, fingerprint
  + baseline compare, `A11Y_UPDATE_BASELINE` refresh mode.
- `e2e/a11y/axe-baseline.json` (new) — checked-in baseline of pre-existing
  serious/critical violations (generated locally).
- `package.json` / `package-lock.json` (modify) — add `@axe-core/playwright`
  devDep; lockfile regenerated + verified in the `node:22-alpine` CI image.
- `README.md` (modify) — document the a11y gate + baseline-refresh command.
- `.gitlab-ci.yml` (modify) — a one-line comment noting the axe spec rides the
  existing `e2e_test` job (no new job needed; already blocking via
  `build_image.needs`).

## Gates before push

`npx tsc --noEmit`, `npm run lint`, `npx next build`, and the axe spec passing
locally against the `axe_a11y` schema.
