import { prisma } from "@/lib/db";
import { splitInlineNote } from "@/lib/braindump-note-syntax";
import { normalizeTaskNote } from "@/lib/task-notes";
import { touchStreakOnEngagement } from "@/lib/rewards";

/**
 * #175 — the ONE brain-dump capture write.
 *
 * Design: `docs/design/specs/2026-08-11-offline-capture-queue-design.md`.
 *
 * ## Why this is a module and not just a server action
 *
 * The offline queue flushes through `POST /api/braindump`, and the spec puts the
 * FOREGROUND capture on the same route rather than leaving the server action as a
 * second entry point — so there is **one write path and one set of semantics to
 * test**. `createBrainDumpItem` stays for the callers that are not queued (the
 * breakdown ejector, `src/components/breakdown/breakdown-chat.tsx`) and shares
 * this core rather than carrying its own copy of the note split, the empty guard
 * and the streak touch. Two copies of a write is how `Settings` and `Streak` came
 * to hold the same #156 bug independently.
 *
 * It cannot live in `src/app/actions/braindump.ts`: that file is `"use server"`,
 * so every export from it is an async server action and a plain helper is not a
 * legal thing to export. `src/lib/` is where domain logic lives here anyway.
 *
 * ## Revalidation is deliberately NOT here
 *
 * `revalidatePath` is a request-scoped Next API and no module in `src/lib`
 * touches one; the caller owns it, exactly as the actions do today. It is also
 * only correct on the `created` outcome — see {@link CaptureOutcome}.
 */

/**
 * What happened to one capture. Three values, and the caller maps them to
 * whatever its transport says: `POST /api/braindump` answers 201 / 200 / 400, and
 * the server action revalidates on the first and returns silently on the others.
 *
 * `duplicate` is a SUCCESS. `withActionTimeout` bounds how long the UI waits, not
 * how long the request runs (its docblock in
 * `src/lib/server-action-failure.ts` says so), so a capture that timed out at
 * 10s and landed at 14s comes back on the next flush as a duplicate — the row is
 * saved and the words are not lost. `capture-queue.ts`'s `applyFlushOutcome`
 * drops the queue entry on `duplicate` exactly as it does on `saved`, and that is
 * the whole reason `clientKey` exists.
 */
export type CaptureOutcome = "created" | "duplicate" | "empty";

export type CaptureInput = {
  /** The workspace the SESSION resolved. Never a value a request supplied. */
  workspaceId: string;
  /** Raw text as typed, inline note syntax included — split here (#179). */
  text: string;
  /**
   * The client-generated idempotency key, when the caller has one.
   *
   * `null` for every ordinary online capture, and the null is load-bearing:
   * Postgres treats nulls as DISTINCT in a unique index, so any number of
   * unkeyed captures coexist under `BrainDumpItem_workspaceId_clientKey_key`
   * while a replayed keyed one collides with itself. See the column's comment in
   * `prisma/schema.prisma`.
   */
  clientKey?: string | null;
};

/**
 * Capture a brain dump, splitting off an inline note if it carries one (#179),
 * and never writing the same `clientKey` twice for one workspace (#175).
 *
 * ## The empty guard reads the PARSED text
 *
 * `{just a note}` is refused by the parser and stored literally, so this cannot
 * create a row whose only content is hidden behind a note disclosure — and it is
 * not empty either. The note goes through `normalizeTaskNote` rather than being
 * left to `BrainDumpItem_notes_check`: the constraint is the backstop for a
 * writer that forgot, and reaching it from the writer that did not would surface
 * to the person as a capture that silently failed.
 *
 * ## Idempotency is Postgres's decision, not this function's
 *
 * `createManyAndReturn` with `skipDuplicates` is the only Prisma API that
 * compiles to `INSERT … ON CONFLICT DO NOTHING`, and `src/lib/db.ts` argues at
 * length why that is the shape rather than a `P2002` catch: the client logger
 * prints a failed query strictly BEFORE any `catch` sees it, so a fully handled
 * duplicate still reports `prisma:error` and reads as an incident (#156, #158).
 * A replayed capture is the most ordinary event in this feature and must be
 * silent. The loser gets an empty array — a **result**, not an error, the same
 * reading `ensureFocusStep` takes of its own step insert (#245).
 *
 * There is no read-then-write and so no race to lose: two concurrent flushes of
 * the same key both reach the index, one inserts, the other is skipped.
 *
 * ## The streak is only advanced by a capture that was actually written
 *
 * A duplicate is a capture the user already made, and the engagement was banked
 * when the first copy landed. `touchStreakOnEngagement` advances at most once per
 * working day so a second call would usually be a no-op, but "usually" is not the
 * reason to make one — the same argument `ensureFocusStep` makes for gating its
 * revalidation on whether it wrote.
 */
export async function writeCapture({
  workspaceId,
  text,
  clientKey = null,
}: CaptureInput): Promise<CaptureOutcome> {
  const { text: itemText, note } = splitInlineNote(text);
  if (!itemText) return "empty";

  const [created] = await prisma.brainDumpItem.createManyAndReturn({
    data: {
      text: itemText,
      notes: normalizeTaskNote(note),
      workspaceId,
      clientKey,
    },
    skipDuplicates: true,
  });
  if (!created) return "duplicate";

  // A capture is a qualifying engagement (Decision 1, #8 Phase 7) — advances the
  // streak at most once per working day.
  await touchStreakOnEngagement(workspaceId);
  return "created";
}
