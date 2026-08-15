# Breakdown coach — app + user context (as built)

- **Date:** 2026-07-27
- **Status:** Implemented
- **Issue:** #14 · **Milestone:** v0.5.0
- **Approach:** Option B, 5–30 minute sizing kept (locked in the 2026-07-11 brainstorm)
- **Size:** Small — one new server module, one pure prompt helper, one SYSTEM splice. No migration, no new env var, no request-shape change.

This document records what shipped. The full pre-implementation spec lives as a
comment on #14; this is the as-built version, including the four places the
implementation deliberately diverged from it (§6).

> ## ⚠️ Superseded in part — checked 2026-08-15
>
> This is an *as-built* record of 2026-07-27, and four of its standing claims
> stopped being true after it. The body below is left as written, because it is
> the record of what was decided and built then; read these four first.
>
> **The privacy claim is the one that matters.** §"Goal" says *"No free text is
> added"*, and that is **no longer true**. `#179` (`!281`, 2026-08-08) added
> `Task.notes` — the person's own free text on the task being broken down — to
> the context block on an explicit owner decision, and the code names the
> trade-off it accepted: *"the BYO-LLM egress of the note itself"*
> (`src/lib/breakdown.ts`). One task's note is sent; the notes of tasks in the
> history summary are still never fetched, which is what keeps breakdown history
> from becoming a self-feeding injection channel. So the shape of the guarantee
> changed rather than disappearing — but anyone using this document to answer
> "what leaves for a third-party endpoint?" needs the note in the answer.
> `buildNoteBlock()` is absent from §"Files" below for the same reason.
>
> The other three, all from the same follow-on work:
>
> - **§6 deviation 3 says `currentTaskId` is unreachable and "the route passes
>   nothing".** The deferred request-body change landed: `BreakdownRequest` now
>   carries `taskId`, and the route reads it (`src/app/api/breakdown/route.ts`)
>   and hands it to `gatherBreakdownContext`. This also retires the Non-goal
>   forbidding a request-shape change.
> - **The model-tier lookup is no longer gated on `owner`.** `#96` gave a member
>   a model preference to read, so the route resolves settings for the current
>   workspace. `OWNER_WORKSPACE_ID` itself went with `#35` Phase A and now
>   survives only in explanatory comments and as `LEGACY_OWNER_WORKSPACE_ID` in
>   `prisma/scheduled-purge.ts`.
> - **The `Step.estMinutes` "known gap" is closed.** §"Known gaps" says adding a
>   CHECK constraint would need a migration that `#14` ruled out. The migration
>   `20260727194512_step_est_minutes_check` exists, with a colocated
>   integration test.
>
> Everything else re-verified accurate, including both character budgets
> (`MAX_APP_CONTEXT_CHARS` 1200 with 1,197 used, `MAX_CONTEXT_CHARS` 600), the
> absence of prompt caching, and the numeric/enum-only `select` on the history
> reads.

## Goal

Before this change the breakdown SYSTEM prompt knew nothing about dlectroflow.
The coach did not know its steps become focus-timer blocks, did not know the
proposal is editable, did not match the person's voice setting, and had no idea
how they like their breakdowns shaped.

Now it gets two things:

- **Static app knowledge** in the SYSTEM prompt (`BREAKDOWN_APP_CONTEXT`): what
  the app is, that steps become focus-timer blocks, that a proposal is an
  editable starting point, that finishing steps feeds points and a working-day
  streak, that confirmed steps can go to a calendar.
- **Live, server-derived state** appended to the **user turn**: voice, current
  streak, live board counts, and the *shape* (step count + minute range) of the
  last three kept breakdowns.

## Non-goals

No time-of-day (explicitly excluded). No step *text* from history. No
client-supplied context of any kind. No schema migration. No change to
`StreamEvent`, `Proposal`, the `propose_steps` tool schema, or the request body.
No `BreakdownTurn` persistence. No new env var. No prompt-caching enablement
(§5). No provider work — this consumes the #59 seam, it does not change it.

## What is injected, and where it comes from

| Injected field | Source | Read via |
| --- | --- | --- |
| `voice` (`plain`\|`playful`) | `Settings.voice` | `prisma.settings.findUnique`, `select: { voice: true }` |
| streak + "active today" | `Streak.current`, `Streak.lastActiveWorkday` | `prisma.streak.findUnique`, numeric/string select |
| board counts | `BrainDumpItem` + its `Task.status` + step `done` flags | one bounded `findMany`, then `bucketItems()` |
| last 3 breakdown shapes | `Step.taskId` / `estMinutes` / `createdAt` | one bounded `findMany`, then `summarizeRecentBreakdowns()` |

All four run in a single `Promise.all` alongside the existing owner model-tier
lookup, so the route still makes one round trip.

Rendered block (fenced, appended to the user turn between the proposal and the
person's feedback so their own instruction stays last):

```
--- App context (server-derived; not from the person's message) ---
Voice: playful
Momentum: 4-day working-day streak, active today
Their board: 3 to review, 2 single to-dos, 1 multi-step, 4 saved for later
Their last 3 kept breakdowns: 6 steps (10–30 min, ~15 median); 4 steps (5–20 min, ~10 median); 7 steps (10–25 min, ~15 median)
--- end app context ---
```

Every line is omitted when its data is absent or zero, individual board
segments included. When nothing is known the block is `""` and the prompt is
**byte-identical to the pre-#14 one** — the back-compat anchor for a brand-new
owner or a fresh guest sandbox, asserted in both the unit and the integration
suite.

## Privacy and scoping

Under BYO-LLM (#59) the destination may be a third-party endpoint the owner
configured, so every added field is treated as "published to an external
processor".

**The entire delta is one enum plus integers**: `plain`|`playful`, one small
streak integer, one boolean ("active today"), four board integers, and up to
three `(stepCount, min, median, max)` minute tuples. No free text is added.
(What already left before this change and still does: the task title, any
free-text feedback the person typed, and the current proposal JSON — all
client-supplied.)

Three controls, all structural rather than review-time:

1. **Explicit numeric/enum-only `select` on every read.** `Step.text` and
   `BrainDumpItem.text` are never selected. Not fetching them is a stronger
   guarantee than remembering not to render them — and it means breakdown
   history can never become a prompt-injection channel into future breakdowns.
2. **Workspace scoping.** Every read is `where: { workspaceId }` (or
   `{ task: { workspaceId } }` for steps, which have no workspace column of
   their own). `workspaceId` comes only from `currentWorkspaceId()`, never from
   the request body. The route's pre-existing `getSettings(OWNER_WORKSPACE_ID)`
   is a *model-tier* lookup and stays gated on `owner`; the context read uses
   `wsId`. Confusing the two would hand a guest the owner's data, so it is
   covered by tests at both layers plus a real-Postgres isolation test.
3. **Read-only.** `prisma.settings/streak.findUnique` directly, *not*
   `getSettings`/`getStreak` from `@/lib/db` — both of those upsert, and the
   breakdown route is a hot path. A unit test asserts no `create`/`update`/
   `upsert` mock is ever touched.

Nothing in this path touches `GoogleAuth` tokens, `Settings.roundupEmail`,
`GuestAiUsage.ipHash`, any env secret, or session cookies. No identifiers,
emails or dates are rendered: `lastActiveWorkday` is compared server-side and
leaves only as the boolean "active today".

**Guests** get context from their own ephemeral sandbox only, and a **blocked**
guest (quota / global cap / no resolvable IP) does **zero** context reads — the
gather runs only when `blockedReason` is null.

**Prompt injection.** The block shares the user turn with attacker-influenceable
text (title, free feedback). Acceptable because the block is numbers and one
enum: no crafted title changes what is read, and nothing security-relevant is
decided from the block. Behavioural rules stay in SYSTEM, which user text cannot
reach. `voice` is validated against the known enum before rendering, because
`Settings.voice` is an unconstrained `String` column.

**Request-size guard.** `MAX_BODY_CHARS` still measures *client* input only.
Server-injected context is added afterwards and deliberately does not count
against it.

## Voice rule (owner decision, #14)

> The coach may acknowledge momentum in passing **at most once per breakdown**,
> and must never recite the actual figures. A coach who remembers you, not one
> keeping a scoreboard.

Enforced in `BREAKDOWN_APP_CONTEXT` (so it lives in SYSTEM, out of reach of user
text) by three sentences: the block is "background, not material to talk about";
momentum may be acknowledged "warmly at most once, in passing"; and "never
recite the numbers back, never comment on how much is in their inbox, never
imply they are behind."

Covered by two test layers: assertions on the constant, and assertions on the
SYSTEM string the route actually puts on the wire. Both include a
**banned-phrase guard** that fails if the prompt ever gains a
congratulate/celebrate/cheer/"mention their streak" directive — the specific
regression this rule exists to prevent.

## Size and cost

Measured on a realistic request (6-step proposal, full context):

| | before | after |
| --- | --- | --- |
| SYSTEM | 968 chars | 2,167 chars |
| user turn | 770 chars | 1,128 chars |
| total | 1,738 chars (~470 tok) | 3,295 chars (~890 tok) |

Two caps make the growth **constant rather than proportional to how much data
someone has**: `MAX_APP_CONTEXT_CHARS = 1200` on the static block (1,197 used)
and `MAX_CONTEXT_CHARS = 600` on the dynamic block (357 in the realistic case).
So the worst-case delta is ~1,800 chars (~485 tokens) for any user, forever.

Growth is per-request, not compounding: the route sends a single user turn with
no conversation history.

When the dynamic block overflows its cap, lines are shed in this order — the
history list loses entries one at a time, then the board line, then momentum.
`Voice:` is never dropped.

**Prompt caching is deliberately out of scope.** `src/lib/llm/anthropic.ts`
sends `system` with no `cache_control`, so nothing is cached today, and the
minimum cacheable prefix (~1024 tokens for Sonnet/Opus, ~4096 for the Haiku
guest tier) is well above a ~590-token SYSTEM. Keeping the static block a
hoisted, non-interpolated constant buys future eligibility and a byte-identical
prefix; enabling `cache_control` is a separate follow-up on the adapter.

## Failure modes

| Mode | Behaviour |
| --- | --- |
| Brand-new user / empty context | Block is `""`; prompt byte-identical to pre-#14 |
| Junk `Settings.voice` value | Treated as "no preference"; line omitted |
| Unusable `estMinutes` (`NaN`, `Infinity`, zero, negative, sub-minute) | Row **skipped**, never coerced. Clamping a negative to `0` and keeping it would inflate `stepCount`, drag `minMinutes` to `0` and shift the median — telling the coach this person likes 0-minute steps. A task whose every estimate is unusable produces no entry at all |
| Absurd but valid numbers | Clamped at render time; minute figures re-sorted so a malformed row cannot produce an inverted range |
| Context read throws or is slow | Resolves to `{}`; breakdown still streams `text` + `steps`, **no** `fallback` event, nothing logged as an LLM failure |
| Blocked guest | Zero context reads; unchanged `[fallback, done]` |
| Provider without tool support | Same prompt, one code path. The adapter appends the `propose_steps` JSON Schema *after* SYSTEM, so SYSTEM still ends with the tool instruction and the static block is capped to limit small-model drift |
| Provider returns junk / no tool call | Unchanged: guest refund + `localBreakdown` fallback |
| Provider down | Unchanged: `recordLLMFailure` + refund + canned fallback |

## Deviations from the spec on #14

1. **Board counts reuse `bucketItems()` instead of four mirrored SQL counts.**
   The spec's own stated risk was drift from `src/components/inbox/bucket.ts`,
   and "stepsTotal > 1" is not expressible as a Prisma relation filter anyway.
   One bounded `findMany` feeding the inbox's real bucketing function makes
   drift structurally impossible, and costs one query instead of four. The
   integration test now proves the SQL prefilter (`status != archived`,
   `completedAt IS NULL`) cannot change any of the four counts.
2. **No Settings row means voice is `null`, not `"plain"`.** The spec said both
   "null row ⇒ plain" and "all absent ⇒ byte-identical prompt", which cannot
   both hold. The back-compat anchor won: a workspace that never recorded a
   preference is treated as unknown rather than asserted to be `plain`.
3. **`currentTaskId` is unreachable from the route.** The spec's query excludes
   the in-flight task's steps, but `BreakdownRequest` carries no task id and the
   spec also forbids changing the request shape. In practice there is nothing to
   exclude — steps are not persisted until `confirmBreakdown()` — so the
   parameter is implemented and tested but the route passes nothing. Wiring it
   up would need a (deliberately deferred) body change.
4. **`summarizeRecentBreakdowns` lives in `breakdown-context.ts`, not
   `breakdown.ts`.** It operates on DB row shapes; `breakdown.ts` promises to
   stay import-safe for client components.

## Known gap: `Step.estMinutes` has no CHECK constraint

Every current writer clamps to `>= 1` — `confirmBreakdown` (`Math.max(1, Math.round(s.estMinutes || 15))`, which is also what stops a hostile model proposing a negative estimate), `updateStepEstimate`, `requeueFocus`, and the single-task seed. But unlike this schema's pseudo-enum columns, `Step.estMinutes` has no CHECK constraint, so that guarantee rests on four scattered call sites staying correct forever. `summarizeRecentBreakdowns` therefore skips non-positive estimates as a read-side backstop. Adding the constraint would need a migration, which #14 explicitly rules out — worth a follow-up issue.

Also: the spec's own token estimate ("~10–20% input growth") assumed the
proposal JSON dominates a 600–1,200-token user turn. Measured, a realistic
request is only ~470 tokens total, so the real growth is ~90% — still fractions
of a cent per breakdown, and still bounded by a constant.

## Files

**Added**

- `src/lib/breakdown-context.ts` — server-only gather + `summarizeRecentBreakdowns`
- `src/lib/breakdown-context.test.ts` — scoping, read-only, selects, coercion, failure
- `src/lib/breakdown-context.integration.test.ts` — bucket parity + workspace isolation

**Modified**

- `src/lib/breakdown.ts` — `BREAKDOWN_APP_CONTEXT`, `BreakdownContext`, `buildContextBlock()`, caps, optional `ctx` on `buildUserPrompt()`
- `src/lib/breakdown.test.ts`
- `src/app/api/breakdown/route.ts` — SYSTEM splice, gather in the existing `Promise.all`, context into the user turn
- `src/app/api/breakdown/route.test.ts`

**Unchanged:** `prisma/schema.prisma`, `.env.example`, `src/lib/llm/*`,
`src/lib/models.ts`, `src/components/breakdown/breakdown-chat.tsx`.
