"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { normalizeTaskNote } from "@/lib/task-notes";

export type UpdateItemNotesResult =
  | { ok: true; notes: string | null }
  | { ok: false; reason: "not_found" | "wrong_grain" | "error" };

/**
 * Save the note on an UNTRIAGED brain-dump item (#186).
 *
 * The third grain of #44's note, and the sibling `task-notes.ts` predicted:
 * "a later `updateStepNotes` is a sibling file with the same three moves". Same
 * three moves again — scoped read, normalise, write — and
 * `normalizeTaskNote`/`TASK_NOTE_MAX_LENGTH` are reused rather than re-declared,
 * because `BrainDumpItem_notes_check` is asserted against that one number.
 *
 * Workspace-scoped and guest-allowed, matching `updateTaskNotes`: a guest's
 * sandbox is a real workspace, and a note is content they typed rather than a
 * privileged operation. The workspace filter — not the role — is what keeps one
 * account's items away from another's.
 *
 * **The scoped read IS the authorization.** `prisma.brainDumpItem.update` is
 * keyed on the unique id alone, because Prisma cannot filter a unique update by a
 * relation field, so nothing in the write itself mentions the workspace. If the
 * `findFirst` below ever stops gating it, this becomes an IDOR that rewrites a
 * stranger's note — which is why the colocated test asserts both the filter and
 * the ORDER of the two calls.
 *
 * ## Why a task-backed item is refused rather than written
 *
 * There are two note columns and only one is live (`liveNote` in
 * src/lib/braindump-to-task.ts). Triage COPIES the item's note onto the `Task`,
 * and from then on every surface — `NoteField`, the ICS description, the Google
 * Task body — reads `Task.notes`. Writing the item's copy for a task-backed row
 * would store an edit nothing displays, which to the person is a save that
 * silently did nothing.
 *
 * The UI never mounts this control on such a row (`TaskNoteRow` picks the grain),
 * so this is a compensating control rather than a live branch: it makes the grain
 * rule enforced instead of merely observed, and it fails visibly.
 *
 * Resolves rather than throws on failure, for the reason `updateTaskNotes`
 * states: autosave has no submit button to re-enable and no form to leave dirty.
 */
export async function updateItemNotes(
  itemId: string,
  notes: string | null,
): Promise<UpdateItemNotesResult> {
  const workspaceId = await currentWorkspaceId();

  const item = await prisma.brainDumpItem.findFirst({
    where: { id: itemId, workspaceId },
    select: { id: true, taskId: true },
  });
  if (!item) return { ok: false, reason: "not_found" };
  if (item.taskId) return { ok: false, reason: "wrong_grain" };

  // Clamped here rather than left to `BrainDumpItem_notes_check`. The constraint
  // is the backstop for a writer that forgot; reaching it from the one that did
  // not would surface as a generic "couldn't save" with nothing to act on.
  const normalized = normalizeTaskNote(notes);

  try {
    await prisma.brainDumpItem.update({
      where: { id: item.id },
      data: { notes: normalized },
    });
  } catch {
    return { ok: false, reason: "error" };
  }

  // Both surfaces that render an inbox/pantry row, so neither serves a stale
  // note. NOT `/tasks/:id`: an item in this grain has no task page.
  //
  // The id comes from the row just authorised rather than from the argument —
  // the same sourcing rule `task-notes.ts` and `step-notes.ts` state, so the pair
  // does not have to be reasoned about a third time.
  revalidatePath("/");
  revalidatePath("/library");

  // The STORED value, not the caller's input: a field still showing the
  // pre-normalisation text is telling the user something untrue about what is
  // saved.
  return { ok: true, notes: normalized };
}
