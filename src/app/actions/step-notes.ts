"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { normalizeTaskNote } from "@/lib/task-notes";

export type UpdateStepNotesResult =
  | { ok: true; notes: string | null }
  | { ok: false; reason: "not_found" | "error" };

/**
 * Save the owner's freeform note on a single step (#44).
 *
 * The per-step twin of `updateTaskNotes`, and a separate file rather than a
 * second export there because they gate on different things: a `Step` has no
 * `workspaceId` of its own and is reached THROUGH its task, which is the idiom
 * `renameStep` and `completeStep` already use.
 *
 * **The scoped read IS the authorization**, as it is on the task action.
 * `prisma.step.update` is keyed on the unique id alone — Prisma cannot filter a
 * unique update by a relation field — so nothing in the write mentions the
 * workspace. The colocated test asserts the filter AND the order of the two
 * calls, because it is the order that makes the filter load-bearing.
 *
 * Shares `normalizeTaskNote` and its bound rather than declaring a second one:
 * both columns exist to fit inside the same Google Tasks cap, so a step-specific
 * number would be a second thing to keep in sync with an external limit for no
 * benefit.
 */
export async function updateStepNotes(
  stepId: string,
  notes: string | null,
): Promise<UpdateStepNotesResult> {
  const workspaceId = await currentWorkspaceId();

  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
    select: { id: true, taskId: true },
  });
  if (!step) return { ok: false, reason: "not_found" };

  // Clamped here rather than left to `Step_notes_check` — the constraint is the
  // backstop for a writer that forgot, and reaching it from the one writer that
  // did not would surface as a generic "couldn't save".
  const normalized = normalizeTaskNote(notes);

  try {
    await prisma.step.update({
      where: { id: step.id },
      data: { notes: normalized },
    });
  } catch {
    return { ok: false, reason: "error" };
  }

  // The same three paths as `updateTaskNotes`, and for the same reason — every
  // surface that renders a step note. The Library reaches them through its
  // multi-step row, which expands into the same `TaskSteps` the task page
  // renders, so a step note saved there has to survive a client-side
  // navigation away and back (!270).
  //
  // The parent path comes from the row we just authorised, never from a caller
  // parameter: a `taskId` argument would let a caller invalidate an arbitrary
  // path, and would be a second value needing its own workspace check.
  revalidatePath("/");
  revalidatePath("/library");
  revalidatePath(`/tasks/${step.taskId}`);

  return { ok: true, notes: normalized };
}
