# Task 6 Report: Guests never call Claude outside breakdowns (spark / rollup / re-estimate)

## What was gated in each file

### `src/lib/constants.ts`
Added `isGuestWorkspace(workspaceId: string): boolean` — returns `true` when `workspaceId !== OWNER_WORKSPACE_ID`. Single source of truth for all downstream gates.

### `src/lib/spark.ts`
- Updated import to also bring in `isGuestWorkspace` from `@/lib/constants`.
- Added private `quoteFor(workspaceId)` helper: guests receive `{ quote: randomFallback(), source: SparkSource.Fallback }` without touching Claude; owner gets `generateQuote()`.
- Replaced both `await generateQuote()` calls (in `getTodaySpark` and `refreshTodaySpark`) with `await quoteFor(workspaceId)`.

### `src/lib/rollup.ts`
- Updated import to also bring in `isGuestWorkspace` from `@/lib/constants`.
- Modified `generateNarrative(d: DayData)` signature to `generateNarrative(d: DayData, workspaceId: string)`.
- Added `if (!isGuestWorkspace(workspaceId))` guard wrapping the existing `try { getAnthropic() ... } catch { ... }` block. When the guard is skipped (guest), execution falls through to the existing `return fallbackNarrative(d)`. Persisted shape unchanged.
- Updated the one call site in `generateTodayRollup` to pass `workspaceId`.

Note: The brief described gating in `generateTodayRollup`, but the actual Claude call lives in the private `generateNarrative` helper. The guard was placed there (with `workspaceId` threaded through) — semantics are identical to the brief's intent.

### `src/app/actions/focus.ts`
- Updated import to also bring in `isGuestWorkspace` from `@/lib/constants`.
- In `proposeNewEstimate`, after the `if (!step) return 15;` guard, added `if (isGuestWorkspace(workspaceId)) return step.estMinutes + 10;` — identical to the existing catch-all fallback at the bottom, ensuring no Claude call for guests.

## TDD evidence

Wrote `src/lib/ai-scope.test.ts` before any implementation (only Step 1 / `isGuestWorkspace` was already added per TDD-first flow):

```
Tests  2 passed (2)  — "owner id is not a guest" + "any other id is a guest"
```

## Full verification output

```
npm run test          → Test Files  11 passed (11) / Tests  51 passed (51)
npx tsc --noEmit      → (no output — zero errors)
npm run build         → ✓ Compiled successfully, all 12 pages generated
```

## Files changed

- `src/lib/constants.ts` — added `isGuestWorkspace`
- `src/lib/ai-scope.test.ts` — new TDD test file
- `src/lib/spark.ts` — guest-aware `quoteFor` helper, two call-site replacements
- `src/lib/rollup.ts` — guest guard in `generateNarrative`, updated signature + call site
- `src/app/actions/focus.ts` — early-return guest guard in `proposeNewEstimate`

## Self-review

- The `if (!isGuestWorkspace(workspaceId)) try { ... } catch { ... }` pattern in `rollup.ts` is syntactically valid TypeScript; the `if` covers the whole `try/catch` compound statement, and `return fallbackNarrative(d)` at the end is always reachable for guests.
- No changes to persisted data shapes.
- All three AI call sites outside breakdowns are now gated.

## Concerns

None. Each gate mirrors the existing catch-all fallback behavior precisely.

## Fix pass — call-site guard tests

### Sites covered
All three call sites are covered with real assertions:

1. **spark.ts `getTodaySpark`** — mocked `@/lib/db` (prisma.dailySpark.findUnique → null, upsert passthrough) so the function runs fully. Guest: `getAnthropic` spy not called, `source === SparkSource.Fallback`. Owner: spy called once (throws → fallback, no crash).

2. **focus.ts `proposeNewEstimate`** — mocked `@/lib/workspace` (`currentWorkspaceId` returns guest or owner ID), `@/lib/db` (step.findFirst returns a fixture), `@/lib/google`, `@/lib/rewards`, `next/cache`. Guest: spy not called, returns `estMinutes + 10`. Owner: spy called once.

3. **rollup.ts `generateTodayRollup`** — mocked all prisma sub-objects needed by `gatherDayData` (focusSession.findMany x2, rewardEvent.aggregate, step.findMany) plus dayRollup.findUnique/upsert and dailySpark.findUnique (for the getTodaySpark call at the end). Guest: spy not called. Owner: spy called once (throws → fallbackNarrative path).

### How the mocks were structured
Used `vi.hoisted()` to create shared mock objects (`getAnthropicSpy`, `prismaMock`, `currentWorkspaceIdMock`) before vitest's hoisting of `vi.mock()` factory calls. The `getAnthropicSpy` is configured to throw — meaning any accidental guest call causes a test failure, not a silent pass.

### No sites left to manual reasoning
All three call sites (spark, rollup, focus) are covered with real call-count assertions. No site was left untested.

### Test command and result
```
npm run test
→ Test Files  12 passed (12)
→ Tests  58 passed (58)
npx tsc --noEmit → (no output — zero errors)
```

### Commit
`328baff test(phase2): assert guests never reach getAnthropic in spark/rollup/focus`
