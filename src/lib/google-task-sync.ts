import { getValidAccessToken, patchGoogleTask } from "@/lib/google";
import { currentUser } from "@/lib/workspace";

/**
 * Best-effort mirroring of a LOCAL state change into Google Tasks, for the
 * units whose Google id lives on the **Task** row rather than on a step.
 *
 * ── Why this is a lib module and not another helper in `focus.ts` ───────────
 * The step-grain helpers live in `focus.ts` and the obvious thing is to put
 * their task-grain twins beside them. That is not possible: `focus.ts` is a
 * `"use server"` file, so anything exported from it becomes a publicly callable
 * server action. A module-private helper there cannot be reached from
 * `braindump.ts`, and exporting one to share it would put a raw "complete this
 * Google task" endpoint on the wire, taking an id straight from the client.
 * Both completion routes (`completeItem` in `braindump.ts`, `markTaskCompleted`
 * in `focus.ts`) need the same patch, so the task grain lives here instead.
 * `completeGoogleTaskForStep` stays in `focus.ts` because it still has only
 * that file's callers; #209 moves it here when `braindump.ts` needs it too.
 *
 * ── Shaped for the reopen twin that is coming ───────────────────────────────
 * #196 is the mirror of #195 and needs `needsAction` at this same grain, so the
 * patch is factored into `setGoogleTaskStatusForTask` and the exported name
 * stays specific — matching the `completeGoogleTaskForStep` /
 * `reopenGoogleTaskForStep` pair `!286` established, rather than exporting one
 * status-parameterised function whose call sites read `…ForTask(t, "completed")`
 * at the step grain's `completeGoogleTaskForStep(s)`. Adding
 * `reopenGoogleTaskForTask` is then three lines here and nothing anywhere else.
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

/** A task carrying (or not carrying) the ids that address its own Google Task. */
type TaskGoogleRef = {
  googleTaskId: string | null;
  googleTaskListId: string | null;
};

/**
 * Set a task's OWN Google Task status. Returns whether Google was patched.
 *
 * ── Best-effort, and that has to be structural ──────────────────────────────
 * A change the user asked for must never fail because Google is unreachable or
 * a refresh token has gone stale, so *every* failure is swallowed here rather
 * than left to each caller to remember: `patchGoogleTask` throws on a network
 * error, and `getValidAccessToken` throws if the refresh round-trip does. A
 * false return means "not synced", never "the local change failed".
 *
 * The swallow is a second line of defence, not the first: every caller invokes
 * this AFTER its local writes and **outside any `$transaction`**, so a Google
 * failure has nothing left to undo. That ordering is the important half — a
 * patch awaited inside a transaction would roll the user's own change back on a
 * network blip, which is the trap #196 records for the reopen direction.
 */
async function setGoogleTaskStatusForTask(
  task: TaskGoogleRef,
  status: "needsAction" | "completed",
): Promise<boolean> {
  if (!task.googleTaskId || !task.googleTaskListId) return false;
  try {
    const token = await actingUserGoogleToken();
    if (!token) return false;
    return await patchGoogleTask(
      token,
      task.googleTaskListId,
      task.googleTaskId,
      { status },
    );
  } catch {
    return false;
  }
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
 */
export async function completeGoogleTaskForTask(
  task: TaskGoogleRef,
): Promise<boolean> {
  return setGoogleTaskStatusForTask(task, "completed");
}
