import { getValidAccessToken, patchGoogleTask } from "@/lib/google";
import { currentUser } from "@/lib/workspace";

/**
 * Best-effort mirroring of a LOCAL state change into Google Tasks.
 *
 * ── Why this is a lib module and not a helper in `focus.ts` ─────────────────
 * The obvious home for these is next to the actions that call them. That is not
 * possible: `focus.ts` is a `"use server"` file, so anything exported from it
 * becomes a publicly callable server action. A module-private helper there
 * cannot be reached from `braindump.ts`, and exporting one to share it would put
 * a raw "patch this Google task" endpoint on the wire, taking an id straight
 * from the client. Both grains now have callers in both files, so both live
 * here: `!288` (#195) moved the task grain, and #209 moved the step grain when
 * `braindump.ts` needed it too, exactly as that MR predicted it would.
 *
 * ── Two grains, one shape, and why the names still differ ───────────────────
 * A `Task` row and a `Step` row both carry `googleTaskId`/`googleTaskListId`,
 * so the patch is one function and the grain-specific exports are thin. They
 * stay separate anyway, because a task id and a step id address **different
 * Google tasks** and a call site has to say which it means — `…ForStep(step)`
 * and `…ForTask(task)` are not interchangeable even though their bodies are.
 * The status stays baked into the name rather than passed at the call site, so
 * that reading `completeGoogleTaskForStep(s)` tells you what happens without
 * looking up an argument.
 *
 * Only the combinations with callers exist. There is no exported task-grain
 * reopen: the one caller that needs it (`reopenItem`) reopens a task and its
 * steps together, and gets `reopenGoogleTasksForItem` instead.
 *
 * ── The ordering invariant every caller owes this module ────────────────────
 * Every caller runs its patch AFTER its local writes and **outside any
 * `$transaction`**. The swallow below is the second line of defence, not the
 * first: a patch awaited inside a transaction would roll the user's own change
 * back on a network blip, which is the trap #196 records for the reopen
 * direction.
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

/** A row carrying (or not carrying) the ids that address one Google Task. */
type GoogleTaskRef = {
  googleTaskId: string | null;
  googleTaskListId: string | null;
};

/** The same row, once both halves of its address are known to be present. */
type ScheduledRef = { googleTaskId: string; googleTaskListId: string };

/**
 * Whether this row addresses a Google task at all.
 *
 * Both halves are required: a list id with no task id (or the reverse) cannot
 * address anything, and a half-written pair must skip rather than build a URL
 * out of `undefined`.
 */
function isScheduled(ref: GoogleTaskRef): ref is ScheduledRef {
  return Boolean(ref.googleTaskId && ref.googleTaskListId);
}

/**
 * PATCH one already-addressable Google Task with an already-resolved token.
 *
 * ── Best-effort, and that has to be structural ──────────────────────────────
 * A change the user asked for must never fail because Google is unreachable, so
 * the failure is swallowed here rather than left to each caller to remember. A
 * false return means "not synced", never "the local change failed".
 *
 * Leaving it to callers is not a theoretical worry — it is what happened.
 * `reopenGoogleTaskForStep` lived in `focus.ts` with no try/catch and exactly
 * one caller that wrapped it, so the contract held by coincidence. #196 adds a
 * second caller, which would have inherited the promise without the protection.
 */
async function patchOne(
  token: string,
  ref: ScheduledRef,
  status: "needsAction" | "completed",
): Promise<boolean> {
  try {
    return await patchGoogleTask(
      token,
      ref.googleTaskListId,
      ref.googleTaskId,
      {
        status,
      },
    );
  } catch {
    return false;
  }
}

/**
 * Set one Google Task's status. Returns whether Google was patched.
 *
 * The credential lookup is inside the try for the same reason as the PATCH:
 * `getValidAccessToken` throws if the refresh round-trip does, and a stale
 * refresh token is not a reason to lose a completion.
 */
async function setGoogleTaskStatus(
  ref: GoogleTaskRef,
  status: "needsAction" | "completed",
): Promise<boolean> {
  if (!isScheduled(ref)) return false;
  try {
    const token = await actingUserGoogleToken();
    if (!token) return false;
    return await patchOne(token, ref, status);
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
  task: GoogleTaskRef,
): Promise<boolean> {
  return setGoogleTaskStatus(task, "completed");
}

/** Mark a step's own Google Task completed. Returns whether Google was patched. */
export async function completeGoogleTaskForStep(
  stepRef: GoogleTaskRef,
): Promise<boolean> {
  return setGoogleTaskStatus(stepRef, "completed");
}

/**
 * The reverse patch at the step grain (#198, #196). `needsAction` is the value
 * `patchGoogleTask` has always accepted and, before `!286`, was never sent —
 * the app could only ever tell Google a task was finished, never that it wasn't.
 */
export async function reopenGoogleTaskForStep(
  stepRef: GoogleTaskRef,
): Promise<boolean> {
  return setGoogleTaskStatus(stepRef, "needsAction");
}

/**
 * How many Google Tasks PATCHes one to-do may have in flight at once.
 *
 * #209 asked whether the patches run in parallel, and both extremes are wrong.
 *
 * **Sequential** costs one round trip per step, and `TASKS_PATCH_TIMEOUT_MS`
 * (`src/lib/google.ts`) allows each 10 s — so a twenty-step breakdown could hold
 * a server action open for over three minutes, and `bulkBrainDumpAction` loops
 * over items on top of that. `!288` bounded the blast radius of one stalled
 * connection; it did not make the loop fast, and said so.
 *
 * **Unbounded** trades that for a burst: every step of a large breakdown opening
 * a connection at once, against an API this app is rate-limited on. Google
 * answers the overflow with 429s, and because these patches swallow their own
 * failures by contract, the user would silently lose syncs rather than wait a
 * moment for them — the failure mode #209 exists to fix, arriving by a new
 * route.
 *
 * 4 is chosen to keep the common case at one round trip's latency (a to-do with
 * a handful of steps) while turning a pathological one into a queue instead of a
 * burst. It is not tuned against a measured quota — there is no per-second
 * figure published for Tasks that would let it be — so it is deliberately small
 * enough that the bound is never the interesting variable.
 */
export const GOOGLE_SYNC_CONCURRENCY = 4;

/**
 * Set every ref to `status` with at most {@link GOOGLE_SYNC_CONCURRENCY} in
 * flight, and report how many Google accepted.
 *
 * This is the one place the grain stops mattering: the caller has already
 * decided which rows it means, and past that point a task's Google task and a
 * step's are the same kind of thing being moved the same way.
 *
 * Refs that address nothing are dropped before the pool rather than inside it,
 * so a to-do that was never scheduled costs no credential lookup and occupies no
 * worker. Nothing here rejects: `patchOne` swallows per patch, which is what
 * makes "one slow or failing step must not abandon the rest" (#209) a property
 * of the code rather than of the comment.
 *
 * ── The credential is resolved ONCE, not per patch ──────────────────────────
 * #209 noted that `actingUserGoogleToken()` resolves per call. Left that way it
 * would be a decrypt and a database read per step, and worse than wasteful:
 * `getValidAccessToken` refreshes a token that is within a minute of expiring,
 * so a pool of N workers hitting an expiring credential fires N concurrent
 * refresh round-trips, each writing the row. Resolving before the fan-out makes
 * that one refresh, and the token cannot expire underneath the pool — the
 * refresh window is a minute and the whole fan-out is bounded by
 * `TASKS_PATCH_TIMEOUT_MS` per patch.
 *
 * It is resolved once per **to-do**, not once per bulk operation:
 * `bulkBrainDumpAction` calls `completeItem` in a loop, so ten selected rows
 * still cost ten lookups. Collapsing that needs `completeItem` split into its
 * local write and its sync so the loop can gather the syncs, which is a change
 * to the action's shape rather than to this module (#209).
 */
async function patchPool(
  refs: readonly GoogleTaskRef[],
  status: "needsAction" | "completed",
): Promise<number> {
  const queue = refs.filter(isScheduled);
  if (!queue.length) return 0;

  let token: string | null = null;
  try {
    token = await actingUserGoogleToken();
  } catch {
    return 0; // a failed refresh costs the sync, never the local change
  }
  if (!token) return 0;
  const credential = token;

  let next = 0;
  let synced = 0;
  const worker = async () => {
    while (next < queue.length) {
      if (await patchOne(credential, queue[next++], status)) synced += 1;
    }
  };
  const workers = Math.min(GOOGLE_SYNC_CONCURRENCY, queue.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return synced;
}

/**
 * Close every Google Task a to-do owns — its own, and one per step (#209).
 *
 * Completing a multi-step to-do from the **inbox** closes all its steps in one
 * `updateMany` and used to patch none of them, so Reclaim kept every block. The
 * focus timer never had the bug because it finishes steps one at a time and each
 * completion patched its own.
 *
 * Both grains are patched and neither implies the other: a to-do scheduled after
 * a breakdown has ids on its steps and none on the task, one scheduled while
 * stepless has the reverse, and one scheduled stepless that later grew steps has
 * both. Pass only the steps this call actually closed — a step that was already
 * done was patched when it was done, and re-patching costs a request per step
 * for no change.
 */
export async function completeGoogleTasksForItem(
  task: GoogleTaskRef | null,
  steps: readonly GoogleTaskRef[],
): Promise<number> {
  return patchPool(task ? [task, ...steps] : steps, "completed");
}

/**
 * The reverse, for `reopenItem` (#196) — put every Google Task a reopen just
 * un-completed back to `needsAction`, so Reclaim re-books the time.
 *
 * Pass only the steps that actually went done → not-done, for the same reason
 * the completion twin takes only the ones it closed.
 */
export async function reopenGoogleTasksForItem(
  task: GoogleTaskRef | null,
  steps: readonly GoogleTaskRef[],
): Promise<number> {
  return patchPool(task ? [task, ...steps] : steps, "needsAction");
}
