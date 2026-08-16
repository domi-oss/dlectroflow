"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { MedsDoseState } from "@/lib/constants";

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
export type MedsLogRefusal = "unknown-dose" | "bad-date" | "bad-state";

export type MedsLogResult =
  { ok: true; state: MedsDoseState } | { ok: false; reason: MedsLogRefusal };

/**
 * How far the client's local date may sit from the server's UTC date.
 *
 * The client sends its own local day because the server cannot know the reader's
 * timezone — `MedsDoseLog.date` is a calendar fact in their time, not the
 * container's. That must not quietly become a backfill API: a caller posting an
 * arbitrary date could fabricate a history v2 will later visualise as fact.
 *
 * Real UTC offsets span UTC-12 to UTC+14, so a genuine local date is at most one
 * day either side of the server's. One day is therefore the tightest bound that
 * refuses nothing legitimate — narrower and the reader in Auckland at 09:00 or in
 * Honolulu at 22:00 is told their own today is invalid.
 */
const MAX_DATE_DRIFT_DAYS = 1;

/**
 * Is `date` a canonical `YYYY-MM-DD` naming a day the reader could plausibly be
 * on right now?
 *
 * ⚠️ **Validated by ROUND-TRIP rather than by a pattern, and that is deliberate.**
 * The obvious `/^\d{4}-\d{2}-\d{2}$/` is linear and perfectly safe, and
 * `gitlab-advanced-sast` reports it anyway as CWE-185 "Incorrect regular
 * expression" — measured on this exact line in pipeline 3471. Dismissing it would
 * work once: the fingerprint includes the LINE NUMBER, so the same statement
 * comes back as a new finding every time an unrelated edit moves it down the
 * file. `src/lib/pick-one.ts` records what that costs — one `Math.random` in
 * `focus-timer.tsx` dismissed five separate times at five different lines. There
 * is no regex to flag if there is no regex.
 *
 * The round trip is also the STRICTER check. It accepts exactly the canonical
 * rendering and nothing else, so `"2026-8-1"`, `"2026-08-1"`, `"+002026-08-17"`
 * and a 32nd of a month are all refused — the last by `Date.UTC`'s silent
 * roll-over showing up as a different string, which a pattern would have let
 * through.
 *
 * Both sides are built field by field against UTC, so the comparison is a pure
 * day count that does not itself depend on the container's timezone.
 */
function isPlausibleLocalDate(date: string, now: Date): boolean {
  const parts = date.split("-");
  if (parts.length !== 3) return false;
  const [y, m, d] = parts.map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return false;
  }
  const asked = Date.UTC(y, m - 1, d);
  // Out of the range `Date` can hold. Guarded before `toISOString`, which throws
  // a RangeError on an invalid date rather than returning anything.
  if (!Number.isFinite(asked)) return false;
  if (new Date(asked).toISOString().slice(0, 10) !== date) return false;

  const serverDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return Math.abs(asked - serverDay) / 86_400_000 <= MAX_DATE_DRIFT_DAYS;
}

export async function logMedsDose(input: {
  medicationDoseId: string;
  state: MedsDoseState;
  /** The reader's LOCAL `YYYY-MM-DD`. See {@link MAX_DATE_DRIFT_DAYS}. */
  date: string;
}): Promise<MedsLogResult> {
  const { medicationDoseId, state, date } = input;

  // Validated here rather than left to `MedsDoseLog_state_check`. The constraint
  // is the backstop and it stays the backstop — but a caller that reaches it gets
  // a 500 and a stack trace, and `missed` is the value an implementer would
  // plausibly send, being a real state the UI renders. It is derived from an
  // absence and must never be stored.
  if (!Object.values(MedsDoseState).includes(state)) {
    return { ok: false, reason: "bad-state" };
  }
  if (!isPlausibleLocalDate(date, new Date())) {
    return { ok: false, reason: "bad-date" };
  }

  const workspaceId = await currentWorkspaceId();

  /**
   * ⚠️ **The filter that closes the hole the denormalised `workspaceId` opens.**
   *
   * `MedsDoseLog` carries its own `workspaceId` so the today-strip can read by
   * date without joining through `Medication`. Nothing in
   * `@@unique([workspaceId, date, medicationDoseId])` then stops this workspace's
   * id being paired with ANOTHER workspace's dose: the foreign key proves the
   * dose exists, not that it belongs here.
   *
   * So the dose is resolved through its scoped parent before anything is written
   * — `medication: { workspaceId }` is a filter on the relation, not a check on
   * a value the caller supplied. `Settings.focusPlaylistIds`' schema comment
   * records the identical reasoning for a scalar list: *"the write path filters
   * to playlists the resolved workspace actually owns — so a foreign id cannot be
   * stored even if one is posted."*
   *
   * `select: { id: true }` rather than the row: nothing below needs the label,
   * and a narrow select is one fewer thing to accidentally return to a caller
   * who supplied a foreign id — the answer to "is this yours" must not itself
   * leak the contents.
   */
  const dose = await prisma.medicationDose.findFirst({
    where: { id: medicationDoseId, medication: { workspaceId } },
    select: { id: true },
  });
  // The same answer for "not yours" and "does not exist", deliberately: telling
  // the two apart is an existence oracle over another workspace's ids.
  if (!dose) return { ok: false, reason: "unknown-dose" };

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
