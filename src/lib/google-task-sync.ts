import { getValidAccessToken, patchGoogleTask } from "@/lib/google";
import { currentUser } from "@/lib/workspace";

/**
 * Best-effort mirroring of a LOCAL completion into Google Tasks, for the units
 * whose Google id lives on the **Task** row.
 *
 * ── Why this is a lib module and not another helper in `focus.ts` ───────────
 * `focus.ts` is a `"use server"` file, so anything exported from it becomes a
 * publicly callable server action — a module-private helper there cannot be
 * reached from `braindump.ts`, and exporting one to share it would put a raw
 * "complete this Google task" endpoint on the wire. Both completion routes
 * (`completeItem` in `braindump.ts`, `markTaskCompleted` in `focus.ts`) need the
 * same patch, so it lives here instead. `completeGoogleTaskForStep` stays in
 * `focus.ts` precisely because it still has only the one caller.
 */

/**
 * The ACTING account's Google access token, or null.
 *
 * #118 Phase C — credentials are per user, so the best-effort Google sync a
 * completion or a requeue performs uses the credential of whoever is acting. A
 * caller with no account (a guest, or a revoked account) has no credential and
 * gets null, which every call site treats as "skip the sync" rather than as an
 * error — the same shape the missing-token branch already had.
 *
 * Before Phase C these call sites resolved the ONE instance-wide row, so a
 * non-owner completing a step would have patched the OWNER's Google task. Not
 * reachable in practice (only the owner could schedule, so only their steps ever
 * carried a googleTaskId) but it stops being possible at all now.
 */
export async function actingUserGoogleToken(): Promise<string | null> {
  const me = await currentUser();
  return me ? getValidAccessToken(me.id) : null;
}

/**
 * Mark a task's OWN Google Task completed. Returns whether Google was patched.
 *
 * #195 — a stepless to-do's scheduling unit is the task itself, so
 * `scheduleSingleTask` writes `Task.googleTaskId`. Only the step twin ever sent
 * `status: "completed"`, so completing such an item in the app left the Google
 * task open and Reclaim kept holding its calendar block.
 *
 * ── The guard is the id, not the step count ─────────────────────────────────
 * "This task has no steps" and "this task carries a Google id" are NOT the same
 * condition, and only the second one is correct. An item scheduled while
 * stepless keeps its task-level Google task for good; steps added afterwards —
 * by an AI breakdown, or lazily by `ensureFocusStep` the first time it is
 * focused — get their own ids from separate `upsertGoogleTask` calls and never
 * inherit the task's. Keying off the step count would strand exactly the task
 * carrying the orphaned Google task, which is the bug being fixed.
 *
 * There is no double-patch to avoid for the same reason: a step id and a task id
 * are always distinct Google tasks, and when a task closes both of them should.
 *
 * ── Best-effort, and that has to be structural ──────────────────────────────
 * A completion the user asked for must never fail because Google is unreachable
 * or a refresh token has gone stale, so *every* failure is swallowed here rather
 * than left to each caller to remember: `patchGoogleTask` throws on a network
 * error, and `getValidAccessToken` throws if the refresh round-trip does. A
 * false return means "not synced", never "the completion failed" — and callers
 * still invoke this AFTER their local writes, so even a leak could not undo one.
 */
export async function completeGoogleTaskForTask(task: {
  googleTaskId: string | null;
  googleTaskListId: string | null;
}): Promise<boolean> {
  if (!task.googleTaskId || !task.googleTaskListId) return false;
  try {
    const token = await actingUserGoogleToken();
    if (!token) return false;
    return await patchGoogleTask(
      token,
      task.googleTaskListId,
      task.googleTaskId,
      { status: "completed" },
    );
  } catch {
    // Best-effort: the local completion has already happened and stands.
    return false;
  }
}
