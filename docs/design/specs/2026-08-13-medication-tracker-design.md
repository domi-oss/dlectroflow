# A medication tracker — "did I take my meds", and nothing more than that

Owner brainstorm held 2026-08-13. Every product decision below was settled by the owner in that
session; this document's job is to write them up precisely, check each claim against the tree, and
name the consequences the brainstorm could not have known about.

**There is no issue for this work yet.** This spec is written first deliberately, because two of its
decisions — the derived `Missed` state and the presentational-only reward — determine the data model,
and a data model is the expensive thing to get wrong. The v1 slice below is what an issue should be
cut from.

## Goal

The premise is narrow and worth stating in the owner's words rather than generalising it:

> I only need to understand if my adhd brain has actually taken the adhd meds.

That is a **memory** problem, not a scheduling problem. The question is asked at a specific moment —
standing in the kitchen at 11:00, wondering whether the two tablets after breakfast happened — and
the answer has to be available in one glance and recordable in one tap. Everything that makes a
medication app large (multi-user regimens, interaction warnings, pharmacy refills, adherence
scoring) is absent from that sentence.

The regimen the feature must serve on day one: **2 tablets after breakfast, 1 tablet after lunch,
working days only.**

The generic feature the owner also asked for, because a tracker built for exactly one regimen is a
hard-coded string: settings that enable or disable the feature entirely, set the regimen, and
eventually choose between views; and eventually notifications.

## Non-goals — settled with the owner, not deferred by omission

- **Adherence scoring of any kind.** No streaks, no badges, no points, no percentage. This is the
  single most consequential decision in the document and it has its own section below.
- **Clock times per dose, as the primary model.** The owner's regimen is **meal-relative**. "After
  breakfast" is not a time, and a time picker invites a precision the user does not have and cannot
  honour. `dueAfter` exists (below) but it is **optional**, and nothing waits for it — it is read when
  something renders, never scheduled against.
- **Notifications in v1.** The banner ships; notifications are v3 and have their own section,
  including a correction to what this brainstorm was told about the production scheduler.
- **A `/meds` page in v1.** v2, mirroring how `/shopping` is a gated optional page.
- **Any AI involvement, ever, in any tier.** Not deferred — declined. `/terms` already tells users
  not to rely on an AI suggestion for "medication or dosing" (verified below), and the cheapest way
  to keep that promise absolutely is for no medication row to reach a prompt. See *Current state*.
- **Multi-user or caregiver regimens.** Single-owner app; a second person's doses are a different
  product.

## Current state — verified 2026-08-13 against `origin/main` at `90d97dd`

Every row was read at that named commit with `git show origin/main:<path>`, not from a working tree:
this repo carries roughly thirty worktrees and a tree is only evidence about the commit you are
standing on. **Every row where the re-read corrected what the brainstorm asserted carries a ⚠️.**

| Claim under test | What the tree says |
| --- | --- |
| `Settings.workdayEndTime` exists, `String @default("17:00")`, HH:mm | **Confirmed.** `prisma/schema.prisma:147`, with the inline comment `// HH:mm` |
| `Settings.workingDays` exists, `String @default("1,2,3,4,5")`, ISO weekdays Mon=1..Sun=7 | **Confirmed**, `prisma/schema.prisma:152`, comment `// ISO weekdays, Mon=1..Sun=7` — quoted exactly |
| `Settings.shoppingList Boolean @default(false)`, and its comment carries the hide-not-delete doctrine | **Confirmed**, `prisma/schema.prisma:242`. Quoted in *Configurability* below |
| `Settings.completeTickColor`, `completeStrikethrough`, `voice` all exist as described | **Confirmed** — `completeStrikethrough Boolean @default(true)` (`:245`), `completeTickColor String @default("green") // green \| black` (`:246`), `voice String @default("plain")` (`:156`) |
| `Settings.focusTimerStyle String?` is precedent for nullable-inherits | **Confirmed**, `prisma/schema.prisma:173`. The block comment above it (`:169–172`) says `(nullable → resolve by voice)`; the inline comment says `(null → voice default)`. Both phrasings are in the file |
| Nullable-inherits is a repo convention, not a one-off | **Confirmed, on two fields.** `Settings.focusTimerStyle String?` above, and `Settings.breakdownModel String?` — `// null = env/default` (`:153`). ⚠️ Both are *delegation*: null means "ask somewhere else", not "unset". Do **not** cite `Task.schedulePriority` or `Settings.demoOverrideSeconds` as precedent — those are nullable because the value is genuinely optional, which is a different meaning wearing the same type |
| Pseudo-enum columns get a CHECK constraint mirrored in `src/lib/constants.ts` | **Confirmed as the dominant rule — 21 columns carry one** (the enum `REGISTRY`'s size). Naming rule stated in the doctrine migration: `"<Table>_<column>_check"`. ⚠️ **It is not unanimous, and the exception matters here**: `Settings.voice` (`plain \| playful`) and `Settings.breakdownModel` are pseudo-enums with **no** CHECK — verified, zero hits for `Settings_voice_check` and `Settings_breakdownModel_check`. So the decision below needs an argument, not just an appeal to convention |
| ⚠️ The CHECK/constant pairing is guarded by a test the brainstorm did not know about | **`src/lib/enum-constraint-sync.integration.test.ts`** — a hand-maintained `REGISTRY` of **21 entries**, plus `ARRAY_`, `RANGE_` and `LENGTH_REGISTRY`. It asserts set equality between each constraint's literals and its constant object. **This changes the v1 checklist**; see *The CHECK constraint* |
| ⚠️ That test does **not** catch an unregistered new constraint | **Measured, not assumed.** Its "no missing, no strays" assertion intersects the live constraint list with the registry's own names *before* comparing, so a constraint applied but never registered is filtered out and the test passes. Recipe in *Reproducing these numbers* |
| `DayRollup`, `DailySpark` and `GuestDailyActivity` all use `date String // YYYY-MM-DD` + `@@unique([workspaceId, date])` | ⚠️ **Two of three.** `DayRollup` (`:663`, `:674`) and `DailySpark` (`:723`, `:729`) match exactly. **`GuestDailyActivity` does not**: its column is `day`, not `date` (`:826`), it carries **no `workspaceId` at all**, and its key is `@@id([day, ipHash])`, not a `@@unique`. It is IP-hash scoped global bookkeeping, so the difference is correct rather than sloppy — but it is not a citation for this convention. A third genuine one exists: `Streak.lastActiveWorkday String? // YYYY-MM-DD` (`:693`) |
| `bucketOfItem` derives a bucket from `snoozedUntil > now`, with no cron | **Confirmed.** `src/components/inbox/bucket.ts`, `export function bucketOfItem(i: Item, now: number = Date.now())`. ⚠️ #260's body cites it at `:271`; at `90d97dd` the `export function` line is **`:268`**. Cite the symbol, not the line — advice #257's own body gives ("Name the symbols, not the lines") |
| A production CronJob exists | ⚠️ **Yes — and the brainstorm was told the opposite.** `charts/dlectroflow/templates/purge-cronjob.yaml` declares `CronJob/dlectroflow-guest-purge`, `command: ["npx","tsx","prisma/scheduled-purge.ts"]`, `timeZone: Etc/UTC`, `concurrencyPolicy: Forbid`, rendered only `if and .Values.purge.enabled (eq .Values.env "production")`. The npm script is `purge:scheduled` = `tsx prisma/scheduled-purge.ts`. **The claim "there is no server-side scheduler" was false** and is corrected throughout this document |
| The production image has no `src/`, so that entrypoint is self-contained | **Confirmed twice over.** The chart's own comment calls it "a SELF-CONTAINED entrypoint (imports only @prisma/client, no app source) because the standalone image has no src/", and `src/lib/scheduled-purge.test.ts` enforces it: no `@/` specifier, no `../src`, and `expect(packages).toEqual(["@prisma/client"])` |
| ⚠️ `src/lib/manifest-hygiene.test.ts` is a second guard on that entrypoint | **No — it is unrelated.** It tests `packageNameOf` / `importedPackages`, an import-specifier parser. `docs/CONTRIBUTING.md` describes the `manifest-hygiene` guard as "a root config file imports something `package.json` doesn't declare". `scheduled-purge.test.ts` does **not** import it; it runs its own inline regex scan. The purity guard is that one file alone |
| `src/lib/email.ts` exists | **Confirmed** — exports `emailConfigured()`, `EmailResult`, `sendRoundupEmail()`, `roundupEmailHtml()`; Resend-backed via `RESEND_API_KEY`, imported lazily. ⚠️ It is **round-up specific**: a reminder would reuse the transport and need a new template function, not just a call |
| `src/lib/best-effort.ts` — the #257 helper | ⚠️ **Absent at `90d97dd`** (`git show` exits 128). `!339 — Draft: fix(257): a failed post-commit payout no longer reports the write failed` is **open and still Draft** on `fix/257-throw-after-commit`. The class is real and cited from **#257**; the helper is in flight and this document does not name a file that does not exist |
| `notifyRoundup` / `notifyAging` / `notifyDailyReview` are client-delivered only | **Confirmed on both halves.** The schema comment reads `// Phase 6 — per-type notification preferences (client-delivered only)` (`:164`), and `notifyRoundup` is a field of `RoundupSettings` in `src/components/dashboard/roundup-card.tsx`, a client component that calls `showReminder` from `src/lib/notifications.ts` |
| ⚠️ `workdayEndTime` is compared against **the browser's** clock, not the server's | **This is the most load-bearing row in the table.** `roundup-card.tsx`'s `targetTimeToday(hhmm)` builds `new Date()` and sets hours on it, inside a client `useEffect`. So "17:00" already means *17:00 where the user is*. See *Whose clock* |
| ⚠️ `Settings.workingDays` has **no editor surface anywhere** | Zero hits across `src/app` and `src/components`. **Control: the same query for `shoppingList` returns 19 files**, so the zero is a real absence and not a query that never ran. Its only reader is `src/lib/rewards.ts`. In practice every workspace sits on the default `"1,2,3,4,5"`. Recipe below |
| `parseWorkingDays` / `isoWeekday` are reusable | ⚠️ **No — both are module-private** in `src/lib/rewards.ts` (`:24`, `:28`), not exported. A meds resolver cannot import them as they stand |
| `/shopping` is gated server-side, not just in the menu | **Confirmed.** `src/app/(app)/shopping/page.tsx`: `if (!settings.shoppingList) notFound();`, before any query, with the reasoning in a doc comment — and its server actions carry the same check |
| The repo's touch-target floor, and which criterion it is | **Confirmed, and the pair is easy to invert.** 44×44 is **2.5.5 Target Size (Enhanced), AAA** — a voluntary house floor via the shared `touchTarget` helper. **2.5.8 Target Size (Minimum) is the AA one, at 24×24.** `src/components/breakdown/note-field.tsx:333–338` states it correctly and explains the harm of getting it backwards. ⚠️ Two live citations still have it inverted — `src/components/inbox/add-note-button.{tsx,test.tsx}` call the 44×44 floor "WCAG 2.5.8" — which is out of scope here but worth folding into the next MR that touches that file |
| A small in-repo copy set is an established shape | **Confirmed twice**: `FALLBACK_SPARKS` (**8** lines, `src/lib/spark.ts`) and `FABLE_LINES` (**6** lines, `src/lib/fable-lines.ts`). ⚠️ Both pick **randomly**, via `pickOne`. That difference matters; see *The reward* |
| ⚠️ `/privacy` currently states the app has no health field | **It does, in terms this feature contradicts.** "There is no health field, no diagnosis field, no questionnaire, and nothing infers anything about your health." A medication log is a health field. **This is a v1 blocker, not a footnote**; see *The legal copy* |
| ⚠️ `/terms` already names medication | Under *Where being wrong would cost you*: "Do not rely on an AI suggestion for anything with real consequences: **medication or dosing**, legal or tax deadlines, medical appointments…". Scoped to *AI suggestions*, so it is not contradicted — and it is why no-AI is a declared non-goal above rather than an oversight |
| ⚠️ A new workspace-scoped model is auto-enrolled in two guards | `src/lib/export/__tests__/model-coverage.test.ts` and `src/lib/__tests__/scoping.harness.test.ts` both derive their model list from `Prisma.dmmf` **at runtime**, filtered on carrying a `workspaceId` field. So declaring `workspaceId` enrols the model with **no registry entry to forget** — and the export guard will red until `collect.ts` and `json.ts` both name it |
| No medication feature or duplicate issue exists | Zero matches for `medication` in `src/`, `prisma/` or `charts/` other than the `/terms` sentence above. Open-issue search for `medication` returns **0**; `meds` and `pill` return only substring hits (`needs`, `Spotify`, `bulky`) |

## Design

### Four states, three stored shapes

| State | How it is represented |
| --- | --- |
| **Unknown** | **No row exists.** The empty state, awaiting a status update |
| **Taken** | A row with `state = taken` |
| **Deliberately skipped** | A row with `state = skipped` |
| **Missed** | **Derived, never stored** — no row exists *and* the dose's deadline has passed |

`Unknown` and `Missed` are the **same stored shape**. The only thing that separates them is what time
it is when you look.

### `Missed` is derived from `workdayEndTime`, and this is the design's central simplification

The rule, in full — and it is stated once, here, in the form the implementation should take:

> A dose is **missed** when no `MedsDoseLog` row exists for `(today, doseId)`, today is a day that
> dose applies to, and the local time is at or past that dose's **deadline**.
>
> A dose's **deadline** is `max(Settings.workdayEndTime, dueAfter)` — which, because `dueAfter` is
> null for both of the owner's doses and for most doses generally, is normally just
> `Settings.workdayEndTime`.

⚠️ **`workdayEndTime` alone is the wrong rule, and it is the version that looks right.** It marks an
evening dose missed hours before it is due. The `max` is why the deadline is defined as a term rather
than inlined as a field name; *Edge cases* below works through the case that forces it.

The property worth naming explicitly, because it is the whole point: **the same absent row reads
"not recorded yet" at 14:00 and "missed" at 18:00.** Nothing writes anything in between. There is
**no background job, no nightly backfill, no midnight sweep, and no state machine** — the fourth
state is a comparison performed at read time.

Three consequences follow, and all three are the reason to do it this way:

1. **Nothing can be missed by the tracker failing to run.** A backfill job that does not fire leaves
   yesterday looking like "not recorded yet" forever. A derivation cannot fail to fire, because it
   *is* the read.
2. **It is pure, and therefore testable without a clock.** `now` is an injectable parameter with a
   default, exactly as `bucketOfItem(i, now = Date.now())` does it.
3. **Correcting the record needs no special case.** Tapping *Taken* at 19:00 on a dose the strip is
   already showing as missed just writes the row. There is no "un-miss" transition, because `Missed`
   was never a stored value to transition out of.

#### This mirrors an existing doctrine, and the doctrine's known limit is worth inheriting too

`bucketOfItem` (`src/components/inbox/bucket.ts`) derives the *Saved for later* bucket the same way,
with no job:

```ts
return i.snoozedUntil != null && toMs(i.snoozedUntil) > now
  ? "savedLater"
  : "needsReview";
```

**#260 — "Saved for later" is a one-hour snooze, and you cannot park anything indefinitely** records
that reasoning in its own words: *"There is no cron and no job; the bucket is computed."*

**But #260 is open precisely because that design ran out of room, and the lesson transfers.** Its
body: *"Indefinite parking needs a snoozed row whose `snoozedUntil` is absent but still in the
bucket — and today absence means 'in Needs review', because the bucket is derived from the
comparison."* A derived state is cheap and **inexpressive**: it collapses two meanings onto one
absence, and the third meaning has nowhere to go.

Does that bite here? **Not for the states above**, and the reason is structural rather than lucky:
the third meaning a dose could need — *"today is not a day this applies to"* — is answered by
`Medication.days` **before** the derivation runs, so it never has to be encoded in the presence or
absence of a log row. If a future tier needs a fourth meaning per dose (a paused medication, say),
the honest move is a column, not a sentinel.

⚠️ **And #260's explicit warning is adopted as a rule here: do not solve any future gap by writing a
far-future date.** Its words: *"A sentinel like year 9999 makes 'indefinite' indistinguishable from
'a very long snooze' in every query, and it will be read as a real timestamp by something
eventually."*

#### Whose clock — the one question the derivation cannot leave open

`workdayEndTime` is a bare `"HH:mm"` string with no timezone. So "has the workday ended" is
meaningless until you say *whose 17:00*.

**The repo has already answered, and the answer is the user's browser.** `targetTimeToday` in
`src/components/dashboard/roundup-card.tsx` parses the string and applies it to `new Date()` inside a
client `useEffect`. The container clock is UTC, so a server-side comparison would flip the meaning of
the owner's existing setting by an hour for half the year — 17:00 UTC is 18:00 British Summer Time.
Same string, same user, silently different behaviour depending on which module read it.

**So the meds resolver compares in the client's local time**, and the strip is rendered from a
client-known `now`. Two things follow that the implementation must not get wrong:

- **Do not compute `Missed` on the server and send a boolean.** A server-rendered "missed" flag is
  stale the moment the clock crosses, and wrong all summer.
- **`targetTimeToday` is the shape to reuse, including its NaN-safe fallback to 17:00** for a
  malformed `HH:mm`. It is currently private to `roundup-card.tsx`; extracting it is a small, honest
  refactor and the second caller is what justifies it.

There is a cost, stated rather than hidden: `Streak` already computes working days on the **server**
(`isoWeekday(new Date())` in `src/lib/rewards.ts`), so the two features can disagree about which day
it is for a user several hours off UTC. That inconsistency exists today, this document does not widen
it, and fixing it is not in this slice.

#### Edge cases that bound the derived rule — all four checked

**1. A dose whose `dueAfter` is later than `workdayEndTime`.** Real: an evening dose at `21:00` with
a workday ending `17:00`. The naive rule marks it missed four hours *before* it is due, which is
worse than useless — it teaches the user the strip lies.

**This is the case the `max` in the rule above exists for**, and it is recorded here rather than only
as a formula because the naive rule is the one a reader arrives with.

The `max` preserves the owner's regimen exactly — breakfast and lunch are both well before 17:00, so
the deadline is 17:00 for both, and neither dose behaves differently than if `workdayEndTime` were
read alone — while making the evening case correct. **It is still a pure comparison and still needs no
job.**

It is worth noticing *why* the naive version is tempting: `workdayEndTime` is a real field with a
sensible name, and for every dose the owner actually takes it gives the right answer. The defect only
appears for a regimen nobody has entered yet, which is exactly the kind that ships.

**2. A workspace whose `workingDays` is empty.** `parseWorkingDays("")` returns `[]`, so
`workingDays.includes(isoWeekday(now))` is **always false** — measured, recipe below. Every day is a
non-working day, so no dose is ever due, nothing is ever missed, and the strip renders nothing.

**That is fail-closed and correct**, and it is the behaviour to pin in a test rather than a
coincidence to rely on. Note it is also **currently unreachable through the UI**: `workingDays` has
no editor (see *Current state*), so only a direct database edit produces it. It becomes reachable the
moment anything exposes the field, which is one of two reasons v1 does not — see *Configurability*.

**3. A dose taken after the deadline.** Covered by construction: writing the row removes the absence
the derivation reads. No transition, no repair path.

**4. The day rolls over with the app left open.** The strip is keyed on the local `YYYY-MM-DD`, so a
tab open past midnight must re-derive rather than hold yesterday's date.

⚠️ **`roundup-card.tsx` is the precedent for the polling shape but NOT for getting this right, and the
difference is worth reading before copying it.** It polls with `setInterval(tick, 5000)`, but its
`const dayKey = …ymd(new Date())` is computed **once per effect run**, in the effect body outside
`tick` — so a tab left open across midnight goes on using yesterday's key. Reuse the interval; derive
the date **inside** the tick. Worth a test, because the failure is invisible to anyone who reloads,
which is everyone who is looking for it.

### Data model

```prisma
model Medication {
  id          String   @id @default(cuid())
  name        String
  days        String?  // null → inherit Settings.workingDays; else ISO weekdays "1,2,3,4,5"
  active      Boolean  @default(true)
  order       Int
  workspaceId String
  doses       MedicationDose[]
}

model MedicationDose {
  id           String   @id @default(cuid())
  medicationId String
  label        String   // "after breakfast"
  quantity     Int      // 2
  dueAfter     String?  // optional HH:mm — informs the banner, schedules nothing
  order        Int
}

model MedsDoseLog {
  id               String   @id @default(cuid())
  date             String   // YYYY-MM-DD, local to the user
  medicationDoseId String
  state            String   // taken | skipped
  markedAt         DateTime @default(now())
  workspaceId      String

  @@unique([workspaceId, date, medicationDoseId])
}
```

Field lists above are the decisions, not a migration: back-relations, `@relation` clauses,
`onDelete: Cascade` (which every workspace-scoped model in this schema carries) and the read indexes
are omitted for legibility and belong in the implementation MR.

**Full per-dose history is recorded from day one**, even though v1's UI only ever shows today. It
cannot be backfilled if it is skipped, and v2's dashboard is the reason the owner wants it:

> I can see the full per-dose history, and potential per med-type history be interesting data to see
> visualised.

Recording it costs one row per dose per day and nothing else. Not recording it costs the v2 feature
its entire history at launch.

#### Which models carry `workspaceId`, and why it is not all three

`Medication` and `MedsDoseLog` carry it. **`MedicationDose` does not**, following `Step`: it is only
ever reached through its scoped parent as an `include`.
`src/lib/export/__tests__/model-coverage.test.ts` names that exact case — *"`Step` and
`BreakdownTurn` are reached through the scoped `Task` read as an `include`"* — and says widening the
predicate "would demand entries for tables that must not have one".

`MedsDoseLog` needs its own `workspaceId` for a different reason: the today-strip reads it **by date
directly**, without joining through `Medication`, and the scoping harness requires every direct query
to name `workspaceId`.

⚠️ **That denormalisation creates one hole the unique index does not close.** Nothing in
`@@unique([workspaceId, date, medicationDoseId])` stops workspace A's id being paired with workspace
B's `medicationDoseId` — the foreign key proves the dose exists, not that it belongs to the same
workspace. **The write path must filter the dose to the resolved workspace**, which is the
established answer here: `Settings.focusPlaylistIds`' schema comment records the identical reasoning
— *"the write path filters to playlists the resolved workspace actually owns — so a foreign id
cannot be stored even if one is posted."* Cite it, and test it.

#### The unique index makes the write idempotent, which is the point

`@@unique([workspaceId, date, medicationDoseId])` means the log write is an **upsert on a key the
client already knows**. A double-tap on *Taken* — the single most likely interaction on this feature,
by an audience whose defining trait makes it likely — writes one row.

This is deliberately the **opposite** of the failure #257 records for the capture path:
*"`createBrainDumpItem` sends no `clientKey` and the unique index treats nulls as distinct — so the
retry wrote a second row."* Here there is nothing nullable in the key and no client-generated
idempotency token to forget, so the property comes from the schema rather than from a convention.

#### `days` is nullable and inherits `Settings.workingDays`

Null means *"use the workspace's working days"*; a value means *"these days"*. So the owner's
weekday-only regimen is **the default with zero configuration**, while a second medication that runs
every day is `days = "1,2,3,4,5,6,7"`.

The precedent is the repo's own: `Settings.focusTimerStyle String?` is `(nullable → resolve by
voice)`, and `Settings.breakdownModel String?` is `// null = env/default`. In both, null delegates
rather than meaning "unset".

**No CHECK constraint on `days`.** `Settings.workingDays` is the same CSV shape and has none, and a
`CHECK` cannot express "a comma-separated list of ISO weekdays" without a regex that will be wrong
about whitespace. Validation belongs at the write path, and `parseWorkingDays`' existing
filter-to-`1..7` makes a malformed value degrade to "no days" rather than throw — the same
degrade-don't-throw posture `Settings.typeface` documents for an out-of-set value.

#### `dueAfter` is read by exactly two things, and neither of them is a scheduler

1. **The banner**, so it knows whether to mention the lunch dose at 11:00.
2. **The dose's deadline**, via the `max` in the derivation rule — so an evening dose is not marked
   missed before it is due.

**It schedules nothing, fires nothing, and is not a reminder time.** Both readers are pure functions
evaluated when something is rendered; neither one waits for a clock to reach it. Empty means the dose
has no stated time, so the banner says a dose is outstanding without inventing one and the deadline
falls back to `workdayEndTime`.

Keeping it optional is what keeps the meal-relative model honest: a user who thinks in "after
breakfast" is never asked to invent a clock time, and a user who does want one is not blocked.

### The CHECK constraint — yes, and here is the exact obligation

**`MedsDoseLog.state` is a pseudo-enum and gets a CHECK constraint.** The doctrine migration
(`prisma/migrations/20260719171754_add_status_check_constraints/migration.sql`) states the rule and
the naming:

> The allowed value sets live in `src/lib/constants.ts` and are the single source of truth; the CHECK
> constraints below mirror them exactly […] Constraint naming: `"<Table>_<column>_check"`.

So, precisely:

| Thing | Value |
| --- | --- |
| Constraint name | **`MedsDoseLog_state_check`** |
| Constant | **`MedsDoseState`** in `src/lib/constants.ts`, `{ Taken: "taken", Skipped: "skipped" }` |
| SQL | `CHECK ("state" IN ('taken', 'skipped'))` — **no `IS NULL` allowance**, because the column is NOT NULL |
| Registry entry | **`REGISTRY` in `src/lib/enum-constraint-sync.integration.test.ts`**, `nullable: false` |

⚠️ **The convention is dominant but not unanimous, so this needs an argument rather than a citation.**
`Settings.voice` is the closest analogue in shape — a closed two-value set — and it has **no** CHECK.
The discriminator is what an out-of-set value costs. An unrecognised `voice` degrades to the default
register and the user sees slightly plainer copy; `Typeface`'s comment records that exact posture
("an out-of-set value degrades to Figtree"). An unrecognised `state` has **no safe reading**: the
strip would have to decide whether an unknown value means a dose was taken, and both answers are
wrong about a health record. That is what earns the constraint here, and it is why `state` sits with
the 21 rather than with `voice`.

The registry entry is the row a naive implementation drops, and the reason it matters is specific:

⚠️ **The sync test will not catch you if you forget it.** Its "no missing, no strays" assertion
intersects the live constraint list with the registry's own names *before* comparing, so an applied
constraint that was never registered is filtered out and the test passes. A **missing** constraint
for a **registered** entry does fail, and so does a rename. Measured; recipe below.

**The filter is deliberate, not a bug** — `Step_estMinutes_check` and the other range and length
constraints live in sibling registries and would otherwise read as strays in the enum block. What is
inaccurate is the assertion's own comment, which claims a stray fails. That is worth knowing here for
one practical reason: **the registry entry is a review item, because nothing mechanical enforces
it.** The repo has been bitten by exactly this shape before — the note beside `FocusPlaylist_name_check`
records that a migration's comment "asserted the constraint was 'registered in `LENGTH_REGISTRY`'
while `FocusPlaylist` appeared nowhere in this file — so the comment described a safety net that did
not exist."

The contrast with the export and scoping guards is worth stating, because it tells the implementer
where to be careful: those two derive their model list from `Prisma.dmmf` at runtime, so declaring
`workspaceId` **enrols a model automatically and cannot be forgotten**. The CHECK registry is
hand-maintained and **can**.

### Configurability

**`Settings.medsTracker Boolean @default(false)`**, following `Settings.shoppingList` exactly —
including the doctrine its comment states, which is quoted here because it is the reason the default
is `false`:

> OFF by default: the whole point of the switch is that the feature adds no surface for people who
> don't want it, so an existing workspace and a brand-new one both start without it. Plain Boolean,
> like `focusShuffle`: no pseudo-enum, hence no CHECK constraint to mirror in `src/lib/constants.ts`.
> Turning it off HIDES the list, it does not delete it — the rows survive and reappear if it is
> turned back on.

Every clause transfers. **Turning `medsTracker` off hides the strip, the banner and the editor, and
deletes no `MedsDoseLog` row** — which matters more here than for a shopping list, because a
medication history destroyed by a settings toggle is not recoverable and is the one thing v2 needs.

The switch is a **feature gate, not an authorization boundary** — `/shopping`'s page comment makes
that distinction and it holds identically. Whose rows these are is decided by the `workspaceId`
filter the scoping harness polices.

**In v1 settings, users can:** enable or disable the feature; add, rename, reorder and deactivate
medications; and for each, edit an ordered list of doses (label + quantity, and optionally
`dueAfter`).

**Deliberately not configurable in v1**, each with its reason:

| Not configurable | Why |
| --- | --- |
| A clock time per dose as the *primary* model | The owner's regimen is meal-relative. "After breakfast" is not a time, and a required picker invites a false precision — the user would be inventing a number to satisfy a form. `dueAfter` stays optional |
| View selection | There is nothing to select until `/meds` exists. A picker with one option is a control that teaches the user to distrust controls |
| Per-medication reminder settings | Nothing to configure while there is one banner and no notifications. v3 |
| ⚠️ `Settings.workingDays` itself | **Two reasons, and the first is not obvious.** It is read by `src/lib/rewards.ts` to decide which days a **streak** may advance on, so a meds-settings control over it would silently retune an unrelated feature — a user narrowing their meds week to Mon–Wed would find their streak had opinions about it. Second, exposing it makes the empty-CSV case above reachable for the first time. The per-medication `days` override is the configurable surface instead, and it is strictly local |

That last row is a real limitation rather than a tidy answer: a user whose working week genuinely is
not Mon–Fri must set `days` per medication. It is the right v1 trade — one local field beats one
shared field with an invisible second reader — and the fix, if it is ever wanted, is to give
`workingDays` its own editor with the streak coupling stated on screen.

### The reward — reward the LOGGING, never the adherence

The owner's words, because the distinction is the entire design:

> I want to reward the logging, not the taking of the actual dose. So either marking taken or skipped
> should at least give something cute. Instant gratification, no streaks or badges.

**Instant, presentational, and identical in warmth for `taken` and `skipped`.** The reasoning, in
order of how much it would cost to get wrong:

#### 1. Scoring adherence gives the user a reason to log a dose they did not take

The tracker's whole value is that its answer can be **trusted at 11:00 when you genuinely cannot
remember**. Any mechanic that makes honesty cost something destroys the only feature. A user who
loses a streak by pressing *Skipped* has been handed a motive to press *Taken*, and a tracker you
have lied to once is worth less than no tracker — you now have to remember whether you lied.

So: **`Deliberately skipped` must feel exactly as good as `Taken`.** Same warmth, different words,
never a consolation prize.

⚠️ **This is a copy rule with teeth, and it is the one most likely to be quietly broken.** If skip
copy is softer, sadder, more clinical, or shorter than taken copy, the honesty incentive breaks
without anybody deciding to break it. "Logged." for a skip against "Nice one 🎉" for a taken *is* an
adherence score, delivered in tone. **Both voices' copy sets are reviewed as a pair, and a test
asserts equal cardinality** so one set cannot quietly grow.

#### 2. A broken medication streak is not emotionally equivalent to a broken focus streak

`0 day streak` against productivity is a nudge. `0 day streak` against **medication** reads as a
verdict about health and about being a person who cannot manage their own treatment. For the exact
audience this app is for, that is a shame-spiral risk where a dopamine hit was intended.

**No streak means nothing to lose, and that is the point** — not an absence of a feature but the
presence of a property.

#### 3. Points would muddle two signals

`RewardPoints` scores steps, sessions, breakdowns and completions — a **productivity** score. It
should not partly measure whether someone took a pill. Two different questions sharing one number
answers neither.

There is a published position to stay consistent with, too: `/privacy` states plainly that
*"Nothing here makes a decision about you […] There is no scoring of people."* Scoring a health
behaviour is the closest this app could come to contradicting that sentence.

#### 4. The engineering consequence, which is real and load-bearing

No streak, no badge and no points means **no `RewardEvent` row, no `logReward`, no `awardBadge`**
(both exported from `src/lib/rewards.ts` — named as symbols rather than lines, since that file is
under active change on `!339`). The reward is **purely presentational**: a string chosen and
rendered, with nothing persisted and nothing to reconcile.

**So this feature cannot join the throw-after-commit defect class**, which is worth spelling out
because that class is live in this repo today. **#257 — A failed streak touch reports the whole write
failed, over work that is saved** states the rule it violates:

> the `try` governs the WRITE; anything after it is a consequence of success and cannot un-write the
> row.

A meds log write has **no post-commit consequence at all**. There is no second write to fail after
the first has committed, so there is no shape here for that defect to take — not "we were careful",
but "the code the defect lives in does not exist". ⚠️ The shared helper #257 asks for is **not yet on
`main`**: `!339` is open and Draft. This document therefore cites the issue, not a file.

There is a second, smaller consequence: `RewardPoints` is typed
`Record<RewardType, number>`, so a new `RewardType` **cannot** be added without also assigning it a
point value — TypeScript requires the key. There is no "reward event worth nothing" shape available.
The type system agrees with the product decision, which is a good sign about both.

#### 5. The reward must vary, or it stops registering

Habituation to a fixed string is fast, and it is the specific ADHD-relevant failure: a reward you can
predict exactly is not a reward, it is a label. So: **a small rotating set of micro-copy.**

**Rotating, not random**, for three separate reasons — one product, two engineering:

- **Random feels like a slot machine.** Rotation feels like variety; randomness invites the user to
  notice the mechanism, and a repeat two taps apart reads as a bug.
- ⚠️ **`Math.random` in this exact construct mints a recurring SAST finding.**
  `src/lib/pick-one.ts` records the cost: a MEDIUM "cryptographically weak PRNG" finding whose
  fingerprint includes the line number, so one statement in `focus-timer.tsx` was dismissed **five
  separate times** — at lines 638, 675, 683, 731 and 738 — as unrelated edits moved it down the file.
  A deterministic rotation needs no RNG and therefore cannot generate the finding at all. (`pickOne`,
  which uses `crypto.getRandomValues`, is the other correct answer — but it buys randomness this
  design does not want.)
- ⚠️ **A line chosen during a client render is a hydration bug, and this repo has already paid for
  it.** `src/lib/fable-lines.ts` documents it: choosing the line *"in a `useState` initialiser meant
  the server and the client rolled different lines, so every /settings load was a hydration
  mismatch"* — which reset `<html>`'s class list and **silently dropped dark mode on that page**. A
  deterministic rotation keyed on something both sides already know (the local date plus the dose's
  ordinal position) is server/client-stable by construction.

The module shape follows `fable-lines.ts` and `spark.ts`: a plain exported array plus one pure
selector, in its own module, no React import.

#### 6. Reuse the app's existing completion language — do not invent one

Three settings already define what "done" looks and sounds like, and all three are verified above:

- **`Settings.completeTickColor`** (`green | black`) and **`completeStrikethrough`** — the visual
  vocabulary for a completed thing. A dose chip marked *Taken* uses them rather than a new colour.
- **`Settings.voice`** (`plain | playful`) — the register. `src/lib/strings.ts` states the contract:
  plain is *"self-evident labels, no decorative emoji. Functional glyphs only"*; playful is *"same
  labels + flavour emoji"*.

⚠️ **Name the twee risk explicitly, because a rotating cheerful string is the most annoying thing
this feature could ship.** Read two hundred times, warmth becomes noise. Two mitigations, both
structural:

- **Keep the set small.** The repo's own sets are **8** (`FALLBACK_SPARKS`) and **6**
  (`FABLE_LINES`); that is the right order of magnitude, not twenty.
- **Keep `plain` genuinely plain.** "Logged." is a complete and sufficient reward for someone who
  does not want to be congratulated by software, and `plain` is the **default voice**, so it is what
  most reads look like. `playful` can be warmer and carries the emoji.

There is precedent for going further where drift would be harmful: `"action.complete"` is
*deliberately identical* across both voices, so the button cannot drift between surfaces. If review
decides the plain reward should be one fixed word rather than a rotating set, that is a defensible
position with a citation, and it costs nothing to adopt later.

### ⚠️ The today-strip goes on the home page, not on `/dashboard`

The brainstorm said "a today-strip on the dashboard". **This app has two things that word could
mean**, so the choice is made explicitly rather than left to whoever implements it:

- `src/app/(app)/dashboard/page.tsx` is the **stats and rewards** page — spark, streak records,
  badge grid, round-up card. It is a place you go to look back.
- `src/app/(app)/page.tsx` is the **home** page, the inbox, the screen the app opens on.

**The strip belongs on home.** "Did I take my meds" is asked in passing, and an answer behind a
navigation step is an answer you do not get. The precedent is exact: `ShoppingSummaryCard` is the
app's existing at-a-glance card for an optional gated feature, and it renders from
`src/components/inbox/inbox-view.tsx` on the home page — not on `/dashboard`.

`/dashboard` is where the **v2** history visualisation would sit naturally if `/meds` were not
getting its own page. It is not where today's three chips go.

### The banner

**One dismissable banner, and no notification of any kind in v1.**

- It appears only on days the regimen applies, only when at least one dose is unlogged, and only when
  `medsTracker` is on.
- Where `dueAfter` is set, it names the next unlogged dose. Where it is not, it says a dose is
  outstanding without inventing a time.
- **Dismissal is per-day and client-side.** `roundup-card.tsx` establishes the pattern —
  `localStorage.setItem(dayKey, "1")` with `dayKey` built from `ymd(new Date())` — so **no schema
  column is needed** for it. That is the right cost for a control whose whole meaning is "not now, on
  this device, today". `"action.dismiss"` already exists as a string key (`plain: "Dismiss"`,
  `playful: "Not now"`).
- ⚠️ **The strip is gated on `firstRunPreview` as well as on `medsTracker`.**
  `src/app/(app)/page.tsx` suppresses the shopping summary with
  `if (!st.shoppingList || st.firstRunPreview) return null` — a demo workspace showing a medication
  prompt would be a bad first impression and a wrong one.

### a11y

- **Dose chips are interactive controls at the shared 44×44 `touchTarget` floor** — the house
  convention, which is **2.5.5 Target Size (Enhanced), AAA**. The AA criterion is **2.5.8 Target Size
  (Minimum), at 24×24**, and it is met regardless. Getting that pair backwards makes a voluntary
  floor look mandatory and a legitimate 32×32 control look like a regression; `note-field.tsx` states
  it correctly and is the citation to follow.
- **State is never colour alone.** `taken` / `skipped` / `missed` each carry text or a glyph, because
  `completeTickColor` can be set to `black` and a colour-only distinction would vanish.
- **A dose chip's accessible name includes the medication, the dose label and the state** — "Ritalin,
  after breakfast, 2 tablets, taken" — not just "taken". The strip has several chips and a screen
  reader user must not have to infer which one they are on from position.
- **The reward is announced politely, never assertively.** It is a confirmation, not an alert, and an
  assertive region would interrupt whatever the user was reading. The offline-capture spec's *two
  live regions* section is the precedent for that distinction.

### ⚠️ The legal copy — a v1 blocker, not a follow-up

**`/privacy` currently says this app has no health field:**

> There is no health field, no diagnosis field, no questionnaire, and nothing infers anything about
> your health, your mind, or how you are doing. It is a to-do app with a kind tone.

A `MedsDoseLog` row is structured health data about a named medication — special category data under
Article 9 UK GDPR. **Shipping the feature without amending that sentence publishes a statement that
is no longer true**, which is a worse defect than any bug in this document, and it is invisible to
every test in the repo.

The existing notice handles health data **only** in its free-text form, and the difference is exactly
what makes this new: it says *"What I cannot control is what you type into a free-text box […] Where
you choose to include details like that, you are sharing them knowingly and explicitly, and it is
that explicit consent — Article 9(2)(a) UK GDPR — that permits me to hold them."* That reasoning is
about **unstructured, incidental** disclosure. A medication tracker is a **dedicated structured
field**, which is the specific thing the paragraph above it says does not exist.

**The feature gate is what makes this tractable, and it is worth seeing why.** With
`medsTracker` defaulting to `false`, **a workspace that has not opted in genuinely has no health
field** — no row can exist. So the amendment is conditional rather than a retraction: the notice can
say the app has no health field *unless you turn one on*, and describe what happens when you do. The
default-off switch is doing legal work as well as product work.

**v1 checklist items, and the wording itself is the owner's call rather than this document's:**

- [ ] Amend `/privacy`'s *Sensitive information, and a word about ADHD* section: an opt-in medication
      log exists, what it stores, that enabling it is the explicit consent, and that turning it off
      hides rather than deletes
- [ ] Confirm the Article 9(2)(a) basis is stated for the **structured** case, not only the free-text
      one
- [ ] Check the *retention* section still reads true for these tables
- [ ] Re-read `/privacy`'s "no data protection officer" paragraph. It rests on this being neither
      large-scale monitoring nor large-scale special-category processing. **A single opt-in user's
      medication log is plainly not large-scale, so the conclusion stands** — but the sentence should
      be re-read by someone rather than assumed, since the feature moves the app into the category the
      threshold is *about*
- [ ] `/terms`' "medication or dosing" sentence is scoped to **AI suggestions** and needs no change,
      **provided no-AI stays true.** It is a non-goal above for this reason
- [ ] State somewhere the user will see it that the tracker is a **record of what they told it** — not
      a reminder they can rely on, not dosing advice, and not a medical device

### Export coverage — mechanically enforced, and it will red first

`Medication` and `MedsDoseLog` declare `workspaceId`, so `Prisma.dmmf` enrols them in
**`src/lib/export/__tests__/model-coverage.test.ts`** automatically. That guard exists because
`FocusPlaylist` reached `main` absent from all three export files with the suite green, and, in its
words, *"A user exercising UK GDPR Art. 15/20 would have received an archive silently missing a
table."*

So: **`collect.ts` must read both, and `json.ts` must serialise both**, or CI reds before review — a
good outcome, and the reason it is listed here is so it is planned rather than discovered. For
special-category data the omission would be considerably worse than for a playlist.

`MedicationDose` carries no `workspaceId` and is reached via `include`, exactly as `Step` is, so it
falls outside the guard's predicate and is exported as part of its parent.

**Neither new model belongs in `DELIBERATELY_EXCLUDED`.** Both are content the user typed.

## Staging

### v1 — the slice this spec is for

The feature gate; a today-strip on the home page, working days only; one tap per dose to record
`taken` or `skipped`; the dismissable banner; the regimen editor in Settings; **full per-dose history
recorded**; the presentational reward; the privacy amendment; export coverage.

**One implementable slice.** Checked against splitting: the strip cannot ship without the schema, the
schema is not worth shipping without a way to write to it, and the regimen editor is what makes the
schema reachable at all. The privacy amendment is not separable — it is what makes the rest
publishable.

### v2 — its own issue: the `/meds` page

A visual dashboard with per-dose and per-medication history, mirroring how `/shopping` is a gated
optional page — including the server-side `notFound()` gate decided before any query.

**Show the pattern, not a score.** "You miss the lunch dose on Fridays" is information, and
information does not judge. A percentage is a grade. The v1 no-scoring rule is not a v1 limitation to
be relaxed once there is a page to put a number on — it is the product decision, and v2 inherits it.

### v3 — its own issue: notifications

Below.

## Notifications — v3, and the constraint that shapes it

**v1 ships the dismissable banner and nothing else.** A client-delivered notification only fires
while the app is open, so it tells the user something already on screen — a false promise dressed as
a feature. The existing `notifyRoundup` / `notifyAging` / `notifyDailyReview` preferences are
client-delivered only, which the schema comment says and `roundup-card.tsx` demonstrates.

⚠️ **The brainstorm was told there is no server-side scheduler. That was wrong.** A production
CronJob exists — `charts/dlectroflow/templates/purge-cronjob.yaml`, running
`npx tsx prisma/scheduled-purge.ts` on the app image, gated to `production` and
`.Values.purge.enabled`, with its interval in `values.yaml`'s `purge.schedule`.

**But the real constraint is narrower than "a scheduler exists", and it changes the design.** The
production image contains **no `src/`** and no `@/` path alias, so `scheduled-purge.ts` is
deliberately self-contained and imports only `@prisma/client`. `src/lib/scheduled-purge.test.ts`
enforces exactly that, with `expect(packages).toEqual(["@prisma/client"])`.

**Therefore a reminder job cannot import `src/lib/email.ts`.** Copying the mail code into `prisma/`
to satisfy the guard would be the wrong repair — two send paths that must not diverge.

**Recommended shape for v3, as a recommendation and not a v1 decision: CronJob → authenticated POST
to an app route**, which runs inside the app and can use `email.ts` normally.

⚠️ **This is not a novel proposal, and that is the useful part.**
**#159 — `User.purgeAfter` is never honoured — nothing purges a revoked account** already faces the
identical deployment-shape decision, and its scope lists *"an authenticated internal endpoint the
cron calls"* among the options. Its root cause is this same shape on a different surface: a column
written and never read, because the only scheduled job sweeps guest data. **Whichever of the two
lands first should settle the pattern for both** — and this document deliberately does not restate
that issue's analysis or duplicate its scope.

**Email before push**, with the reason: email reaches the user when the app is closed, and
`src/lib/email.ts` already exists — though a reminder needs a **new template function**, since what
is there today is round-up specific. Push needs a subscription store, VAPID keys and a service-worker
path for the same benefit.

⚠️ **A notification is a much stronger promise than a card, and v3 must say so in the legal copy.** A
passive strip records what you told it; a reminder that fails silently is one a user may have relied
on. That belongs in #159's sibling discussion, not left to whoever implements it.

## Testing

TDD, failing test first. The ones that pin decisions rather than mechanics:

1. **`Missed` is derived, at both sides of the boundary.** The *same* absent row reads
   "not recorded" before the deadline and "missed" after it, with `now` injected. One test, two
   assertions, no clock mocking — the property, not two behaviours.
2. **The deadline is `max(workdayEndTime, dueAfter)`.** A dose with `dueAfter: "21:00"` against
   `workdayEndTime: "17:00"` is **not** missed at 18:00. This is the edge case the original rule got
   wrong; without this test the regression is invisible.
3. **Empty `workingDays` yields no due doses and no missed doses.** Pins fail-closed.
4. **A day rollover re-derives**, rather than holding the mounted day's date.
5. **`MedsDoseState` ↔ `MedsDoseLog_state_check`**, via a new `REGISTRY` entry with
   `nullable: false`. ⚠️ Also assert the constraint **rejects** an out-of-set value through raw SQL —
   `enum-constraint-sync` proves the literals match, and the identity-rejection block at the bottom
   of that file is the model for proving it bites.
6. **A double-tap writes one row.** Two concurrent marks of the same `(date, doseId)` produce one
   row, and the second is not an error to the user. ⚠️ **Force a genuine overlap** — a cold connection
   pool serialises the first case in a file, so a passing test may never have raced. Assert the
   overlap happened, not just the row count.
7. **A dose id from another workspace cannot be logged**, even when the caller supplies a valid one.
8. **Turning `medsTracker` off hides everything and deletes nothing** — the history survives the
   round trip. This is the doctrine `shoppingList` states, asserted rather than trusted.
9. **The reward copy sets are equal in size across `taken` and `skipped`, in both voices.** The
   mechanical half of the honesty rule; the tonal half is a review item and cannot be automated.
10. **`plain` reward copy contains no emoji.** `strings.ts` states the contract; this stops the
    rotating set from quietly breaking it.
11. **Rotation is deterministic for a given (date, dose) pair** — the same input gives the same line
    on two calls. Pins the anti-hydration-bug property and the no-`Math.random` decision together.
12. **Dose chips meet the 44×44 floor**, with a control that the assertion can fail.

⚠️ **One thing is not automatable: whether the skip copy feels as good as the taken copy.** It is a
review item on the MR, it is the rule most likely to erode, and no assertion substitutes for reading
both lists side by side.

## Reproducing these numbers

Every figure in this document comes from one of the commands below, run from a checkout with
`origin/main` fetched. A number without a recipe is not evidence, and a figure quoted anywhere other
than these outputs should be re-derived rather than reconciled.

**`workingDays` has no editor surface (0 files), with the control that proves the query runs:**

```sh
git grep -l "workingDays" origin/main -- src/app src/components | wc -l
git grep -l "shoppingList" origin/main -- src/app src/components | wc -l
```

Returns `0` and `19` respectively at `90d97dd`.

**Copy-set sizes (8 and 6):**

```sh
git show origin/main:src/lib/spark.ts | sed -n '/^const FALLBACK_SPARKS = \[/,/^\];/p' | grep -c '^  "'
git show origin/main:src/lib/fable-lines.ts | sed -n '/^export const FABLE_LINES = \[/,/^\];/p' | grep -c '^  "'
```

**`REGISTRY` entry count (21):**

```sh
git show origin/main:src/lib/enum-constraint-sync.integration.test.ts \
  | sed -n '/^const REGISTRY/,/^\];/p' | grep -c '^    constraint:'
```

**`parseWorkingDays("")` returns `[]`** — the function is module-private in `src/lib/rewards.ts`, so
this reproduces its body verbatim:

```js
const parseWorkingDays = (csv) =>
  csv.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n >= 1 && n <= 7);
for (const v of ["1,2,3,4,5", "", "   ", "0,8"]) console.log(JSON.stringify(v), parseWorkingDays(v));
```

`""`, `"   "` and `"0,8"` all yield `[]`; only the default yields `[1,2,3,4,5]`.

**The sync test's stray-versus-missing asymmetry** — this reproduces the assertion's own set logic
and shows it passing with an unregistered constraint present, then failing when a registered one is
absent:

```js
const REGISTRY = [{ constraint: "Settings_typeface_check" }, { constraint: "Workspace_kind_check" }];
const managed = new Set(REGISTRY.map((r) => r.constraint));
const expected = REGISTRY.map((r) => r.constraint).sort();
const run = (dbNames) =>
  JSON.stringify(dbNames.filter((n) => managed.has(n)).sort()) === JSON.stringify(expected);
console.log("unregistered stray present:", run([...expected, "MedsDoseLog_state_check"]));
console.log("registered one missing:", run(["Workspace_kind_check"]));
```

Prints `true` then `false` — the stray passes, the omission fails.

## Considered and declined

| Option | Why not |
| --- | --- |
| Storing `Missed` as a row, written by a nightly job | Needs a scheduler, and the job's failure mode is indistinguishable from "the user has not logged it yet". Every day the job misses is a day of history that silently reads as unknown. The derivation cannot fail to run |
| Deriving `Missed` from the date rolling over instead of `workdayEndTime` | Then a dose is only ever missed retrospectively, and the strip cannot answer "have I missed it?" during the day it is asked on — which is the only question the feature exists to answer |
| Deriving from `workdayEndTime` **alone**, as first briefed | **Wrong for any dose whose `dueAfter` is later**, which it would mark missed hours before it was due. Fixed by `max(workdayEndTime, dueAfter)`. Recorded rather than silently corrected, because the naive rule looks right |
| Computing `Missed` server-side | `workdayEndTime` is already interpreted in the **browser's** clock by `roundup-card.tsx`. A server comparison would shift the owner's existing setting by an hour for half the year, in one feature but not the other |
| A far-future `markedAt` or a year-9999 sentinel for any state | #260's explicit warning: indistinguishable from a real timestamp, and something will eventually read it as one |
| Streaks, badges or points on doses | Creates a motive to lie to the tracker, which destroys its only value; `0 day streak` on medication reads as a verdict about health; and points would make a productivity score partly measure a pill. It would also add the post-commit write this feature is otherwise structurally free of |
| A softer, gentler copy set for `skipped` | **The honesty incentive delivered as tone.** If skipping feels worse than taking, the user learns to press *Taken*. Same warmth, different words |
| `pickOne` (CSPRNG) for the reward line | Correct and available, but it buys **randomness**, which reads as a slot machine and is not server/client-stable. Rotation is deterministic, needs no RNG, and avoids the weak-PRNG SAST class outright |
| `Math.random` for the reward line | Mints a MEDIUM SAST finding whose fingerprint moves with the line number — the cost `src/lib/pick-one.ts` exists to record, having been dismissed five times for one statement |
| A dismissal column for the banner | `roundup-card.tsx`'s per-day `localStorage` key is the right cost for "not now, today, on this device". A schema column would make a transient UI state durable and workspace-wide |
| Clock times per dose as the primary model | Meal-relative regimens have no clock time, and a required picker manufactures precision the user cannot honour |
| A `Settings.workingDays` editor in the meds settings | It is read by `src/lib/rewards.ts` for streaks, so editing it there would retune an unrelated feature invisibly — and it would make the empty-CSV case reachable for the first time |
| `workspaceId` on `MedicationDose` | It is only reached through its scoped parent, exactly as `Step` is through `Task`. Adding it would enrol a table in guards whose own comments say such tables must not have an entry |
| A Prisma `enum` for `state` | The schema avoids them project-wide "so the value sets stay trivially extensible from application code" (doctrine migration). A `String` + CHECK + constant is the house shape |
| Deferring the history to v2 | It cannot be backfilled. The rows not written in v1 are the rows v2's dashboard does not have |
| Shipping before the privacy amendment | Publishes a statement — "there is no health field" — that the release makes untrue. No test can catch it |
| Notifications in v1 | Client-delivered only, so they fire only while the app is open and announce something already on screen |
| Putting the reminder job's mail code in `prisma/` | Satisfies the self-containment guard by creating two send paths that must not diverge. The route-based shape keeps one |

## Related

- **#260 — "Saved for later" is a one-hour snooze, and you cannot park anything indefinitely** — the
  derive-don't-schedule doctrine this design follows, **and** the record of where that doctrine runs
  out of expressiveness. Its sentinel warning is adopted here
- **#257 — A failed streak touch reports the whole write failed, over work that is saved** — the
  defect class a presentational reward keeps this feature clear of. Its helper is in flight on `!339`
- **#159 — `User.purgeAfter` is never honoured — nothing purges a revoked account** — the same
  no-`src/`-in-the-image constraint on a different surface, and it already lists the authenticated-
  endpoint option. Cross-referenced deliberately rather than restated; whichever lands first should
  settle the pattern for both
- **#199** — the shopping-list feature whose gate, hide-not-delete doctrine, optional-page shape and
  export guard this design follows throughout
- **`docs/design/specs/2026-08-11-offline-capture-queue-design.md`** — the live-region and
  announcement conventions the reward and banner follow
