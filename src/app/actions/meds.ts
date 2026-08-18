"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { MedsDoseState } from "@/lib/constants";
import { isPlausibleLocalDate } from "@/lib/meds";

/**
 * #269 — record that a dose was taken or deliberately skipped.
 *
 * ## The whole write is one upsert, and that is the design
 *
 * `@@unique([workspaceId, date, medicationDoseId])` means the key is one the
 * client already knows, so a double-tap on *Taken* — the single most likely
 * interaction on this feature, by an audience whose defining trait makes it
 * likely — writes ONE row. There is no `clientKey` to forget and nothing
 * nullable in the key, so the property comes from the schema rather than from a
 * convention. That is deliberately the opposite of #257's capture failure, where
 * a null idempotency token made the unique index treat a retry as a new row.
 *
 * It is also why a `skipped` → `taken` correction needs no repair path: the
 * overwrite lands on the same row, and `Missed` was never stored, so there is no
 * transition to un-do.
 *
 * ## Nothing happens after the commit, and that is load-bearing
 *
 * No `RewardEvent`, no `logReward`, no `awardBadge`, no streak touch. The reward
 * for logging is purely presentational — a string chosen and rendered — because
 * scoring adherence would hand the reader a motive to log a dose they did not
 * take, and a tracker you have lied to once is worth less than no tracker.
 *
 * So this action **cannot join the throw-after-commit defect class** (#257: *"the
 * `try` governs the WRITE; anything after it is a consequence of success and
 * cannot un-write the row"*). Not "we were careful" — the code that defect lives
 * in does not exist here. `src/lib/best-effort.ts` is on `main` and is
 * deliberately NOT reached for: wrapping a call with nothing after it would be
 * cargo-cult, and its own docblock names the three sites that earned it.
 *
 * ## No AI, ever
 *
 * Nothing here composes a prompt and nothing downstream of it does. /terms tells
 * readers not to rely on an AI suggestion for "medication or dosing"; the
 * cheapest way to keep that promise absolutely is for no medication row to reach
 * one.
 */

/** Why a log was refused. Every reason is a caller bug, not a reader error. */
export type MedsLogRefusal =
  | "unknown-dose"
  | "bad-date"
  | "bad-state"
  /** `Settings.medsTracker` is off, or the workspace has no settings row. */
  | "tracker-off";

export type MedsLogResult =
  { ok: true; state: MedsDoseState } | { ok: false; reason: MedsLogRefusal };

export async function logMedsDose(input: {
  medicationDoseId: string;
  state: MedsDoseState;
  /**
   * The reader's LOCAL `YYYY-MM-DD`.
   *
   * ⚠️ **This action takes NO clock, and that is the security property.** A
   * previous round added `now?: Date` so the day boundary could be tested — good
   * advice, misapplied. `"use server"` exports are POST endpoints ("treat every
   * action as an untrusted entry point", Next's own docs), so an argument is an
   * untrusted input: a caller supplying both `date` and `now` could make ANY date
   * plausible and write a health record against an arbitrary day, defeating the
   * very backfill defence the bound is documented as providing.
   *
   * The clock is now always the server's. The boundary cases moved down to
   * `isPlausibleLocalDate` in `src/lib/meds.ts`, which is pure, keeps its `now`
   * parameter, and is not reachable by a caller — so nothing was lost in
   * coverage and the input surface shrank.
   */
  date: string;
}): Promise<MedsLogResult> {
  const { medicationDoseId, state, date } = input;

  /**
   * ⚠️ **All three fields have their SHAPE checked, in the order the type
   * declares them, before anything is queried.** The type above is a
   * compile-time shape and this is a POST endpoint; every guard below is
   * unreachable from the app's own UI and reachable from the wire.
   *
   * ## `medicationDoseId`: an absent key does not mean "match nothing"
   *
   * Prisma **omits** a `where` key whose value is `undefined` rather than
   * treating it as unsatisfiable, and `strictUndefinedChecks` is a preview
   * feature this schema's `generator client` block does not enable — so the
   * omitting behaviour is the one in force. A payload without the id therefore
   * reduced the scoped lookup below to `findFirst({ where: { medication: … } })`
   * with no `id` term, and `findFirst` answers with the FIRST eligible dose in
   * the workspace. Measured before this guard existed: a payload of `{ state,
   * date }` returned `{ ok: true, state: "taken" }` and wrote a row.
   *
   * The `workspaceId` filter still held, so it was never a cross-workspace leak
   * — it was a health record against a medication the caller never named,
   * reported as success. For a tracker whose whole worth is that nobody has lied
   * to it, a wrong row is the same category of harm as a missing one, and the
   * export hands it over either way.
   *
   * ⚠️ **`typeof`, not a null check, and the difference is the whole guard.**
   * `{ not: "" }` and `{ contains: "itest" }` are Prisma FILTER operators. A
   * caller sending one where a scalar belongs does not blank the term, it
   * substitutes a predicate of its own choosing — and every one of those shapes
   * is non-null, so `!= null` would pass them straight through. Refusing
   * anything that is not a non-empty string closes the absent, the `undefined`
   * and the operator-object cases with one condition.
   *
   * It answers `unknown-dose` rather than earning a refusal of its own. From the
   * caller's side that is the honest outcome — no dose was named, so none was
   * found — and it is the same argument the `if (!dose)` block below makes for a
   * paused medication: a reason nobody's UI can reach still costs a copy in
   * every voice. Nothing in the app can send this payload, so nothing needs to
   * render a new answer to it.
   *
   * ## `date`: the one that threw instead of refusing
   *
   * `isPlausibleLocalDate` takes a `string` and calls `date.split("-")`
   * unconditionally, so a non-string threw a `TypeError` out of the action —
   * measured as `Cannot read properties of undefined (reading 'split')`, an
   * unhandled 500 where the `state` check below achieves a graceful refusal for
   * free because `Object.values(...).includes(...)` cannot throw.
   *
   * Guarded HERE and not by widening that predicate's parameter to `unknown`:
   * it is a pure function whose `string` contract is honest, its own docblock
   * records that it lives outside the action deliberately, and this action is
   * the untrusted entry point. Weakening the signature would cost every internal
   * caller its compile-time check to defend a wire that only this file faces.
   */
  if (typeof medicationDoseId !== "string" || medicationDoseId.length === 0) {
    return { ok: false, reason: "unknown-dose" };
  }
  // Validated here rather than left to `MedsDoseLog_state_check`. The constraint
  // is the backstop and it stays the backstop — but a caller that reaches it gets
  // a 500 and a stack trace, and `missed` is the value an implementer would
  // plausibly send, being a real state the UI renders. It is derived from an
  // absence and must never be stored.
  if (!Object.values(MedsDoseState).includes(state)) {
    return { ok: false, reason: "bad-state" };
  }
  if (typeof date !== "string" || !isPlausibleLocalDate(date, new Date())) {
    return { ok: false, reason: "bad-date" };
  }

  const workspaceId = await currentWorkspaceId();

  /**
   * ⚠️ **Scope AND the feature gate, in ONE query — and both are load-bearing.**
   *
   * Consolidated from two stacked docblocks that had accumulated across review
   * rounds (`!364`); they described the same statement and read as though each
   * were the last thing before it.
   *
   * ## The scoping half: the hole the denormalised `workspaceId` opens
   *
   * `MedsDoseLog` carries its own `workspaceId` so the today-strip can read by
   * date without joining through `Medication`. Nothing in
   * `@@unique([workspaceId, date, medicationDoseId])` then stops this
   * workspace's id being paired with ANOTHER workspace's dose: the foreign key
   * proves the dose exists, not that it belongs here. So the dose is resolved
   * through its scoped parent before anything is written — a filter on the
   * relation, not a check on a value the caller supplied.
   * `Settings.focusPlaylistIds`' schema comment records the identical reasoning
   * for a scalar list: *"the write path filters to playlists the resolved
   * workspace actually owns — so a foreign id cannot be stored even if one is
   * posted."*
   *
   * ## The gate half: the workspace must have opted in
   *
   * Duo review round 2 of `!364`, grounded: this action validated the state, the
   * date and the dose's workspace, and never asked whether the workspace had the
   * tracker **on**. A server action is a POST endpoint the client can reach
   * without loading any page, so a gate only in Settings makes the switch
   * cosmetic — "off" would mean "the controls are hidden" rather than "the
   * feature is not running". `shoppingWorkspace()` in
   * `src/app/actions/shopping.ts` makes exactly that argument for its own
   * column, and `Settings.medsTracker`'s schema comment says it follows
   * `shoppingList` exactly.
   *
   * Here it is more than defence in depth. `#269` defaults the column `false`
   * for a stated legal reason — *"a workspace that has not opted in genuinely
   * has no health field"* — and the legal amendment that publishes that on
   * /privacy as the Art. 9(2)(a) position, with the switch as the consent act,
   * merges before this feature ships. A write path that skips the check would
   * make that published sentence false. Nor is it exotic input: `Medication`
   * and `MedicationDose` rows outlive the toggle, because turning it off HIDES
   * rather than deletes, so a valid dose id belonging to an opted-out workspace
   * is the ordinary state of anyone who has ever switched it off.
   *
   * ## The pause half: the medication must not be deactivated
   *
   * Duo review round 3 of `!364`, grounded. `deriveTodayDoses` skips an inactive
   * medication outright (`if (!med.active) continue`), so its doses appear on no
   * surface at all — no chip, no dot, no banner line. Every legitimate press
   * comes from a surface that rendered the dose it names, and this write accepted
   * one no surface could have offered.
   *
   * ⚠️ Not only a crafted POST: pause a medication in Settings with the home page
   * open in a second tab and that tab still holds the old regimen. A press there
   * wrote a row the strip would never show again, because the read path had
   * already stopped deriving the dose — an invisible health record, which the
   * export then hands over. It is the tracker gate's argument one level down: a
   * switch enforced only where the controls are drawn is cosmetic.
   *
   * Deactivating hides and does not delete, exactly like the tracker flag, so the
   * rows a paused medication already has stay readable. A spec asserts that.
   *
   * ## Why the three halves share one query
   *
   * There is no window between deciding the dose is in scope, deciding the
   * workspace is opted in and deciding the medication is running — and, more
   * usefully, it forces the questions to be asked the right way round. The filter
   * walks `medication → workspace → settings` from the CALLER's `workspaceId`, so
   * it answers "does the caller's own workspace have this on", never "does the
   * dose's owner". Those look alike and only one of them is scoping; a spec logs a
   * foreign dose whose own workspace IS opted in, which is the input that tells
   * them apart. `active` sits on the same `medication` filter the scoping already
   * walks through, so it costs no extra hop.
   *
   * `Settings` is a nullable to-one, so a workspace with no row matches nothing
   * and fails CLOSED — wanted rather than incidental, since `getSettings()`
   * creates the row on first use and no row therefore means nobody has ever
   * opened Settings.
   *
   * `select: { id: true }` because `dose.id` is the only field anything below
   * uses.
   *
   * ⚠️ **It refuses; it never deletes.** Off hides the history and removes no
   * row — a sweep here would make /privacy, /help and the archive's README false
   * at once, about a health record.
   *
   * The residual read→write gap is real and unchanged: this is still a check
   * before the upsert, exactly as the dose-scoping check always was. Closing it
   * would mean denormalising the flag onto a column the write's own `where`
   * could carry, and that is not worth a column — the rows are the caller's own
   * either way, so what this protects is the switch's PROMISE. The boundary
   * between one person's data and another's is the `workspaceId` filter, and it
   * is inside this same `where`.
   */
  const dose = await prisma.medicationDose.findFirst({
    where: {
      id: medicationDoseId,
      medication: {
        workspaceId,
        active: true,
        workspace: { settings: { medsTracker: true } },
      },
    },
    select: { id: true },
  });

  if (!dose) {
    /**
     * Which refusal it was — three inputs, deliberately TWO answers.
     *
     * Only on the failure path, so the happy path stays at one query. The
     * distinction that is drawn is the one where the right response differs: a
     * reader whose tracker is off needs sending to Settings, while a caller
     * holding an id that is not theirs must learn nothing — so "not yours" and
     * "does not exist" still answer identically to each other, and neither is an
     * existence oracle over another workspace's ids. Reporting the caller's OWN
     * switch back to them discloses nothing they did not set.
     *
     * A PAUSED medication answers `unknown-dose`, with the tracker check taking
     * precedence when both are true. That is not a gap: from the client's point
     * of view the dose genuinely is not there, because the read path stopped
     * deriving it — and a reason of its own would need its own copy in every
     * voice for a state only a stale tab can reach, while the honest outcome is
     * already the right one (the press reverts, and a reload shows the
     * medication paused). Settings is where the reader goes for either.
     */
    const optedIn = await prisma.settings.findFirst({
      where: { workspaceId, medsTracker: true },
      select: { workspaceId: true },
    });
    return { ok: false, reason: optedIn ? "unknown-dose" : "tracker-off" };
  }

  await prisma.medsDoseLog.upsert({
    where: {
      workspaceId_date_medicationDoseId: {
        workspaceId,
        date,
        medicationDoseId: dose.id,
      },
    },
    create: { workspaceId, date, medicationDoseId: dose.id, state },
    // `markedAt` moves with the correction: v2's history is a record of what the
    // reader told the tracker, and the correction is when they actually said it.
    update: { state, markedAt: new Date() },
  });

  // The today-strip renders from the home page (`src/app/(app)/page.tsx` via
  // `inbox-view.tsx`), not from /dashboard — an answer behind a navigation step
  // is an answer you do not get. So "/" is the path whose values this write
  // changes, which is what `revalidation-hygiene` asks every writer to name.
  revalidatePath("/");

  return { ok: true, state };
}
