# Schedule intent — getting task information to Reclaim properly (#104, epic #29)

**Status:** design, awaiting owner approval
**Issue:** #104 (defects), epic #29 (S3/S4 territory), related #44
**Milestone:** v0.5.0

## Goal

A task scheduled from dlectroflow should arrive in the owner's calendar **in the right order, in blocks worth defending, labelled so the slot tells you what to do**. Today it arrives reversed, mislabelled and deep-linked to the wrong step.

Scheduling stays **delegated**: Reclaim keeps deciding the exact slot, because it is the only party that can see the real calendar and reshuffle when the week moves. dlectroflow's job is to brief it properly. The app asks for no calendar scope and places no events itself.

## Non-goals

- **Owning placement.** No `auth/calendar` scope, no free/busy lookup, no event creation. That is epic #29 S4 and it stays there.
- **Marking events busy directly.** Not reachable from the Tasks payload — see Constraints. The intent carries `busy` for the ICS encoder, which *can* honour it.
- **`(upnext)`.** Reclaim's Up Next queue is a Reclaim-side workflow; nothing in dlectroflow maps to it.
- **User-configurable working hours.** The window model below ships with fixed defaults. Exposing them in Settings is a follow-up, noted where it bites.
- **Recurring tasks.** Reclaim's own docs say title syntax is unreliable for recurring tasks. Out.
- **Per-user Google connections.** Still the owner singleton; #35 Phase C moves it.

## Current state — what is actually wrong

Verified against the seven live calendar events one task produced (`get_schedule`, 29 Jul – 4 Aug):

| Defect | Evidence |
|---|---|
| **Steps land reversed** | Step 7 at Wed 2:45 PM … step 1 at Fri 11:15 AM. Perfectly inverted. |
| **Every event deep-links to step 1** | All seven descriptions carry `/focus/cms4j8w6w0004zx01l37gdbcj`. `buildScheduleNote` is called once with `task.steps[0]?.id` outside the loop (`google-schedule.ts:108`). **The `.ics` path has the identical bug** (`ics-schedule.ts:53`), so guests' downloads are affected too — `buildTaskIcs` takes one `description` for all `VEVENT`s and needs to take one per step. |
| **Titles are 104 chars** | A calendar slot shows ~30. What survives is `🏷️ do flex training: 6 of 7 ✏️ N…` — the counter, not the step. |
| **Short steps get 15-minute slivers** | `(duration:15m)` passed straight through; nothing floors it, nothing prevents splitting. |
| **No hours category** | No `(type …)`, so personal work can land mid-workday. |
| **Re-scheduling duplicates** | Both call sites always POST a new Google Task. `Step.googleTaskId` is stored but never used to update. |

Root cause of the ordering: every step ships **identical scheduling metadata** — one duration hint, no `due`, no `not before`. `order`/`total` live in the title, where they are decoration a human reads, not data a scheduler acts on.

## Constraints discovered (these shaped the design)

From Reclaim's Google Tasks documentation and its live API:

1. **The list must literally be `🗓 Reclaim`.** "Any other tasks in other lists will not be synced." The existing case-insensitive `"reclaim"` substring match is therefore correct, and `GOOGLE_TASKS_LIST_NAME` pointing anywhere else means *nothing syncs*. That is a footgun to document, and the signal we use to pick an encoder (below).
2. **Syntax Reclaim parses out of the title, then strips:** `(duration:30m)`, `(due …)`, `(not before …)`, `(priority:P1…P4)`, `(type work|personal)`, `(nosplit)`, `(upnext)`. Anything unparenthesised survives into the calendar title.
3. **Busy is Reclaim's decision, not the sender's.** Task events are created *free* (🆓, dotted outline) and Reclaim **flips them to busy** (🛡️) as the due date approaches and scheduling options run out. There is no `(busy)` parameter and no per-task setting. The only levers are **due date** and **priority**.
4. **Minimum event is 15 minutes**, and a task may be split into several events. `(nosplit)` is the only splitting control available through the title.
5. **Sync latency:** seconds on paid plans, up to 5 minutes on free. Anything we schedule needs a small lead-in buffer.
6. **Notes sync** to the calendar event description and stay editable in Reclaim.
7. **Two-way sync:** edits to title, duration and due date propagate both ways; completing or deleting on either side mirrors.
8. **Date formats accepted** include natural language (`monday`, `tomorrow`, `in 1d`, `August 7th`) and `MM/DD/YYYY HH:mm`. **Numeric dates are ambiguous** across the owner's `en-GB`/DMY locale and a US-format parser, so we emit a month-name form and verify it empirically (see Risks).

## Design

Three sub-projects, dependency-ordered. **A** fixes the defects with no UI. **B** adds the menu. **C** adds per-step overrides.

### 1. `ScheduleIntent` — the provider-agnostic vocabulary (A)

Widens today's `ScheduleOpts = { durationMin?: number }` in `src/lib/scheduling/types.ts`. Stays client-safe and pure.

```ts
export const SchedulePriority = {
  Critical: "critical", // → P1
  High: "high",         // → P2  (Reclaim's own default; ours too)
  Normal: "normal",     // → P3
  Low: "low",           // → P4
} as const;

export const ScheduleHours = { Work: "work", Personal: "personal" } as const;

/** One unit of work to place. Steps of a task, or a single to-do. */
export type ScheduleUnit = {
  id: string;            // Step.id, or Task.id for a single to-do
  order: number;         // 1-based; the sequence to enforce
  total: number;
  text: string;
  emoji?: string | null; // Step.subtaskEmoji
  estMinutes: number;    // the honest estimate, pre-floor
  dueAt?: Date | null;   // per-unit override (C); derived when absent
};

export type ScheduleIntent = {
  dueAt: Date;                    // deadline for the whole task
  priority: SchedulePriority;     // default High
  hours: ScheduleHours;           // default Work
  busy: boolean;                  // honoured by ICS; advisory for Reclaim
  units: ScheduleUnit[];          // ordered
};
```

`busy` is deliberately kept in the intent even though the Reclaim encoder cannot act on it — the ICS encoder sets `TRANSP:OPAQUE`, and keeping the field honest is better than pretending the concept does not exist. It **defaults to `true`** (the owner wants defended time) and is **not exposed in the menu**, because for the path the owner actually uses it is not settable — surfacing a control that silently does nothing on the main route would be worse than the constraint itself.

### 2. Window derivation — how order stops inverting (A)

New pure module `src/lib/scheduling/windows.ts`. Given a deadline and ordered units, produce a **disjoint, monotonically increasing window per unit**:

```
unit i gets  [ notBefore_i , due_i ]   with  notBefore_i == due_{i-1}
```

Step 6 cannot start before step 5's deadline, so Reclaim has no freedom to invert them. That single property is the fix.

**Effective duration** (what we ask Reclaim to block):

```
dur_i = max(30, round(estMinutes_i || 25))
```

The 30-minute floor is deliberate: a 15-minute sliver is not worth a context switch, and it is under Reclaim's minimum-plus-split threshold. The honest estimate is preserved — see the title format.

**Splitting the window.** Wall-clock splitting is wrong: a two-hour window at 03:00 is useless, and Reclaim only places work inside scheduling hours. So the module walks the interval accumulating **working minutes** under a fixed profile and returns boundaries at cumulative working-minute offsets:

| Profile | Default |
|---|---|
| `work` | Mon–Fri, 08:30–18:00, in the workspace timezone |
| `personal` | Mon–Fri 18:00–22:00, Sat–Sun 09:00–22:00 |

These are the owner's actual hours, confirmed 2026-07-29 — 9.5 working hours a day, not the 8 a generic default would assume, which matters because it is the denominator every window share is computed from. The two profiles abut at 18:00 by design: work ending exactly where personal begins means a task cannot fall into a gap between them.

Fixed constants in this milestone, exported so Settings can adopt them later (non-goal above). They only need to be *approximately* right: they place the boundaries and drive the feasibility warning, while Reclaim does the real placing against the owner's actual hours.

Allocation is proportional to duration, so a 90-minute step gets more room than a 30-minute one:

```
start   = now + 15min                       // sync lead-in (constraint 5)
avail   = workingMinutes(start, deadline, profile)
share_i = avail * dur_i / Σ dur              // then rounded to 15-min boundaries
b_0     = start ;  b_i = advance(b_{i-1}, share_i)
notBefore_i = b_{i-1} ;  due_i = b_i         // due_last == deadline, exactly
```

Boundaries are snapped **into** working time (never a 03:00 due date) and clamped so `due_i - notBefore_i` is never shorter than `dur_i`.

**Feasibility.** The module returns `{ windows, feasible, availableMin, requiredMin, earliestFeasibleDate }`. When `requiredMin > availableMin` the menu says so in plain terms and offers the earliest date that fits, rather than silently over-stuffing the week:

> Friday leaves 4h of working time; these 7 steps need 4h30m. Earliest that fits: **Monday**.

It warns, it does not block — a deliberate over-commit is the owner's call.

**Single unit** (a to-do with no steps): no `not before`, `due = deadline`. Nothing to sequence.

### 3. The Reclaim encoder (A)

New pure module `src/lib/scheduling/encode-reclaim.ts`. Takes a unit + its window + the intent, returns `{ title, notes }`.

**Title** — counter badge as prefix, step text, estimate only when floored, then parameters:

```
[6/7] ✏️ Note any steps or rules in the quoting process you want to remember ~15m (duration:30m) (nosplit) (not before Jul 31 2026 9:00am) (due Jul 31 2026 11:00am) (priority:P2) (type work)
```

After Reclaim strips the parentheses the slot reads:

```
[6/7] ✏️ Note any steps or rules in the quoting process you want to remember ~15m
```

Decisions inside that format:

- **Counter as a prefix badge** (`[6/7]`) — position at a glance, one glyph-cheap token, and the step text starts within the first ~6 characters so it survives truncation.
- **`~15m` appears only when the floor changed the number.** When the estimate is already ≥ 30 it would just restate `(duration:)`.
- **Parent task title moves to the description.** It was eating the visible width and it is identical across all of a task's events.
- **Month-name dates** (`Jul 31 2026 9:00am`), never `31/07/2026` — see constraint 8 and Risks.
- **`(nosplit)` always, for multi-step tasks.** A step is one sitting; without it a floored 30-minute block can split into two 15s.
- **`(priority:P2)` always sent explicitly.** Today we send nothing and inherit Reclaim's P2 default; sending it makes behaviour predictable for self-hosters whose defaults we cannot see, and defaulting the menu to High avoids silently downgrading everything the owner already schedules.

**Description** — carries what the title gave up, plus the fix for the deep-link defect:

```
🏷️ do flex training — step 6 of 7 · est. 15m
▶ Open the focus timer for this:
https://dlectroflow.dev/focus/<THIS step's id>
```

`buildScheduleNote` already accepts a `stepId`; the caller is moved **inside** the loop. That is the whole of the deep-link fix.

### 4. The plain Google Tasks encoder (A) — #29 generalisation

A self-hoster with a Google account and no Reclaim gets nothing from parenthetical syntax; it is noise in their task titles. So the encoder is chosen by **detecting the list**, with no configuration for either audience:

| List name matches `reclaim` | Encoder |
|---|---|
| yes | `encode-reclaim` — parameters in the title, as above |
| no | `encode-plain` — Google Tasks' **native `due` field** (RFC 3339 date), title without parameters, duration and window in the notes |

`SCHEDULING_SYNTAX=reclaim\|plain` overrides the detection for anyone who needs it. `createGoogleTask` already accepts `due` and never receives it — the plain encoder is the caller that finally does.

The ICS path takes the **same intent** and renders what applies to a calendar file: per-step `DESCRIPTION`, `TRANSP:OPAQUE` from `busy`, `DUE` when a deadline was chosen — keeping its own back-to-back placement for the reason given in §6. One intent, three renderings — which is exactly the seam #29 S1 built (`SchedulingProvider`), extended rather than bypassed.

### 5. Update-in-place instead of duplicating (A)

`Step.googleTaskId` / `Step.googleTaskListId` are already persisted and never read. With a menu that invites re-scheduling, POST-always becomes a duplicate factory. So:

- Unit already has a `googleTaskId` → **PATCH** it (title + notes + due).
- Otherwise → POST and store the id.
- PATCH returning 404 (deleted in Google) → POST a replacement and overwrite the id.

`patchGoogleTask` widens from `{title, status}` to `{title, notes, due}`. Reclaim two-way-syncs title/duration/due edits (constraint 7), so a re-schedule *moves* the block instead of adding a second one.

### 6. The Schedule menu (B)

A popover on the existing Schedule control — same component family and dismissal behaviour as the duration popover `scheduleSingleTask` already uses, so this is a variant of a pattern in the repo, not a new one.

```
Schedule "do flex training"

  Done by      [ Friday 31 Jul  ▾ ]     today · tomorrow · this week · pick a date
  Priority     [ High           ▾ ]     critical · high · normal · low
  Hours        ( ● Work )  ( ○ Personal )

  7 steps · 3h30m of blocks · spread in order before Friday
  Reclaim usually picks these up within a few minutes.

  ▸ Set per step

                                     [ Cancel ]  [ Schedule ]
```

- **Defaults:** deadline **7 days out**, priority **High**, hours **Work**. Personal is one click.
  - *Revised 2026-07-30, from production evidence.* This was 3 days, to match Reclaim's own default. In prod, a 4-step task at the 30-minute floor (2h of blocks) had its last two steps' work sessions placed **after** the 3-day deadline — the at-risk state, which is precisely the feeling an ADHD planner should not manufacture by default. A week gives the scheduler room; a tighter deadline is what the menu is for.
- **Fields are shown only where they do something.** Priority and hours are Reclaim vocabulary, so they appear when the Google Tasks method is the active one and are omitted for the `.ics`-only case (guests, self-hosters without Google) — which sees the deadline and the per-step expander alone. A control that provably has no effect is not shown greyed out; it is not rendered.
- **`.ics` keeps its own placement.** The intent's windows drive the Google/Reclaim path; `buildTaskIcs` continues to lay steps back-to-back from the next top of the hour, because a downloaded calendar file is a "do this now" artifact and spreading it across three days would be a regression for the guest flow. What `.ics` takes from the intent is the per-step description (the deep-link fix), `TRANSP:OPAQUE` from `busy`, and — when a deadline was explicitly chosen — `DUE`.
- The summary line recomputes live and turns into the feasibility warning when the deadline cannot fit the work.
- **Prefilled on re-open** from the persisted intent, so re-scheduling never means re-entering what you already said.
- Full keyboard operation, labelled controls, focus trapped and restored — the repo's popovers are already held to this and the axe gate covers `/`.

**Persisted** (so the menu can prefill and the row can show "due Fri"):

```prisma
model Task {
  scheduleDueAt     DateTime?
  schedulePriority  String?    // "critical" | "high" | "normal" | "low"
  scheduleHours     String?    // "work" | "personal"
}
model Step {
  scheduleDueAt     DateTime?  // per-step override (C); null = derived
}
```

With `CHECK` constraints on the two enum-ish columns, per the convention #80 tracks.

### 7. Per-step overrides (C)

`▸ Set per step` expands a compact row per step inside the same popover — no second dialog, no navigation:

```
▾ Set per step
   1  🔗 Find and open the Flex training      [ 15 ]m   [ derived ▾ ]
   2  📖 Read the overview of what Flex is    [ 30 ]m   [ derived ▾ ]
   6  ✏️ Note any steps or rules…             [ 15 ]m   [ Thu 30th ▾ ]
```

- **Duration** edits `Step.estMinutes` directly — the same number the focus timer and the ICS path use, so there is no second source of truth to drift.
- **Deadline** defaults to `derived` (the window model). Setting one pins that step and the derivation re-flows the *unpinned* steps around it, preserving monotonicity. A pin that contradicts the order (step 6 before step 2's window) is rejected inline with the reason.
- Reordering is **not** here: steps already drag-and-drop in the task (#26), and two ways to express order is how they drift apart.

## Testing

Every layer below the UI is pure, which is the point of the split.

- **`windows.ts`** — unit tests on the property that matters: windows are disjoint, monotonic, never shorter than the floored duration, `due_last == deadline`, boundaries land inside working hours. Table-driven across 1/2/7/20 steps, deadlines from 2 hours to 3 weeks out, DST boundaries, and the infeasible case.
- **`encode-reclaim.ts`** — exact-string tests per unit (the parameter set, the badge, `~15m` present only when floored, `(nosplit)` only for multi-step). Snapshot the full title so a format change cannot land silently.
- **Round-trip guard** — a test asserting that stripping every `(…)` group from an encoded title yields exactly the intended visible text. That is the contract with Reclaim's parser.
- **`encode-plain.ts`** — native `due` is RFC 3339, title carries no parentheses.
- **Update-in-place** — POST on first schedule, PATCH on second, POST-after-404, and no duplicate ids.
- **Menu** — jsdom/RTL for defaults, prefill, live summary, the feasibility warning, and keyboard operation; axe on the open popover.
- **Playwright** — schedule a 3-step task, assert three tasks with monotonic windows; re-schedule, assert three (not six).
- **Production build check** — the menu is verified in `next build` output, not only jsdom (the `"rolling 30 dayswindow"` lesson).
- **One real push, verified against the live account** — see Risks.

## Risks

| Risk | Handling |
|---|---|
| **`[6/7]` read as a date.** Reclaim parses natural-language dates; an unparenthesised `6/7` could be seen as 6 July. | Verify with one real push before the format is settled: encode, push, read back via `get_schedule`, confirm the badge survives and no due date moved. Documented fallback: `[6 of 7]`, then `[step 6/7]`. |
| **Numeric date ambiguity** (DMY vs MDY). | Month-name format only, asserted by test. The same real push confirms the parsed due date matches what we sent. |
| **Window arithmetic vs Reclaim's real hours.** Our profile is a guess at the owner's actual scheduling hours. | Windows only need to be monotonic and sane; Reclaim places against its own hours. Wrong-but-monotonic still fixes the ordering. Settings exposure is the follow-up if the guess annoys. |
| **Tight deadlines starve later steps** — Reclaim may not schedule what it cannot fit. | Feasibility warning with the earliest date that fits. Warn, don't block. |
| **A step deleted in Google** then re-scheduled. | PATCH 404 → POST a replacement. Covered by test. |
| **Existing scheduled tasks** carry old-format titles and no persisted intent. | New columns are nullable; the menu falls back to defaults. No backfill, no migration of live Google Tasks. |

## Rollout

Three MRs, each independently shippable and each leaving the app working:

1. **A — payload** (`ScheduleIntent`, `windows.ts`, both encoders, per-step deep-link, update-in-place, `(type work)`, the floor). No UI change: the actions derive a default intent (7 days out, High, Work) exactly as the menu will. **This alone un-reverses the calendar.**
2. **B — the menu** + the three persisted columns + prefill.
3. **C — per-step overrides** + `Step.scheduleDueAt`.

Also folded into A, being one-line fixes in the files already open: the `no_reclaim_list` message stops naming Reclaim as though the app dropped it and instead names the `🗓 Reclaim` list the docs require, and `GOOGLE_TASKS_LIST_NAME`'s comment records that pointing it elsewhere means Reclaim syncs nothing.

## Resolved decisions

| Question | Answer |
|---|---|
| Who places the work? | Reclaim. The app briefs it; no calendar scope. |
| What does the menu ask? | Deadline + priority + work/personal. Whole task by default. |
| Mark as busy? | Not settable via Tasks. Driven by deadline and priority; honoured literally only by ICS. |
| Short steps? | Floored to a 30-minute block, `(nosplit)`, real estimate kept visible as `~15m`. |
| Title layout? | Counter badge prefix, then step text. Task title, estimate detail and focus link in the description. |
| `(type …)` default? | `work`, unless personal is chosen. |
| Priority default? | High (P2) — matches what Reclaim already infers today, so nothing is silently downgraded. |
| Deadline default? | **7 days out.** Was 3 (matching Reclaim's own default) until 2026-07-30, when production showed a 4-step task's later blocks landing after the deadline. See the Defaults note above. |
| Per-step control? | Yes, as an opt-in expander inside the same menu (C). |
| Ordering mechanism? | Disjoint `(not before …)`/`(due …)` windows, proportional to duration, over working minutes. |
| Non-Reclaim self-hosters? | Detected from the list name; plain encoder uses Google's native `due` field and adds no syntax. |
