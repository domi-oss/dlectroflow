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

  // Every surface that RENDERS the note, so none of them serves a stale one:
  // the task page, the Inbox at `/`, and the Library. Invalidating one path
  // too many costs a re-render; one too few is the class of bug #139 was filed
  // for, and `revalidation-hygiene` polices exactly this contract for
  // `focus.ts`.
  //
  // `/library` was missing until !270. The comment here used to call it a
  // deferral, and it was one for two commits — then #44's surface sweep
  // mounted `TaskNoteRow` in `library-rows.tsx` and `library-multistep.tsx`,
  // and `library/page.tsx` began selecting `task.notes` into the row. The
  // deferral note outlived the deferral, which is the failure mode a comment
  // asserting a fact about ANOTHER file always has; the colocated test now
  // asserts the whole set of paths rather than the presence of any one, so an
  // omission fails instead of reading as a decision.
  //
  // `force-dynamic` on those pages is not a substitute. It governs the SERVER
  // render; `revalidatePath` is also what clears the client router cache, and
  // that cache is what a client-side navigation away and back would otherwise
  // serve.
  //
  // The id comes from the row we just authorised, not from the argument. Here
  // the two are provably the same value — the `findFirst` is keyed on
  // `id: taskId` — so this is not a fix for a live arbitrary-invalidation bug
  // (an unowned id returns `not_found` above, revalidating nothing). It is the
  // same sourcing rule `step-notes.ts` states, applied so the pair does not
  // have to be reasoned about twice (!270).
  revalidatePath("/");
  revalidatePath("/library");
  revalidatePath(`/tasks/${task.id}`);

  // The STORED value, not the caller's input. Normalisation trims, strips and
  // clamps, and a field that keeps displaying text the database does not have
  // is a lie the user then acts on.
  return { ok: true, notes: normalized };
}
