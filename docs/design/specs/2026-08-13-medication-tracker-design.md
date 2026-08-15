# A medication tracker — "did I take my meds", and nothing more than that

Owner brainstorm held 2026-08-13. Every product decision below was settled by the owner in that
session; this document's job is to write them up precisely, check each claim against the tree, and
name the consequences the brainstorm could not have known about.

**Four further decisions were settled on 2026-08-15 and are folded into the sections they belong to,
each marked *settled 2026-08-15*** — the rotating reward set against a single voice, the privacy copy
as a blocker that ships first, the nav-bar control alongside the home strip, and that control's two
modes. They are recorded where they bear on the design rather than in an annex, because an annex is
read once and a section is read every time somebody implements from it.

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

**Two surfaces answer the question, settled 2026-08-15**: a **today-strip on the home page**, which is
the full picture and is always present when the feature is on, and a **control in the nav bar** that
travels with you, in one of two modes the user picks in Settings. The strip being unconditional is what
lets the nav modes be specialised; both are argued in their own sections.

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
| ⚠️ The CHECK/constant pairing is guarded by a test the brainstorm did not know about | **`src/lib/enum-constraint-sync.integration.test.ts`** — a hand-maintained `REGISTRY` of **21 entries**, plus `ARRAY_`, `RANGE_` and `LENGTH_REGISTRY`. It asserts set equality between each constraint's literals and its constant object. **This changes the v1 checklist**; see *The CHECK constraints* |
| ⚠️ That test does **not** catch an unregistered new constraint | **Measured, not assumed.** Its "no missing, no strays" assertion intersects the live constraint list with the registry's own names *before* comparing, so a constraint applied but never registered is filtered out and the test passes. Recipe in *Reproducing these numbers* |
| `DayRollup`, `DailySpark` and `GuestDailyActivity` all use `date String // YYYY-MM-DD` + `@@unique([workspaceId, date])` | ⚠️ **Two of three.** `DayRollup` (`:663`, `:674`) and `DailySpark` (`:723`, `:729`) match exactly. **`GuestDailyActivity` does not**: its column is `day`, not `date` (`:826`), it carries **no `workspaceId` at all**, and its key is `@@id([day, ipHash])`, not a `@@unique`. It is IP-hash scoped global bookkeeping, so the difference is correct rather than sloppy — but it is not a citation for this convention. A third genuine one exists: `Streak.lastActiveWorkday String? // YYYY-MM-DD` (`:693`) |
| `bucketOfItem` derives a bucket from `snoozedUntil > now`, with no cron | **Confirmed.** `src/components/inbox/bucket.ts`, `export function bucketOfItem(i: Item, now: number = Date.now())`. ⚠️ #260's body cites it at `:271`; at `90d97dd` the `export function` line is **`:268`**. Cite the symbol, not the line — advice #257's own body gives ("Name the symbols, not the lines") |
| A production CronJob exists | ⚠️ **Yes — and the brainstorm was told the opposite.** `charts/dlectroflow/templates/purge-cronjob.yaml` declares `CronJob/dlectroflow-guest-purge`, `command: ["npx","tsx","prisma/scheduled-purge.ts"]`, `timeZone: Etc/UTC`, `concurrencyPolicy: Forbid`, rendered only `if and .Values.purge.enabled (eq .Values.env "production")`. The npm script is `purge:scheduled` = `tsx prisma/scheduled-purge.ts`. **The claim "there is no server-side scheduler" was false** and is corrected throughout this document |
| The production image has no `src/`, so that entrypoint is self-contained | **Confirmed twice over.** The chart's own comment calls it "a SELF-CONTAINED entrypoint (imports only @prisma/client, no app source) because the standalone image has no src/", and `src/lib/scheduled-purge.test.ts` enforces it: no `@/` specifier, no `../src`, and `expect(packages).toEqual(["@prisma/client"])` |
| ⚠️ `src/lib/manifest-hygiene.test.ts` is a second guard on that entrypoint | **No — it is unrelated.** It tests `packageNameOf` / `importedPackages`, an import-specifier parser. `docs/CONTRIBUTING.md` describes the `manifest-hygiene` guard as "a root config file imports something `package.json` doesn't declare". `scheduled-purge.test.ts` does **not** import it; it runs its own inline regex scan. The purity guard is that one file alone |
| `src/lib/email.ts` exists | **Confirmed** — exports `emailConfigured()`, `EmailResult`, `sendRoundupEmail()`, `roundupEmailHtml()`; Resend-backed via `RESEND_API_KEY`, imported lazily. ⚠️ It is **round-up specific**: a reminder would reuse the transport and need a new template function, not just a call |
| `src/lib/best-effort.ts` — the #257 helper | ⚠️ **Absent at `90d97dd`** (`git show` exits 128), so the 2026-08-13 pass cited the issue rather than a file. ⚠️ **This row has since expired — see the second pass below**, where it is on `main` |
| `notifyRoundup` / `notifyAging` / `notifyDailyReview` are client-delivered only | **Confirmed on both halves.** The schema comment reads `// Phase 6 — per-type notification preferences (client-delivered only)` (`:164`), and `notifyRoundup` is a field of `RoundupSettings` in `src/components/dashboard/roundup-card.tsx`, a client component that calls `showReminder` from `src/lib/notifications.ts` |
| ⚠️ `workdayEndTime` is compared against **the browser's** clock, not the server's | **This is the most load-bearing row in the table.** `roundup-card.tsx`'s `targetTimeToday(hhmm)` builds `new Date()` and sets hours on it, inside a client `useEffect`. So "17:00" already means *17:00 where the user is*. See *Whose clock* |
| ⚠️ `Settings.workingDays` has **no editor surface anywhere** | Zero hits across `src/app` and `src/components`. **Control: the same query for `shoppingList` returns 19 files**, so the zero is a real absence and not a query that never ran. Its only reader is `src/lib/rewards.ts`. In practice every workspace sits on the default `"1,2,3,4,5"`. Recipe below |
| `parseWorkingDays` / `isoWeekday` are reusable | ⚠️ **No — both are module-private** in `src/lib/rewards.ts` (`:24`, `:28`), not exported. A meds resolver cannot import them as they stand |
| `/shopping` is gated server-side, not just in the menu | **Confirmed.** `src/app/(app)/shopping/page.tsx`: `if (!settings.shoppingList) notFound();`, before any query, with the reasoning in a doc comment — and its server actions carry the same check |
| The repo's touch-target floor, and which criterion it is | **Confirmed, and the pair is easy to invert.** 44×44 is **2.5.5 Target Size (Enhanced), AAA** — a voluntary house floor via the shared `touchTarget` helper. **2.5.8 Target Size (Minimum) is the AA one, at 24×24.** `src/components/breakdown/note-field.tsx:333–338` states it correctly and explains the harm of getting it backwards. ⚠️ Two live citations still have it inverted — `src/components/inbox/add-note-button.{tsx,test.tsx}` call the 44×44 floor "WCAG 2.5.8" — which is out of scope here but worth folding into the next MR that touches that file |
| A small in-repo copy set is an established shape | **Confirmed twice**: `FALLBACK_SPARKS` (**8** lines, `src/lib/spark.ts`) and `FABLE_LINES` (**6** lines, `src/lib/fable-lines.ts`). ⚠️ Both pick **randomly**, via `pickOne`. That difference matters; see *The reward* |
| ⚠️ `/privacy` currently states the app has no health field | **It does, in terms this feature contradicts.** "There is no health field, no diagnosis field, no questionnaire, and nothing infers anything about your health, your mind, or how you are doing." A medication log is a health field. **This is a v1 blocker, not a footnote**; see *The legal copy* — where the second half of that sentence turns out to have been overstated for a reason unrelated to meds |
| ⚠️ `/terms` already names medication | Under *Where being wrong would cost you*: "Do not rely on an AI suggestion for anything with real consequences: **medication or dosing**, legal or tax deadlines, medical appointments…". Scoped to *AI suggestions*, so it is not contradicted — and it is why no-AI is a declared non-goal above rather than an oversight |
| ⚠️ A new workspace-scoped model is auto-enrolled in two guards | `src/lib/export/__tests__/model-coverage.test.ts` and `src/lib/__tests__/scoping.harness.test.ts` both derive their model list from `Prisma.dmmf` **at runtime**, filtered on carrying a `workspaceId` field. So declaring `workspaceId` enrols the model with **no registry entry to forget** — and the export guard will red until `collect.ts` and `json.ts` both name it |
| No medication feature or duplicate issue exists | Zero matches for `medication` in `src/`, `prisma/` or `charts/` other than the `/terms` sentence above. Open-issue search for `medication` returns **0**; `meds` and `pill` return only substring hits (`needs`, `Spotify`, `bulky`) |

### Second pass — verified 2026-08-15 against `origin/main` at `47e015d`

The table above is evidence about `90d97dd` and is left as written. `main` has moved on, and the four
decisions of 2026-08-15 rest on facts the first pass never queried, so those are re-read at the
**named later commit** rather than assumed to have carried over. Same method, same `git show`.

| Claim under test | What the tree says |
| --- | --- |
| ⚠️ `/privacy`'s "no health field" sentence is **still live** | **Confirmed at `47e015d`**, `src/app/privacy/page.tsx:1096–1097`. Two days and ten merges after the first pass, the blocker below has not moved |
| The nav cluster's controls compose `controlSurface` + `touchTarget`, at 44×44 | **Confirmed.** `src/lib/utils.ts` — `touchTarget` is `"inline-flex items-center justify-center min-h-11 min-w-11"`, and `src/components/nav/quick-access.tsx` applies `cn(controlSurface, touchTarget)` to each link. `min-h-11` is `2.75rem` = 44px |
| Those controls are **individually toggleable**, gated on `Settings` columns | **Confirmed, and the pattern is not "one column each".** `focusQuickAccess Boolean @default(true)` (`prisma/schema.prisma:234`) governs the timer icon; the trolley icon is gated on the **feature's own** column, `shoppingList` (`:242`). #252's comment states the discriminator: `/focus` "is not optional, so nothing governed its AVAILABILITY", which is why the icon needed a column of its own, whereas `/shopping` already had one. **That decides the meds column below** |
| ⚠️ `quick-access.tsx` resolves its labels through `t(labelKey, voice)` | **Confirmed** — `const label = t(labelKey, voice)`, used as both `aria-label` and `title`. So a nav control following this pattern takes a `voice` prop, and **#86's voice deletion reaches this file** |
| ⚠️ The owner has decided to **delete the playful voice** | **Confirmed on the item, not inferred.** `#86 — Make the plain/playful voice convention enforceable` carries an *OWNER DECISION, 2026-08-14* section: delete the playful half of every pair, collapse the accessor to a single string, and remove the `Settings.voice` column. #86 cites **this MR** for that column being the schema's one CHECK-less pseudo-enum. It is in **Backlog**, unscheduled — so the deletion has **not** happened, and the sequencing note in *The reward* is why that matters |
| `FALLBACK_SPARKS` is 8 lines and `FABLE_LINES` is 6 | **Confirmed by count at `47e015d`**, unchanged from the first pass. Recipe already in *Reproducing these numbers* |
| ⚠️ A guard polices WCAG number↔name welds, **and it reads `docs/`** | **Confirmed, and this is the row that binds this file.** `src/lib/a11y-class-hygiene.test.ts` drives a `CRITERION_SPEC` table (`2.5.5` → `Target Size`, qualifier `Enhanced`, `AAA`; `2.5.8` → `Target Size`, qualifier `Minimum`, `AA`) and iterates `for (const root of ["src", "e2e", "docs"])` plus four root Markdown files. **An inverted citation in this spec reds the pipeline.** Bare numbers are legal by design — its own comment: *"only a number wearing the wrong name is a defect"* |
| ⚠️ `touchTarget`'s **own docblock** is one of the inverted sites | **Yes**, and it is the one an implementer will read. `src/lib/utils.ts:9–13` welds `2.5.5` to the word *minimum*. `#268 — Three WCAG target-size citations are inverted, and the guard built to catch them cannot see any` owns the sweep. `controlSurface`'s docblock two declarations below it (`:35–41`) states the pair correctly and is the citation to follow instead |
| ⚠️ `format:check` **cannot** gate this file | `.prettierignore` lists `*.md` **and** `docs/`, with the reasoning inline. Measured, not read off the file: appending deliberately mangled Markdown to this spec still gives `npx prettier --check <file>` → *"All matched files use Prettier code style!"*, exit 0, while `--ignore-path /dev/null` on the same bytes reports `[warn]`. **This MR's own description claimed the check passes; that was a zero from a run that matched no files**, and it is corrected there. Recipe below |
| ⚠️ A legal-accuracy sweep of `/privacy` is in flight | **`!357 — Draft: fix(legal): correct ten measured drifts between the legal pages and the code`**, branch `docs/legal-accuracy-sweep`, milestone **v0.7.0**, still Draft on one open owner decision. ⚠️ **It does not touch `/terms`** — its own description records that `/terms`' fingerprint "comes back byte-identical". It does touch `/privacy`, `docs/legal.md`, `src/lib/export/readme.ts`, `/help` and the export code. See *The legal copy* |
| ⚠️ "nothing infers anything about … how you are doing" was **already** overstated | **Confirmed, and by the sweep rather than by this document.** `!357`: *"What was overstated is 'nothing infers anything about how you are doing', because `DayRollup.narrative` is an LLM-written, stored, second-person text about the reader's day. Narrowed, not deleted."* The column is `narrative String?` (`prisma/schema.prisma:669`); `src/lib/rollup.ts`'s `generateTodayRollup` fills it from `getLLM().generate()` for an owner workspace and from a local builder for a guest |
| ⚠️ Amending `/privacy` is a **publication event**, not a copy edit | `src/lib/legal.ts`: `LEGAL_EFFECTIVE_DATE` is *"ONE date [covering] both documents"*, and a fingerprint gate means *"the text cannot move without someone deciding about this date"*. `!357`'s description states the consequence — split across MRs, *"each merge would invalidate the other's recorded hash and the date would move N times for one publication"*. **So the meds amendment is one commit, and it cannot ride alongside `!357`'s** |
| ⚠️ `src/lib/best-effort.ts` is now **on `main`** — the first pass's row has expired | **`!339` merged 2026-08-15 and `#257` is closed.** The helper exists at `47e015d`; its docblock states the rule as *"the `try` governs the WRITE; anything after it is a consequence of success and cannot un-write the row"* and names the three sites that had reached it independently. **This does not change the reward decision** — the argument was never "the helper is missing", it was that a presentational reward has no post-commit step for the defect to live in. It changes only what this document may cite: the file, now, rather than the issue |

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

### The CHECK constraints — yes, twice, and here are the exact obligations

**`MedsDoseLog.state` is a pseudo-enum and gets a CHECK constraint.** The doctrine migration
(`prisma/migrations/20260719171754_add_status_check_constraints/migration.sql`) states the rule and
the naming:

> The allowed value sets live in `src/lib/constants.ts` and are the single source of truth; the CHECK
> constraints below mirror them exactly […] Constraint naming: `"<Table>_<column>_check"`.

So, precisely — **two constraints, because the nav control settled on 2026-08-15 adds a second
pseudo-enum** (`Settings.medsNavMode`, argued in *Configurability*):

| Thing | `MedsDoseLog.state` | `Settings.medsNavMode` |
| --- | --- | --- |
| Constraint name | **`MedsDoseLog_state_check`** | **`Settings_medsNavMode_check`** |
| Constant | **`MedsDoseState`** in `src/lib/constants.ts`, `{ Taken: "taken", Skipped: "skipped" }` | **`MedsNavMode`**, `{ Dots: "dots", Next: "next" }` |
| SQL | `CHECK ("state" IN ('taken', 'skipped'))` — **no `IS NULL` allowance**, because the column is NOT NULL | `CHECK ("medsNavMode" IN ('dots', 'next'))`, likewise NOT NULL with a default |
| Registry entry | **`REGISTRY` in `src/lib/enum-constraint-sync.integration.test.ts`**, `nullable: false` | same registry, `nullable: false` |

⚠️ **The convention is dominant but not unanimous, so `state` needs an argument rather than a
citation.** `Settings.voice` is the closest analogue in shape — a closed two-value set — and it has
**no** CHECK. The discriminator is what an out-of-set value costs. An unrecognised `voice` degrades to
the default register and the user sees slightly plainer copy; `Typeface`'s comment records that exact
posture ("an out-of-set value degrades to Figtree"). An unrecognised `state` has **no safe reading**:
the strip would have to decide whether an unknown value means a dose was taken, and both answers are
wrong about a health record. That is what earns the constraint here, and it is why `state` sits with
the 21 rather than with `voice`.

⚠️ **`medsNavMode` needs the opposite argument, and getting it right matters more than it looks.** An
out-of-set `medsNavMode` *does* have a safe reading — fall back to the default mode — so the
no-safe-reading test above does **not** reach it, and citing that test for both columns would be the
document contradicting itself. It gets a constraint on the plain dominant-convention ground instead:
its two nearest analogues are appearance columns that both have safe readings and both carry one
anyway — `Settings.typeface` (`Settings_typeface_check`) and `Settings.focusTimerStyle`
(`Settings_focusTimerStyle_check`). **The rule is "pseudo-enums get a constraint"; the
no-safe-reading argument is why `state`'s is not negotiable, not why `medsNavMode` has one.**

⚠️ **And the cited exception is on its way out.** `#86`'s owner decision deletes `Settings.voice`
altogether, and its checklist names this MR for the reason — the column is *"the one pseudo-enum on
this schema with **no** CHECK constraint"*. So the exception this section reasons against is being
removed rather than resolved, which **strengthens** the argument above and changes nothing about it.
Do not rewrite this section when that lands; `voice` will be a fact about a past commit, which is
what a citation to `90d97dd` already is.

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

Every clause transfers. **Turning `medsTracker` off hides the strip, the banner, the nav-bar control and
the editor, and deletes no `MedsDoseLog` row** — which matters more here than for a shopping list,
because a medication history destroyed by a settings toggle is not recoverable and is the one thing v2
needs. **The nav control is in that list deliberately**: it is gated on this column and on nothing else,
which is the point argued under `medsNavMode` below.

The switch is a **feature gate, not an authorization boundary** — `/shopping`'s page comment makes
that distinction and it holds identically. Whose rows these are is decided by the `workspaceId`
filter the scoping harness polices.

#### `Settings.medsNavMode` — the nav control's behaviour, settled 2026-08-15

**`Settings.medsNavMode String @default("dots")`**, values `dots` (`B★`) and `next` (`E`), constrained
as *The CHECK constraints* sets out. **`dots` is the default** because the owner chose `B★` as the
default, and the column's default is where that decision lives.

Three things about the shape, each argued rather than asserted:

- **It is a behaviour column, not a visibility column, and the difference decides the count.** The
  nearest precedent pair is `Settings.focusQuickAccess` (does the icon appear?) beside
  `Settings.focusTimerStyle` (how does the thing behave/look?). Meds needs only the second, because
  **`medsTracker` already governs availability** — which is precisely why the trolley icon has no
  column of its own. #252's comment states the discriminator in the other direction: `/focus` *"is not
  optional, so nothing governed its AVAILABILITY"*, and that is the only reason it needed one.
- ⚠️ **So the pill is not independently switchable off in v1, and that is a real limitation rather
  than an oversight.** The trade-off is stated because the header is where it will bite: the right
  cluster already carries up to three controls and meds makes a fourth, with `next` the widest. If the
  owner wants the feature without the header control, the change is **one Boolean beside this column**
  following `focusQuickAccess` exactly — not a redesign. It is not added pre-emptively because #252's
  criterion for adding one is *the owner asked*, and no such ask exists; inventing the column would be
  inventing the decision.
- **Not nullable.** A `String?` where null meant "hidden" would collapse a visibility meaning and a
  behaviour meaning onto one column — the same inexpressiveness #260 records and this document already
  refuses for dose states. Nullable in this schema means **delegate**, per `focusTimerStyle` and
  `breakdownModel`, and there is nothing here to delegate to.

**In v1 settings, users can:** enable or disable the feature; add, rename, reorder and deactivate
medications; for each, edit an ordered list of doses (label + quantity, and optionally `dueAfter`);
and **choose the nav control's mode**.

⚠️ **The mode picker needs an explainer per option, not two bare names.** The modes differ in
*behaviour*, not appearance, and a name alone cannot convey "this one asks you to remember which dose
is next". The copy says what each does in the terms of the choice being made, and it is where `E`'s
screen-reader recommendation lives — as words, since nothing can detect the need.

**Deliberately not configurable in v1**, each with its reason:

| Not configurable | Why |
| --- | --- |
| A clock time per dose as the *primary* model | The owner's regimen is meal-relative. "After breakfast" is not a time, and a required picker invites a false precision — the user would be inventing a number to satisfy a form. `dueAfter` stays optional |
| **Which page** the history is viewed on | There is nothing to select until `/meds` exists. A picker with one option is a control that teaches the user to distrust controls. ⚠️ **Distinct from `medsNavMode` above**, which selects a *behaviour* of the header control and has two genuine options on day one — this row is about choosing a destination, and there is only one |
| Whether the nav control appears at all | See `medsNavMode`'s **second** bullet: `medsTracker` governs availability, and a separate visibility Boolean would need an owner decision that has not been taken |
| The order `B★` cycles through states | Real, and declined for v1 rather than dismissed: if skipping is the common case, one tap should be *skipped*. It costs another column plus a branch inside `dots`, for a preference nobody has expressed yet — and the mode picker already serves that user, because `next` is symmetric and has no order to get wrong |
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
adherence score, delivered in tone. **The two copy sets are reviewed as a pair, and a test asserts
equal cardinality** so one set cannot quietly grow.

**This rule is unchanged by anything settled on 2026-08-15, and it is the constraint the rotating set
in §5 has to satisfy.** It is stated here rather than only in the test list because it is the one
thing in this document that a reviewer, not a pipeline, has to hold.

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
(both exported from `src/lib/rewards.ts`, named as symbols rather than lines). The reward is **purely
presentational**: a string chosen and rendered, with nothing persisted and nothing to reconcile.

**So this feature cannot join the throw-after-commit defect class.** **#257 — A failed streak touch
reports the whole write failed, over work that is saved** states the rule it violates:

> the `try` governs the WRITE; anything after it is a consequence of success and cannot un-write the
> row.

A meds log write has **no post-commit consequence at all**. There is no second write to fail after
the first has committed, so there is no shape here for that defect to take — not "we were careful",
but "the code the defect lives in does not exist".

⚠️ **Updated 2026-08-15: that class is no longer live — `#257` closed and `!339` merged**, so
`src/lib/best-effort.ts` is on `main` and this document may name the file rather than the issue.
Nothing about the decision moves, because the argument never rested on the helper's absence. What
does move is the **advice to an implementer**: there is now a shared `bestEffort` to reach for if a
later tier ever grows a post-commit step, and the honest instruction is *reach for it then, and not
before* — wrapping a call that has nothing after it would be cargo-cult, and its docblock names the
three sites that earned it.

There is a second, smaller consequence: `RewardPoints` is typed
`Record<RewardType, number>`, so a new `RewardType` **cannot** be added without also assigning it a
point value — TypeScript requires the key. There is no "reward event worth nothing" shape available.
The type system agrees with the product decision, which is a good sign about both.

#### 5. The reward must vary, or it stops registering — **settled 2026-08-15: a small rotating set, not one fixed word**

Habituation to a fixed string is fast, and it is the specific ADHD-relevant failure: a reward you can
predict exactly is not a reward, it is a label. So: **a small rotating set of micro-copy.**

**The owner settled this on 2026-08-15, and it settles it in the direction §6 below used to leave
open.** An earlier draft of this section reasoned about the reward across two registers and floated
one fixed word as the plainer option; **§6 records why that framing has expired.** With one register
left, the register cannot supply the variety, so the set does.

**How small: sized like the repo's own sets, which are 8 and 6 — not twenty.** `FALLBACK_SPARKS`
(`src/lib/spark.ts`) is **8** lines and `FABLE_LINES` (`src/lib/fable-lines.ts`) is **6**, both
re-counted at `47e015d`; the recipe is in *Reproducing these numbers*. Two sets are needed here, one
for `taken` and one for `skipped`, and **they must be equal in size** — that is §1's honesty rule
expressed as a number, and the one half of it a test can hold.

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

⚠️ **One further constraint on the lines themselves, from the nav control settled the same day: each
must be short enough to sit inside a single spoken announcement.** The reward is not announced
separately — see *Where this collides with the reward* — so a line that reads well on a chip but drags as
the tail of a sentence heard on every dose is the wrong line. Keep them to a few words.

#### 6. ⚠️ The two-voice framing has expired — there is one register, and it carries the variety

**This section used to weigh a `plain` reward against a `playful` one and lean toward `plain` being
one fixed word.** That reasoning is stale as of the owner's decision of 2026-08-14, and the correction
is recorded rather than quietly deleted, because the deleted version is the one a reader arrives with
if they have read an earlier draft.

**`#86 — Make the plain/playful voice convention enforceable` carries the decision: the playful voice
is deleted entirely.** Its own words — *"Remove the `playful` half of every `{plain, playful}` pair in
`src/lib/strings.ts` and collapse the accessor so callers take a single string"*, and remove the
`Settings.voice` column with it. So:

- **There is no second register to be plainer than.** "Keep `plain` genuinely plain" was a
  *contrastive* instruction: it made sense only against a warmer sibling that carried the emoji. With
  one voice, following it literally would leave the reward as bare as `Logged.` while nothing anywhere
  else supplies the warmth the owner asked for — *"should at least give something cute"*.
- **So the variety moves from the register to the set.** One register, a rotating set of the size §5
  names. That is the whole of the decision.
- **`"action.complete"`'s identical-across-voices precedent no longer says anything here.** It was a
  citation about two voices agreeing. It survives as a fact about the current tree and dies with the
  deletion, so it is not load-bearing for this design and is dropped rather than restated.

⚠️ **Name the twee risk explicitly, because a rotating cheerful string is the most annoying thing
this feature could ship.** Read two hundred times, warmth becomes noise. With the register no longer
available as a mitigation, **the set's size is the only structural one left** — hence §5's 8-and-6
ceiling, and hence the reviewer-held rule in §1. A twenty-line set is not more varied, it is more
places for one bad line to hide.

**What does still transfer from the existing completion language:**

- **`Settings.completeTickColor`** (`green | black`) and **`completeStrikethrough`** — the visual
  vocabulary for a completed thing. A dose chip marked *Taken* uses them rather than a new colour.
  Neither is touched by #86.
- **The emoji rule survives the deletion, and #86 says so**: *"Keep the existing emoji guard. It
  polices the *plain* voice being emoji-free, which is still a live rule with one voice."* So the
  reward set carries **no decorative emoji** — the same contract `src/lib/strings.ts` states as
  *"self-evident labels, no decorative emoji. Functional glyphs only"*.

#### 6a. ⚠️ Sequencing against #86, because it is unscheduled and this feature is not blocked on it

`#86` sits in **Backlog** with no milestone, and its stated move-back condition is *"whenever an MR is
already editing `strings.ts` broadly"* — which a meds feature adding a handful of keys is not. **So
meds may well ship while `strings.ts` still holds pairs**, and the design must not deadlock on that.

It does not, and the reason is structural rather than lucky:

- **The reward set is its own module and never goes through `t()` at all.** §5's module shape is
  `fable-lines.ts` and `spark.ts` — a plain exported array plus one pure selector. `FABLE_LINES` is
  already a flat array with no voice pairing, so the reward is voice-free by construction and needs
  nothing from #86 in either order.
- **Everything that is a *label* does go through `t()`** — the chips, the banner, the nav control's
  accessible names, and the mode picker's per-option explainer copy in Settings. Those keys take
  whatever shape `strings.ts` has on the day they are written, and #86 sweeps them with everything
  else. Writing a pair that #86 later collapses costs one line in that sweep; the reverse — waiting for
  #86 — costs the feature.
- ⚠️ **One file the meds work touches is a `t(key, voice)` caller and needs naming:**
  `src/components/nav/quick-access.tsx` resolves `const label = t(labelKey, voice)` and receives
  `voice` as a prop. The nav control below follows that pattern, so **#86's collapse reaches this
  feature's nav code** as well as its own. Not a blocker in either direction; a line in #86's sweep.

### ⚠️ The today-strip goes on the home page, not on `/dashboard` — **accepted as written, 2026-08-15**

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
getting its own page. It is not where today's dose chips go.

⚠️ **Corrected 2026-08-15: this sentence said "today's three chips".** The owner's regimen is **two
doses** — 2 tablets after breakfast, 1 after lunch — and the strip renders one chip **per dose**, not per
tablet. Three is the tablet count, and a spec that miscounts the chips in the feature it is specifying
would be copied. The regimen is configurable anyway, so no number belongs in that sentence.

**The owner accepted this argument unchanged on 2026-08-15.** It is not reopened below and the section
is left as it was written. What the same decision *added* is a second surface, which this document did
not cover at all.

### The nav-bar control — settled 2026-08-15, and it is an addition rather than an alternative

**The header gets a meds control as well.** The home strip is asked-and-answered in one glance, but
only while you are on home; the header travels with you. So both, and the relationship between them is
the load-bearing part:

⚠️ **Neither nav mode may be the only route to logging a dose.** The home strip is always present when
the feature is on, and that is what makes the function reachable regardless of which mode is selected —
which is the thing WCAG asks for. A mode is a **shortcut**, and a shortcut is allowed to be
specialised in a way a sole route is not. Every trade-off below is affordable only because of this
sentence, so it is stated first rather than as a mitigation at the end.

Mockups for both modes are at `_reports/2026-08-15-meds-pill-mockups.html`, built on the real tokens
and the real 44×44 control surface, and each panel carries its own trade-offs. That file is the source
of truth for the two designs; this section is the source of truth for the decision about them.

#### `B★` — the default: two dots, one tap, immediate commit, persistent Undo

- **Two dots, one per dose**, in a single header slot. One tap marks the next unrecorded dose *taken*;
  a second tap on the same dose turns that into *skipped*.
- **The press commits immediately.** There is no pending window and no timed write.
- **A persistent, focusable `Undo` appears beside it** and stays until the next action — *not* a toast
  that vanishes. That distinction is the whole reason this shape is viable: a disappearing undo is
  reachable only by a fast sighted user, whereas a control that persists is reachable by keyboard and
  by a screen reader.
- **Chosen for being the most compact and the fewest taps for the common case**, which is the
  property the feature exists for.

⚠️ **Its costs, recorded because they are the reason there are two modes at all.** A reader who meets
only the default will eventually delete the other one as redundant:

- **It asks you to hold state in your head** — which dose is next, and what state that dose is
  currently in. Two dots you cannot see is two facts you have to remember.
- **It is asymmetric: *skipped* is two presses where *taken* is one.** Defensible, and *not* a
  violation of §1's honesty rule — a press is not a reward, and reaching *skipped* satisfies the
  control exactly as fully as reaching *taken*, with equal visual weight (one filled dot, one hatched)
  and no nagging afterwards. But it is a real asymmetry and it is not pretended away.
- **Its accessible name must state the next action, not just the current state.** "…after breakfast, 2
  tablets, not recorded. Activate to mark taken." A control whose meaning changes per press is
  otherwise unannounceable, and this is the specific fix for that.
- **Every commit must announce through a live region**, politely — see *a11y*.

#### `E` — the alternative: the next unrecorded dose, tick or cross

- **Shows only the next unrecorded dose**, labelled, with **two one-tap choices** — a tick and a
  cross — then **advances itself** to the following dose and re-announces the new target.
- **No timing, and nothing to remember.** The control tells you which dose it is about instead of
  asking you to know.
- **Both choices are identical in weight**: two adjacent buttons of the same size in a labelled group,
  so there is no "first" action to bias toward. This is the cleanest possible expression of §1.
- **Regimen-agnostic**: three doses or one, the control is the same width, because it only ever shows
  the next one.
- **Native semantics, nothing invented** — two ordinary buttons in a group whose label names the dose,
  so each button's own name is complete on its own.

⚠️ **Its costs:**

- **It is the widest of the one-tap options** — a label plus two 44×44 targets. The header's right
  cluster already carries up to three of these (focus timer, shopping list, dark mode), which
  `controlSurface`'s docblock states, so meds makes a fourth and `E` makes that fourth the widest. On a
  narrow phone the label may have to shorten to a glyph.
- **It shows only the next dose, so the count is implicit.** You cannot tell at a glance that lunch is
  outstanding while breakfast is unrecorded. **The home strip remains the full picture** — the same
  sentence that makes the mode safe also makes this cost affordable.

#### ⚠️ `E` is recommended for screen-reader users, and that recommendation cannot be automated

**There is no browser API and no media query that reveals assistive technology**, and probing for one
is an anti-pattern. So `E` **cannot** auto-select, and nothing in the implementation may branch on a
guess about it.

It is therefore a **stated recommendation in the Settings copy** — words the user reads and acts on —
and nothing more than that. Combined with the always-present home strip, that is what actually
guarantees the function is reachable; a detection heuristic would be both impossible and unnecessary.

#### The control surface, and the citation to copy

The new control **composes `controlSurface` + `touchTarget` from `src/lib/utils.ts`, giving 44×44**
(`min-h-11 min-w-11` = `2.75rem`), exactly as each existing quick-access link does with
`cn(controlSurface, touchTarget)`. Not a new class string: `controlSurface`'s own docblock explains
that the cluster's controls "have to read as ONE set of controls" and that #117 exists because two of
a set kept private copies.

⚠️ **The citation to copy is `controlSurface`'s docblock, not `touchTarget`'s.** 44×44 is
**2.5.5 Target Size (Enhanced), AAA** — a voluntary house floor. The AA criterion is
**2.5.8 Target Size (Minimum), at 24×24**, which is met regardless. `touchTarget`'s own docblock welds
the first number to the word *minimum* and is one of the sites `#268` sweeps, so it is the wrong
neighbour to read even though it sits directly above the constant. `src/components/breakdown/note-field.tsx`
and `controlSurface` both state the pair correctly.

**Why this matters mechanically and not only pedantically:** `src/lib/a11y-class-hygiene.test.ts`
polices number↔name welds and iterates `["src", "e2e", "docs"]`, so an inverted citation in the
implementation *or in this file* reds the pipeline. Bare numbers are deliberately legal there; only a
number wearing the wrong name is a defect.

#### ⚠️ Where this collides with the reward, and the answer both decisions force

**Two decisions of 2026-08-15 meet on one press, and neither section alone resolves it.** *The reward*
requires an instant presentational reward on every log, announced politely. This section requires every
nav commit to announce politely too. Naively implemented that is **two polite messages for one press** —
and in `E`'s case a *delayed second* announcement, which is precisely the cost the timed variant of `B★`
was rejected for. Shipping the rejected defect through a different door would be a poor outcome.

**So: one announcement per press, and the reward line rides inside it.** "After breakfast, 2 tablets,
taken. Logged and counted." — dose, state, reward, what remains, in one polite utterance. This is a
consequence of the two decisions rather than a third decision, and it is written down because an
implementer working from either section in isolation would produce the other thing.

Three corollaries worth stating, since they are the parts that go wrong:

- **The reward's *visual* half still fires wherever the log happened** — the dots or the split pill can
  animate, and the home strip's chip can too. Only the *announcement* is single.
- **The reward copy must therefore be short enough to sit inside an announcement.** That is an
  additional constraint on the rotating set that §5 does not impose on its own: a line that reads well
  on a chip may be intolerable as the tail of a spoken sentence heard on every dose. It belongs in the
  same review pass as the honesty rule.
- **Two presses that are not a log get no reward: `Undo`, and an overwrite.** Undo is a correction, and
  congratulating someone for retracting a record is the one place a cheerful line would read as
  sarcasm. An overwrite — *skipped* → *taken* on the strip — is also a correction rather than a new log,
  and rewarding it would make repeated tapping a way to farm the reward. Both still **announce** the
  new state, since that is information; they just do not carry a reward line.

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
  `playful: "Not now"`). ⚠️ **The pair is quoted as it stands today; `#86` deletes the `playful` half**,
  so the key survives and reduces to `"Dismiss"`. Reuse the key either way rather than adding one.
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

#### The nav control's a11y obligations — settled 2026-08-15, and they differ per mode

The two modes fail differently, so a single checklist would be wrong for both. What is shared:

- **44×44 via `controlSurface` + `touchTarget`**, per the citation note above — **2.5.5 Target Size
  (Enhanced), AAA**, with **2.5.8 Target Size (Minimum), at 24×24** met regardless.
- **State is never colour alone**, as for the chips: `taken`, `skipped` and `missed` each carry a shape
  or a glyph difference, because `completeTickColor` can be set to `black`.
- **Every commit announces politely**, through the same polite live region the reward uses. **One press,
  one announcement**, naming the dose, the new state, the reward and what remains — the reward does
  **not** get a second utterance. Argued in *Where this collides with the reward*, and pinned by test 20,
  which asserts the announcement *count* rather than its content.
- **The home strip is the accessible route**, always present. Neither mode is load-bearing for
  conformance, which is what makes the per-mode compromises below legitimate rather than excuses.

`B★` specifically, because a cycling control is the harder case:

- **The accessible name states the next action as well as the current state.** Not "taken" but "after
  breakfast, 2 tablets, not recorded. Activate to mark taken." A name that reports only the current
  state leaves a screen-reader user unable to predict what activating does. ⚠️ **That is the defect
  which disqualified the *plain* cycling pill** — the mockup's `B`, whose whole objection was that a
  control changing meaning per press cannot state its name in advance. It is a different objection from
  the one that disqualified the *timed* variant, which was the time limit and the delayed second
  announcement. `B★` has to answer both, and this bullet is the first half.
- **The name is recomputed on every commit**, since the target dose advances.
- **`Undo` is a real focusable control in the tab order**, not a toast. It persists until the next
  action. This is the requirement, not an enhancement — the mode is only acceptable *because* the
  correction path is reachable without a mouse and without a time limit.
- **No press may be silently destructive.** Tapping past *skipped* must not wrap round to *not
  recorded*: erasing a health record on the fourth tap of a two-dot shortcut is not something anyone
  chose to do.

⚠️ **What follows from that, stated because it is a real v1 limitation rather than a detail.** With the
cycle terminating at *skipped*, the routes available after a commit are:

| Correction wanted | Route in v1 |
| --- | --- |
| *taken* → *skipped* | The pill's second press, or the strip. |
| *skipped* → *taken* | **The strip**, not the pill. The write is an upsert on `(workspaceId, date, medicationDoseId)`, so tapping *Taken* on an already-skipped dose overwrites the row — no repair path and no special case, exactly as *the unique index makes the write idempotent* sets out. |
| Undoing the press you just made | `B★`'s persistent Undo, for one commit. |
| Back to **Unknown** — no row at all | ⚠️ **Not available in either surface in v1.** Nothing deletes a `MedsDoseLog` row. |

That last row is deliberate and not an oversight. A delete path is the one write that destroys history,
which is the thing v2 needs and cannot backfill, and *"I logged something and now want the record
gone"* is not a case the owner has raised. **If it is ever wanted it belongs on the strip with a
confirmation**, never on a nav shortcut, and it should be argued in its own right rather than arriving
as a side-effect of a cycle order. The Undo covers the realistic mistake, which is the press you just
made.

`E` specifically:

- **Two ordinary buttons inside a group whose accessible name names the dose**, and **each button's own
  name is complete on its own** — "Mark after breakfast, 2 tablets, as taken" — because a group label
  is not guaranteed to be read in every mode of every screen reader.
- **After a log, the announcement names the result and the new target** — "…marked taken. Next: after
  lunch, 1 tablet." That is what replaces the memory `B★` requires.
- **When nothing is left to log, the two buttons go away** rather than sitting inert, and the group's
  name says so.

⚠️ **Nothing detects assistive technology.** Repeated here because it is the requirement most likely to
be "improved" by a well-meaning implementation: no `matchMedia` probe, no focus-behaviour heuristic, no
`aria-*` sniffing. The recommendation lives in Settings copy.

### ⚠️ The legal copy — a v1 blocker that ships BEFORE the feature (confirmed 2026-08-15)

**Settled 2026-08-15: the amendment is not a companion change to the feature, it lands first.** This
section already argued the blocker and the argument is unchanged; what follows adds what has happened
since, because two of the four things it rests on have moved.

**`/privacy` still says this app has no health field — verified live on `main` at `47e015d`**,
`src/app/privacy/page.tsx:1096–1097`, two days and ten merges after the first pass:

> There is no health field, no diagnosis field, no questionnaire, and nothing infers anything about
> your health, your mind, or how you are doing. It is a to-do app with a kind tone.

A `MedsDoseLog` row is structured health data about a named medication — special category data under
Article 9 UK GDPR. **Shipping the feature without amending that sentence publishes a statement that
is no longer true**, which is a worse defect than any bug in this document, and it is invisible to
every test in the repo.

#### What has changed since 2026-08-13 — and it does not make the amendment smaller

⚠️ **A legal-accuracy sweep of `/privacy` is in flight**: `!357 — Draft: fix(legal): correct ten
measured drifts between the legal pages and the code`, milestone v0.7.0. It is tempting to conclude
that part of this checklist is being done anyway. **Read against `!357`'s actual scope, that conclusion
does not hold in the direction that matters, and the honest reading is: the surgery on one sentence is
being done for us, and the amendment gains three surfaces and loses its stated legal basis.**

- **In flight, not done — the sentence's second half is being narrowed for a reason that has nothing
  to do with meds.** (`!357` is Draft; this is its recorded finding, not a landed change.) `!357` found *"nothing infers anything about … how you are doing"* was **already overstated
  before any medication work**, because `DayRollup.narrative` is an LLM-written, stored, second-person
  text about the reader's day, written automatically at `workdayEndTime` rather than opt-in. So the
  clause is being *narrowed, not deleted* — which means the meds amendment edits a sentence that is
  already in motion, and must be written against `!357`'s text rather than against what is on `main`
  today.
- ⚠️ **The Article 9(2)(a) basis this section leaned on has been withdrawn.** `!357`'s F5 removes the
  explicit-consent claim outright — its own summary: *"There is no gate, no acknowledgement and no
  warning anywhere in `src/`; the only hits were the page's own prose."* **So the checklist item that
  said "confirm the Art. 9(2)(a) basis is stated for the structured case" is now wrong as written**,
  because there is no such basis on the page to extend. `!357` is Draft precisely on that open
  question, and it is the owner's to answer.
- ⚠️ **This actually strengthens the blocker rather than weakening it.** A structured, deliberate
  health field is a much better fit for consent than incidental free text ever was — the toggle is a
  real affirmative act — but a basis that has just been withdrawn as unsupported cannot be re-asserted
  for a new field without the mechanism `!357` says does not exist.
- ⚠️ **Three surfaces this section never named now move together.** `!357` records that `/privacy`,
  `src/lib/export/readme.ts` and `src/app/(app)/help/page.tsx` are one disclosure read in three places,
  with `docs/legal.md` recording that they move together. The `/help` page's *"two things are
  deliberately left out"* was *"true when written, an undercount the moment this shipped"* — the exact
  failure mode this amendment must not repeat.
- ⚠️ **`/terms` is untouched by `!357`** — its recorded fingerprint *"comes back byte-identical"* — so
  the `/terms` checklist item below is unaffected and stands as written.
- ⚠️ **`!357` deliberately says nothing about medication:** *"Nothing about medication tracking reaches
  these pages. It is designed and unbuilt, and disclosing it early would be its own inaccuracy."*
  **So none of this checklist is done by `!357`.** It changes the text to amend, not the work.

#### ⚠️ The amendment is one commit, because a publication event cannot be split

`src/lib/legal.ts` holds a single `LEGAL_EFFECTIVE_DATE` — *"ONE date [covering] both documents"* — and
a fingerprint gate whose purpose is that *"the text cannot move without someone deciding about this
date"*. `!357`'s description states the consequence of ignoring that: split across MRs, *"each merge
would invalidate the other's recorded hash and the date would move N times for one publication"*.

Two things follow, and they are sequencing constraints rather than preferences:

1. **The meds amendment is its own single commit**, moving the date once and re-recording the
   fingerprints in the same commit.
2. **It cannot ride alongside `!357`.** One of the two lands first and the other rebases onto it. Since
   `!357` is open on an owner decision and this feature is unbuilt, `!357` going first is the natural
   order — and it is the cheaper one, because writing the meds clause against `!357`'s narrowed health
   paragraph is one edit, whereas writing it against today's text means writing it twice.

The existing notice handles health data **only** in its free-text form, and the difference is exactly
what makes this new: it says *"What I cannot control is what you type into a free-text box […] Where
you choose to include details like that, you are sharing them knowingly and explicitly, and it is
that explicit consent — Article 9(2)(a) UK GDPR — that permits me to hold them."* That reasoning is
about **unstructured, incidental** disclosure. A medication tracker is a **dedicated structured
field**, which is the specific thing the paragraph above it says does not exist.

⚠️ **That quotation is `main`'s text and `!357` deletes its second half.** It is left in place because
the *contrast* it draws — incidental free text versus a dedicated field — is the argument, and that
argument survives the deletion intact. What does not survive is the legal basis; see below.

**The feature gate is what makes this tractable, and it is worth seeing why.** With
`medsTracker` defaulting to `false`, **a workspace that has not opted in genuinely has no health
field** — no row can exist. So the amendment is conditional rather than a retraction: the notice can
say the app has no health field *unless you turn one on*, and describe what happens when you do. The
default-off switch is doing legal work as well as product work.

**v1 checklist items, revised 2026-08-15 against `!357`'s scope. The wording itself is the owner's call
rather than this document's, and the Article 9 item is now a decision rather than a check:**

- [ ] Amend `/privacy`'s *Sensitive information, and a word about ADHD* section: an opt-in medication
      log exists, what it stores, and that turning it off hides rather than deletes. **Write it against
      `!357`'s narrowed health paragraph, not against `main`'s** — see above
- [ ] ⚠️ **Decide the Article 9 position for the structured case.** This replaces the earlier item,
      which asked to confirm an Art. 9(2)(a) basis that `!357` has since withdrawn as unsupported.
      A deliberate opt-in toggle is a far better candidate for explicit consent than incidental free
      text was — but **asserting it requires the acknowledgement mechanism `!357` found does not
      exist**, so the choice is *build the mechanism and claim consent*, or *state a position that needs
      none*. Owner's call, and it is the same open question `!357` is Draft on
- [ ] Check the *retention* section still reads true for these tables. ⚠️ **`!357`'s F2 rewrites it** —
      it now says the final deletion is a hand operation — so this item reads against the new text
- [ ] Re-read `/privacy`'s "no data protection officer" paragraph. It rests on this being neither
      large-scale monitoring nor large-scale special-category processing. **A single opt-in user's
      medication log is plainly not large-scale, so the conclusion stands** — but the sentence should
      be re-read by someone rather than assumed, since the feature moves the app into the category the
      threshold is *about*
- [ ] `/terms`' "medication or dosing" sentence is scoped to **AI suggestions** and needs no change,
      **provided no-AI stays true.** It is a non-goal above for this reason. Unaffected by `!357`, which
      leaves `/terms` byte-identical
- [ ] ⚠️ **Amend the other two surfaces in the same commit** — `src/lib/export/readme.ts` and
      `src/app/(app)/help/page.tsx`. `docs/legal.md` records that all three move together, and `/help`'s
      undercount is the precedent for what happens when one is forgotten
- [ ] ⚠️ **Add the meds tables to `docs/legal.md`'s *The four places text is sent to the LLM* section as
      a stated absence** — a medication row never reaches a prompt. That is what turns the *any AI
      involvement, ever* non-goal into a documented property rather than an intention, and it is the
      section `!357`'s F10 had to correct for omitting `Task.notes` in two places
- [ ] Move `LEGAL_EFFECTIVE_DATE` **once**, and re-record both page fingerprints in the same commit
- [ ] State somewhere the user will see it that the tracker is a **record of what they told it** — not
      a reminder they can rely on, not dosing advice, and not a medical device

### Export coverage — mechanically enforced, and it will red first

`Medication` and `MedsDoseLog` declare `workspaceId`, so `Prisma.dmmf` enrols them in
**`src/lib/export/__tests__/model-coverage.test.ts`** automatically. That guard exists because
`FocusPlaylist` reached `main` absent from all three export files with the suite green, and, in its
words, *"A user exercising UK GDPR Art. 15/20 would have received an archive silently missing a
table."*

So: **three files, not two** — ⚠️ corrected 2026-08-15, having been written as two. At `47e015d` the
guard asserts `read("collect.ts")` contains `prisma.<model>.`, that the model is **mentioned in
`types.ts`**, and that `json.ts` serialises it. Miss any one and CI reds before review — a good
outcome, and the reason it is listed here is so it is planned rather than discovered. For
special-category data the omission would be considerably worse than for a playlist.

⚠️ **And that guard is being widened while this spec sits open.** `!357` extends its predicate from
"declares `workspaceId`" to "has a relation to `User`", adds a `VIA_PINNED_MODULE` registry for models
the scoping harness confines to one module, and adds a **column-grain** check on `User`. None of that
changes the obligation for these two tables — both are workspace-scoped and read directly — but an
implementer should read the guard rather than this paragraph if `!357` has landed by then.

`MedicationDose` carries no `workspaceId` and is reached via `include`, exactly as `Step` is, so it
falls outside the guard's predicate and is exported as part of its parent.

**Neither new model belongs in `DELIBERATELY_EXCLUDED`.** Both are content the user typed.

## Staging

### v1 — the slice this spec is for

The feature gate; a today-strip on the home page, working days only; one tap per dose to record
`taken` or `skipped`; **the nav-bar control in both modes, with the mode picker in Settings**; the
dismissable banner; the regimen editor in Settings; **full per-dose history recorded**; the
presentational reward; export coverage.

⚠️ **The privacy amendment is in v1 but lands FIRST**, as its own commit and its own publication event —
revised 2026-08-15. It was previously listed as one more item in this slice, which read as "ships
alongside". It does not: it ships before, because until it has, the feature's release makes a published
statement untrue. Everything else in this list can be ordered freely.

**Still one implementable slice.** Checked against splitting: the strip cannot ship without the schema,
the schema is not worth shipping without a way to write to it, and the regimen editor is what makes the
schema reachable at all.

**The nav control is in v1 rather than deferred**, and the reason is that deferring it would cost more
than including it: it shares the logging call, the derived state and the announcement conventions with
the strip, so building it later means re-opening all three. ⚠️ **Its honest cost, stated rather than
buried: two modes are two code paths**, each needing its own tests and its own a11y assertions. The
shared part is the logging call and the state model, which is most of the volume but not most of the
risk — the risk is in the two accessible-name and live-region implementations, which do not share code.

⚠️ **If the slice has to shrink, the mode picker is the first thing to cut, not the control.** Ship
`B★` alone against the default and add `next` with the column's second value later; the migration is
additive and the CHECK constraint is the only thing to widen. Cutting the *control* instead would be
the wrong economy, because the header is the surface the owner asked for.

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
9. **The `taken` and `skipped` reward sets are equal in size.** The mechanical half of the honesty
   rule; the tonal half is a review item and cannot be automated. ⚠️ Revised 2026-08-15 — this used to
   read "in both voices", which the voice deletion makes meaningless. **Also assert the set size is in
   the 6–8 band**, so nothing grows it to twenty by accretion; a bare equality assertion is satisfied
   by two sets of forty.
10. **The reward copy contains no decorative emoji.** `strings.ts`'s contract, which #86 keeps for the
    surviving voice; this stops the rotating set from quietly breaking it.
11. **Rotation is deterministic for a given (date, dose) pair** — the same input gives the same line
    on two calls. Pins the anti-hydration-bug property and the no-`Math.random` decision together.
12. **Dose chips and the nav control meet the 44×44 floor**, with a control that the assertion can
    fail. ⚠️ `min-h-11` is only a class name in jsdom — `quick-access.test.tsx` says so at its own
    assertion — so this checks the composition, not a computed pixel value, and the real measurement
    belongs in an e2e assertion if one is wanted.
13. **`MedsNavMode` ↔ `Settings_medsNavMode_check`**, a second `REGISTRY` entry with
    `nullable: false`, plus the raw-SQL rejection of an out-of-set value. Same shape as test 5, and it
    is the entry nothing mechanical will remind anyone about.
14. **`B★`'s accessible name states the NEXT action, and changes when the target dose advances.**
    Assert on the name string, not on a class: the failure this pins is a name that reports only the
    current state, which looks correct in a snapshot.
15. **`B★`'s Undo is focusable, persists past the announcement, and reverts exactly one commit.** The
    negative half is the one worth writing — a `role="status"` toast that disappears must **fail** this
    test, otherwise it is not testing anything.
16. **No number of `B★` presses erases a record** — cycling stops at `skipped` rather than wrapping to
    *not recorded*.
17. **`E` advances to the next unrecorded dose and announces the new target**, and when none is left it
    removes both buttons rather than leaving them inert.
18. **`E`'s two buttons each carry a complete accessible name on their own**, not one that depends on
    the group label being read.
19. **Every commit announces through a polite live region, in both modes** — never assertive.
20. ⚠️ **Exactly ONE announcement per press, carrying the reward inside it.** Assert the **count**, not
    just the content: the failure mode is two polite messages for one log, which is the delayed second
    announcement the timed `B★` variant was rejected for, arriving through a different door. A
    content-only assertion passes the whole time that is happening.
21. **The home strip renders whatever `medsNavMode` says.** The property that makes every per-mode
    compromise legitimate, so it is asserted rather than assumed: iterate both modes and assert the
    strip is present in each.
22. ⚠️ **Nothing in the meds code branches on assistive technology.** A source-level assertion that no
    `matchMedia`, no AT-probe and no equivalent heuristic appears in these components. It reads like a
    style rule and is not one: it is the only thing that stops a future well-meaning commit from adding
    detection that cannot work.

⚠️ **One thing is not automatable: whether the skip copy feels as good as the taken copy.** It is a
review item on the MR, it is the rule most likely to erode, and no assertion substitutes for reading
both lists side by side.

⚠️ **A second thing is not automatable, and it is new with the nav control:** whether `B★`'s accessible
name is *comprehensible*, not merely present. Test 14 can prove a name states the next action; only a
person can tell whether hearing it on every press is tolerable. That is what the mode picker exists for.

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

**`format:check` cannot gate this file — the measurement, with its control.** ⚠️ Added 2026-08-15
because this MR's description had claimed the check passes, which was a zero from a run that matched no
files. The first command exits `0` on deliberately broken Markdown; the second reports it:

```sh
f=docs/design/specs/2026-08-13-medication-tracker-design.md
cp "$f" /tmp/spec-probe.md
printf '\n\n*   badly    formatted   list\n' >> "$f"
npx prettier --check "$f"; echo "with .prettierignore: exit $?"
npx prettier --check --ignore-path /dev/null "$f"; echo "control: exit $?"
cp /tmp/spec-probe.md "$f"
```

Prints *"All matched files use Prettier code style!"* and `exit 0`, then `[warn]` and a non-zero exit
on the same bytes. `.prettierignore` lists both `*.md` and `docs/`, so **this file is proofread by hand
or not at all.**

**The WCAG citation guard reads `docs/`, so it polices this file** — and it is runnable here without
Postgres, which makes it the one mechanical check this spec does have:

```sh
git show origin/main:src/lib/a11y-class-hygiene.test.ts | grep -n 'for (const root of'
npx vitest run --config config/vitest.config.ts src/lib/a11y-class-hygiene.test.ts
```

The grep prints `["src", "e2e", "docs"]`. ⚠️ **Run it from a branch synced with `main`**: on this branch
before `main` was merged in, it failed on `docs/design/specs/2026-08-11-offline-capture-queue-design.md`
— an older version of that file **quotes** the weld it documents, and the guard cannot distinguish a
quoted bad citation from a real one. `main` has since rephrased it. A red from a file you did not touch
is that, not your own citation.

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
| One fixed reward word rather than a rotating set | Considered and **declined 2026-08-15**. It was defensible while there were two registers and the plainer one could stay bare; once #86's deletion lands there is one register, so a fixed word becomes the *only* thing the user ever sees — and habituation to a predictable string is the exact ADHD-relevant failure the reward exists to avoid. Declined now rather than after the deletion, because the reward set is written before it |
| A twenty-line reward set | The other direction, declined for the same section's reason: the repo's own sets are 8 and 6, and past that a set is not more varied, only harder to review as a pair — and reviewing it as a pair is the one enforcement §1's honesty rule has |
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
| **The nav control as the only logging route** | Declined on 2026-08-15 before either mode was chosen, and it is what makes both modes acceptable: the home strip is always present, so the *function* is reachable regardless of mode. A shortcut may be specialised; a sole route may not |
| **Auto-selecting `E` for screen-reader users** | **Not declined on taste — it is not possible.** No browser API and no media query reveals assistive technology, and probing for one is an anti-pattern. So it is a recommendation in the Settings copy, and nothing in the code may branch on a guess about it |
| `B★` with a timed commit — taps move a *pending* state and a 3-second ring commits | The mockup's `B+`, and the reason `B★` exists instead. The debounce makes overshoot free, which is genuinely clever, but it puts a **time limit** on the interaction and produces a **delayed second announcement** — disorienting when you cannot see the ring, and a time limit is a worse a11y cost than the asymmetry it was buying off. Immediate commit plus a persistent, focusable Undo gets the same forgiveness with no clock |
| A count pill that opens the strip (mockup `A`) | One number to read and the fewest new parts, but **two taps to log**. The whole premise is one glance and one tap, and the mode picker already covers the "I want it explicit" case with `E`, which is one tap and symmetric |
| One dot per dose in the bar (mockup `C`) | Most explicit, and **hard-codes the regimen into the header layout** — three or four dots crowd a cluster that already holds up to three controls. The regimen is configurable by design, so a control whose width tracks it is the wrong shape |
| A pill that expands in place (mockup `D`) | The widest of the four and two taps, and it **duplicates the home strip** rather than reusing it — two implementations of one thing, which is what the shared logging call exists to avoid |
| A separate Boolean to hide the nav control | Not declined on merit — **declined for want of a decision.** `medsTracker` already governs availability, which is why the trolley icon has no column of its own; #252's criterion for adding one is that the owner asked, and no such ask exists. One Boolean beside `medsNavMode` if it is ever wanted |
| A configurable `B★` cycle order (skipped first) | Real, and v2 at the earliest. A third column and a third code path for a preference nobody has stated; `E`'s symmetry already serves the user for whom *taken*-first is wrong |

## Related

- **#260 — "Saved for later" is a one-hour snooze, and you cannot park anything indefinitely** — the
  derive-don't-schedule doctrine this design follows, **and** the record of where that doctrine runs
  out of expressiveness. Its sentinel warning is adopted here
- **#257 — A failed streak touch reports the whole write failed, over work that is saved** — the
  defect class a presentational reward keeps this feature clear of. **Closed 2026-08-15**; `!339`
  merged, so `src/lib/best-effort.ts` is on `main` and may be cited as a file
- **#86 — Make the plain/playful voice convention enforceable** — carries the owner's decision of
  2026-08-14 to **delete the playful voice**, which is what makes this document's reward section a
  single register carrying a rotating set. Unscheduled, in Backlog, and this feature is not blocked on
  it in either order — see *§6a*. It cites this MR for `Settings.voice` being the schema's one CHECK-less
  pseudo-enum
- **`!357` — Draft: fix(legal): correct ten measured drifts between the legal pages and the code** —
  rewrites the health paragraph this feature has to amend, withdraws the Article 9(2)(a) basis this
  document had planned to extend, and names `/help` and `src/lib/export/readme.ts` as two more surfaces
  carrying the same disclosure. **It deliberately says nothing about medication**, so none of the
  privacy checklist is done by it. Whichever lands first, the other rebases — a single
  `LEGAL_EFFECTIVE_DATE` cannot move twice for one publication
- **#268 — Three WCAG target-size citations are inverted, and the guard built to catch them cannot see
  any** — why the citation to copy for the nav control's 44×44 floor is `controlSurface`'s docblock and
  not `touchTarget`'s, which sits directly above the constant and is one of the inverted sites
- **#252** — the header quick-access cluster this feature's nav control joins: the `controlSurface` +
  `touchTarget` composition, the one-column-per-*availability*-gate reasoning, and the `t(labelKey,
  voice)` label pattern
- **#159 — `User.purgeAfter` is never honoured — nothing purges a revoked account** — the same
  no-`src/`-in-the-image constraint on a different surface, and it already lists the authenticated-
  endpoint option. Cross-referenced deliberately rather than restated; whichever lands first should
  settle the pattern for both
- **#199** — the shopping-list feature whose gate, hide-not-delete doctrine, optional-page shape and
  export guard this design follows throughout
- **`docs/design/specs/2026-08-11-offline-capture-queue-design.md`** — the live-region and
  announcement conventions the reward, banner and both nav modes follow
- **`_reports/2026-08-15-meds-pill-mockups.html`** — live mockups of every nav shape considered, on the
  real tokens and the real 44×44 control surface, each panel carrying its own trade-offs. Source of
  truth for what `B★` and `E` *are*; this document is the source of truth for the decision between them
