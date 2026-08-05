"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/lib/workspace";
import { normalizeTaskNote } from "@/lib/task-notes";

export type UpdateTaskNotesResult =
  | { ok: true; notes: string | null }
  | { ok: false; reason: "not_found" | "error" };

/**
 * Save the owner's freeform note on a task (#44).
 *
 * Workspace-scoped and guest-allowed, matching `scheduleViaIcs`: a guest's
 * sandbox is a real workspace, and a note is content they typed rather than a
 * privileged operation. There is no owner gate, and the workspace filter — not
 * the role — is what keeps one account's tasks away from another's.
 *
 * **The scoped read IS the authorization.** `prisma.task.update` is keyed on the
 * unique id alone, because Prisma cannot filter a unique update by a relation
 * field, so nothing in the write itself mentions the workspace. If the
 * `findFirst` below ever stops gating it, this becomes an IDOR that rewrites a
 * stranger's note — which is why the colocated test asserts both the filter and
 * the ORDER of the two calls, not just the filter.
 *
 * Resolves rather than throws on failure, deliberately. Autosave has no submit
 * button to re-enable and no form to leave dirty: the field paints its error
 * affordance and stays editable, and an unhandled rejection would instead
 * surface as a server-action error overlay over a page the user was typing in.
 *
 * Task-level only (#44). A later `updateStepNotes` is a sibling file with the
 * same three moves — `normalizeTaskNote` and the constant are already
 * concept-named rather than Task-named.
 */
export async function updateTaskNotes(
  taskId: string,
  notes: string | null,
): Promise<UpdateTaskNotesResult> {
  const workspaceId = await currentWorkspaceId();

  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    select: { id: true },
  });
  if (!task) return { ok: false, reason: "not_found" };

  // Clamped here rather than left to `Task_notes_check`. The constraint is the
  // backstop for a writer that forgot; reaching it from the one writer that
  // did not would surface to the user as a generic "couldn't save" with nothing
  // they could act on.
  const normalized = normalizeTaskNote(notes);

  try {
    await prisma.task.update({
      where: { id: task.id },
      data: { notes: normalized },
    });
  } catch {
    return { ok: false, reason: "error" };
  }

  // The task page renders the note, so it must not serve a stale one after a
  // reload. `/` is invalidated too: it is the list this app's writes
  // consistently invalidate (the contract `revalidation-hygiene` polices for
  // `focus.ts`), and the note is a `Task` column the Library overview is next
  // in line to render — #44 asks for it, and it is deferred rather than
  // dropped. Invalidating one path too many costs a re-render; one too few is
  // the class of bug #139 was filed for.
  revalidatePath("/");
  revalidatePath(`/tasks/${taskId}`);

  // The STORED value, not the caller's input. Normalisation trims, strips and
  // clamps, and a field that keeps displaying text the database does not have
  // is a lie the user then acts on.
  return { ok: true, notes: normalized };
}
