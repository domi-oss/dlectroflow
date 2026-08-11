"use server";

import { revalidatePath } from "next/cache";
import { prisma, getSettings } from "@/lib/db";
import {
  getValidAccessToken,
  googleConfigured,
  findReclaimList,
  listTaskLists,
  upsertGoogleTask,
  getGoogleStatus,
  disconnectGoogle,
} from "@/lib/google";
import { currentWorkspaceId, currentUser } from "@/lib/workspace";
import { awardFirstSchedule } from "@/lib/scheduling/award";
import { SchedulingMethod } from "@/lib/scheduling/types";
import type { ScheduleIntent, ScheduleUnit } from "@/lib/scheduling/types";
import { defaultIntentFor } from "@/lib/scheduling/intent";
import { deriveWindows } from "@/lib/scheduling/windows";
import { pickEncoder } from "@/lib/scheduling/encoder";
import { publicOrigin } from "@/lib/origin";
import type { Voice } from "@/lib/strings";
import { brainDumpItemToTaskData } from "@/lib/braindump-to-task";
import { TASK_WRITER_TX_BUDGET } from "@/lib/constants";

export type GoogleScheduleResult =
  | { ok: true; scheduled: number; listTitle: string }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "not_connected"
        | "reconnect_required"
        | "no_reclaim_list"
        | "no_steps"
        | "error";
      message?: string;
    };

/**
 * Push a task's steps into the Reclaim-synced Google Tasks list. Reclaim then
 * auto-syncs + schedules them. Sidesteps the MCP write gate entirely.
 */
export async function pushStepsToGoogleTasks(
  taskId: string,
  /** #106 — what the owner chose in the Schedule menu. Optional, so every call
   *  site written before the menu existed keeps its defaults-only behaviour. */
  suppliedIntent?: ScheduleIntent,
): Promise<GoogleScheduleResult> {
  const workspaceId = await currentWorkspaceId();
  // #118 Phase C — "signed in, acting on their own credential" replaces the
  // owner check. Note what is NOT here and never will be: an id parameter. The
  // credential is looked up BY me.id, so there is no other row to reach — which
  // is the whole isolation argument, and why the scoping harness can assert it.
  // Also covers revocation: a revoked account resolves to null on its very next
  // request, without waiting for a 30-day cookie to expire.
  const me = await currentUser();
  if (!me) throw new Error("sign in required");

  if (!googleConfigured()) return { ok: false, reason: "not_configured" };
  const token = await getValidAccessToken(me.id);
  if (!token) {
    const status = await getGoogleStatus(me.id);
    return {
      ok: false,
      reason: status.needsReconnect ? "reconnect_required" : "not_connected",
    };
  }

  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!task || task.steps.length === 0)
    return { ok: false, reason: "no_steps" };

  try {
    const list = await findReclaimList(token);
    if (!list) {
      const names = (await listTaskLists(token)).map((l) => l.title).join(", ");
      return {
        ok: false,
        reason: "no_reclaim_list",
        message: `Couldn't find the "🗓 Reclaim" Google Tasks list. Available: ${names || "none"}. Reclaim only syncs from that list — create it in Google Tasks, or set GOOGLE_TASKS_LIST_NAME if you use a different scheduler.`,
      };
    }

    const settings = await getSettings(workspaceId);
    const voice: Voice = settings.voice === "playful" ? "playful" : "plain";
    const origin = publicOrigin();
    const encode = pickEncoder(list.title);

    const units: ScheduleUnit[] = task.steps.map((s) => ({
      id: s.id,
      order: s.order,
      total: task.steps.length,
      text: s.text,
      emoji: s.subtaskEmoji,
      estMinutes: s.estMinutes,
      dueAt: null,
    }));
    // The menu (#106) supplies an intent; the bare 📅 path does not and gets the
    // defaults. `units` ALWAYS comes from the database rather than from the
    // supplied intent, so a client cannot smuggle in steps that do not exist —
    // or drop ones that do — and have us schedule work the task never contained.
    const intent: ScheduleIntent = suppliedIntent
      ? { ...suppliedIntent, units }
      : defaultIntentFor(units);
    const { windows } = deriveWindows(intent);
    const byUnit = new Map(windows.map((w) => [w.unitId, w]));

    // #44 — step notes by id, built once from the SCOPED rows rather than
    // looked up per unit inside the loop. `intent.units` comes from the client,
    // so a unit id that is not one of this task's steps simply misses and gets
    // no note; it cannot reach another task's.
    const stepNotes = new Map(task.steps.map((s) => [s.id, s.notes]));

    let scheduled = 0;
    for (const unit of intent.units) {
      const window = byUnit.get(unit.id);
      if (!window) continue;
      const encoded = encode({
        unit,
        window,
        intent,
        taskTitle: task.title,
        parentEmoji: task.parentEmoji ?? "🗂️",
        origin,
        voice,
        // #44 — the task's note on every unit, plus THIS step's own. Both are
        // read from the scoped `task` above, so neither can come from the
        // caller: `intent.units` is client-supplied and is used for the id
        // only, exactly as the comment above already requires.
        taskNote: task.notes,
        stepNote: stepNotes.get(unit.id) ?? null,
      });
      const step = task.steps.find((s) => s.id === unit.id)!;
      const { id } = await upsertGoogleTask(
        token,
        list.id,
        step.googleTaskId,
        encoded,
      );
      // Guard step ownership before update (unchanged from before).
      const stepCheck = await prisma.step.findFirst({
        where: { id: unit.id, task: { workspaceId } },
      });
      if (stepCheck) {
        await prisma.step.update({
          where: { id: unit.id },
          data: { googleTaskId: id, googleTaskListId: list.id },
        });
      }
      scheduled++;
    }

    // Provider-agnostic marker + reward once (mirrors scheduleViaIcs so ICS and
    // Google share one "already scheduled" signal). The steps are already pushed
    // + committed above, so a reward failure must not return { ok: false } and
    // prompt a retry (which would duplicate the Google tasks) — the shared
    // helper keeps rewards best-effort (#34).
    //
    // #106 folds the chosen intent into this same update. The three schedule
    // columns are written ONLY when an intent was actually supplied: a
    // defaults-only push must not quietly overwrite what the owner picked last
    // time, which is the whole point of persisting them. And the marker stays a
    // FIRST-schedule fact, so a re-push records the new intent without
    // restamping scheduledAt or re-awarding.
    if (task.scheduledAt == null || suppliedIntent) {
      await prisma.task.update({
        where: { id: task.id },
        data: {
          ...(task.scheduledAt == null
            ? {
                scheduledAt: new Date(),
                scheduledVia: SchedulingMethod.GoogleTasks,
              }
            : {}),
          ...(suppliedIntent
            ? {
                scheduleDueAt: suppliedIntent.dueAt,
                schedulePriority: suppliedIntent.priority,
                scheduleHours: suppliedIntent.hours,
              }
            : {}),
        },
      });
    }
    if (task.scheduledAt == null) {
      // Pass the captured pre-write state (false inside this guard, but robust to
      // the guard being removed) rather than a hardcoded literal — matches
      // awardFirstSchedule's contract + scheduleSingleTask's pattern (#34).
      await awardFirstSchedule(workspaceId, task.scheduledAt != null);
    }

    revalidatePath(`/tasks/${taskId}`);
    return { ok: true, scheduled, listTitle: list.title };
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      message: err instanceof Error ? err.message : "Google Tasks push failed",
    };
  }
}

export type GoogleScheduleSingleResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "not_configured"
        | "not_connected"
        | "no_reclaim_list"
        | "reconnect_required"
        | "error";
      message?: string;
    };

/**
 * Schedule a single to-do (Single-task bucket row) as one Google Task, using
 * the same `(duration:Nm)` convention Reclaim parses off step titles. The row
 * may not have a linked Task yet (e.g. triaged straight from the inbox with
 * no steps) — mirrors `keepAsTask`/`ensureFocusStep` in braindump.ts by
 * creating one lazily so the googleTaskId has somewhere to live.
 *
 * ## At most one Task per item, however many callers reach this at once (#244)
 *
 * This is the fourth of the four brain-dump→Task writers `braindump-to-task.ts`
 * names, and the one #225 closed the other three of while recording this one as
 * **outstanding rather than quietly counting it as safe**. It had a
 * `$transaction` already, from a Duo round on #179 that asked for the insert and
 * the link to commit together — and that is all it did. The DECISION to enter it
 * was still an unlocked check-then-act: `item.taskId` came from the plain
 * `findFirst` above, taken before any lock existed, and in READ COMMITTED a plain
 * `SELECT` does not wait on a row lock — it reads the last committed version. A
 * caller whose read landed before a concurrent winner committed therefore saw
 * NULL, entered the branch, and its `update({ where: { id } })` — nothing in that
 * `where` mentioned `taskId` — repointed the item at its own brand-new `Task` as
 * soon as the block cleared.
 *
 * Two `Task` rows. The item points at the loser's; the winner's is reachable from
 * no inbox row while `focus/page.tsx`, `calendar-feed.ts` and `export/collect.ts`
 * all still count it, and any steps it carried go with it.
 *
 * Measured on real Postgres before the fix — see
 * `schedule-single-task.integration.test.ts`, which arranges the interleaving
 * rather than hoping for it.
 *
 * ## Why the guard is `ensureFocusStep`'s shape and not `keepAsTask`'s
 *
 * `keepAsTask` takes the row lock with its triage stamp, because it *has* one to
 * write, and then branches in JS on the row `updateManyAndReturn` hands back.
 * **Scheduling must not triage** — the Schedule button is offered on a row
 * wherever it already sits, and stamping `status`/`triagedAt` here would move it
 * — so there is no column to stamp and no lock to take up front. The precondition
 * therefore goes on the LINK, which is the write that must not happen twice:
 * `taskId: null` in the `where`, gated on `count`, the shape `ensureFocusStep`,
 * `reopenItem` and `uncompleteStep` use. A loser's `UPDATE` blocks on the
 * winner's row lock; Postgres re-qualifies a blocked `UPDATE` against the
 * committed row, the `taskId IS NULL` term no longer holds, and it matches zero
 * rows — which is how it learns it lost, deterministically rather than by
 * comparing two reads.
 *
 * The speculative `Task` is then discarded inside the same transaction, so
 * nothing outside it ever sees that row, and the winner's is adopted instead.
 *
 * ## The two values re-read from the winner, and why each has to be
 *
 * Both were derived from the pre-lock snapshot, where `item.task` is NULL **by
 * construction** on exactly this path — so on the adopt branch each would
 * otherwise describe a `Task` this call did not end up using:
 *
 * - **`taskNote`**, the note the Google payload carries. #179's review (`!281`)
 *   already fixed the create branch to read it back from the row that was
 *   actually written, for precisely this reason; the adopt branch is the same
 *   argument one case wider.
 * - **`alreadyScheduled`**, the reward idempotency marker. A winner that had
 *   already stamped `scheduledAt` would otherwise be re-awarded here, because the
 *   snapshot says "never scheduled" about a `Task` that did not exist when it was
 *   taken. Small, and a silent points duplication is exactly the kind of thing
 *   nobody reports.
 *
 * The Google payload's title stays `item.text`, deliberately, rather than being
 * re-read as `Task.title`. That is unchanged from before: the item's text is the
 * source and the task's title is a copy of it, so reading the copy would add a
 * second derivation of a value #179 exists to have exactly one of.
 */
export async function scheduleSingleTask(
  itemId: string,
  estMinutes: number,
): Promise<GoogleScheduleSingleResult> {
  const workspaceId = await currentWorkspaceId();
  // #118 Phase C — "signed in, acting on their own credential" replaces the
  // owner check. Note what is NOT here and never will be: an id parameter. The
  // credential is looked up BY me.id, so there is no other row to reach — which
  // is the whole isolation argument, and why the scoping harness can assert it.
  // Also covers revocation: a revoked account resolves to null on its very next
  // request, without waiting for a 30-day cookie to expire.
  const me = await currentUser();
  if (!me) throw new Error("sign in required");

  // Server-side clamp (final-review fix): the client popover already refuses
  // out-of-range custom durations, but this action is the single source of
  // truth — round to the nearest minute and reject anything outside 1..480
  // rather than trust caller input.
  const minutes = Math.round(estMinutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 480) {
    return {
      ok: false,
      reason: "error",
      message: "Duration must be 1-480 minutes",
    };
  }

  if (!googleConfigured()) return { ok: false, reason: "not_configured" };
  const token = await getValidAccessToken(me.id);
  if (!token) {
    const status = await getGoogleStatus(me.id);
    return {
      ok: false,
      reason: status.needsReconnect ? "reconnect_required" : "not_connected",
    };
  }

  const item = await prisma.brainDumpItem.findFirst({
    where: { id: itemId, workspaceId },
    include: { task: true },
  });
  if (!item) return { ok: false, reason: "error", message: "Item not found" };

  // Reward parity with pushStepsToGoogleTasks (#25): a successful schedule earns
  // Scheduled (+10) and, first ever, the FirstSchedule badge. Idempotency is
  // now keyed on the provider-agnostic `scheduledAt` marker (S0, #29) so ICS and
  // Google share one "already scheduled" signal — a task scheduled by EITHER
  // method won't re-award (the Scheduled points aren't idempotent; awardBadge
  // already is). Captured before the update below so re-scheduling is a no-op
  // reward-wise. `let`, not `const`, because the lazy-create block below can
  // adopt somebody else's Task and has to answer for THAT row instead (#244).
  let alreadyScheduled = item.task?.scheduledAt != null;

  let taskId = item.taskId;
  // #179 review (`!281`) — the note the Google Task payload must carry, derived
  // ONCE, here, before the branch below can change what the answer is.
  //
  // Re-reading `item.task?.notes` after the lazy-create is stale BY CONSTRUCTION:
  // `item.task` was fetched before this point, so it is null in exactly the case
  // where the note has just been written to a brand-new Task. The old comment on
  // the payload line said as much — "a task that did not exist a moment ago has no
  // note" — which was true until this MR made `brainDumpItemToTaskData` copy
  // `item.notes` across at creation.
  let taskNote: string | null = item.task?.notes ?? null;
  if (!taskId) {
    // Atomic lazy-create (Duo review): the Task insert and the item link must
    // commit together — otherwise a failed link orphans the Task row and a
    // retry creates a second one (the item's taskId stays null).
    //
    // #244 — and the LINK carries the precondition, so `taskId` being null in the
    // snapshot above is a hint that this branch is worth entering rather than a
    // fact it may act on. See the docblock: the read that produced it took no
    // lock, so two callers can both be here at once.
    const linked = await prisma.$transaction(async (tx) => {
      // #179 — the ONE conversion. It returns data only, which is exactly why it
      // can be used inside this transaction: the insert and the item link still
      // commit together.
      const task = await tx.task.create({
        data: brainDumpItemToTaskData(item, workspaceId),
      });
      const claimed = await tx.brainDumpItem.updateMany({
        // `taskId: null` is the guard, and `workspaceId` keeps the scope on the
        // write itself rather than inherited from the read above it.
        where: { id: item.id, workspaceId, taskId: null },
        data: { taskId: task.id },
      });
      if (claimed.count === 0) {
        // Lost the race, or the row went away. Drop the Task nobody outside this
        // transaction has seen and go and read what actually won — the re-read is
        // a new statement, so it sees the commit whose lock this transaction just
        // waited on.
        //
        // `deleteMany` with `workspaceId`, not `delete` by id (Duo review). Safe
        // either way today — `task.id` is a row this same transaction created two
        // statements up, through `brainDumpItemToTaskData(item, workspaceId)`, so
        // there is no other row to reach. It is fixed anyway because it was the
        // ONE write in this block whose scope was inherited from the read above
        // rather than carried on the operation, which is the exact sentence the
        // `updateMany` two lines up is commented with. "Not reachable today" is
        // not a property the next person to copy this shape can rely on, and
        // `deleteBrainDumpItem` in `braindump.ts` already writes it the scoped
        // way — so this was the outlier, not the convention.
        //
        // It also moves the check from `scoping.harness.test.ts`'s GUARDED_OPS,
        // which accepts a by-id write when some EARLIER statement in the function
        // established scope, into its STRICT_OPS, which requires `workspaceId` in
        // the call's own arguments. The stronger of the two rules for free.
        await tx.task.deleteMany({ where: { id: task.id, workspaceId } });
        const winner = await tx.brainDumpItem.findFirst({
          where: { id: item.id, workspaceId },
          select: {
            taskId: true,
            task: { select: { notes: true, scheduledAt: true } },
          },
        });
        if (!winner?.taskId) return null;
        return {
          id: winner.taskId,
          notes: winner.task?.notes ?? null,
          scheduledAt: winner.task?.scheduledAt ?? null,
        };
      }
      // The note is taken from the row that was actually written, not re-derived
      // from `item`. `brainDumpItemToTaskData` normalises and re-validates on the
      // way across, so a second derivation here could disagree with what landed —
      // and the whole point of that helper is that there is one conversion.
      return {
        id: task.id,
        notes: task.notes ?? null,
        scheduledAt: task.scheduledAt,
      };
    }, TASK_WRITER_TX_BUDGET);
    // The item is gone, or belongs to somebody else — the same outcome the read
    // above gives for a missing row, decided here by the write's own `where`. A
    // RESULT, not a throw: this is reachable by scheduling a row a second tab has
    // just deleted, which is not an error to put in front of anybody.
    if (!linked) {
      return { ok: false, reason: "error", message: "Item not found" };
    }
    taskId = linked.id;
    taskNote = linked.notes;
    alreadyScheduled = linked.scheduledAt != null;
    // Invalidate the cache now that the item has a linked Task, regardless of
    // whether the Google Tasks push below succeeds — a later failure must not
    // leave the inbox serving stale data for the new task row (Duo review).
    revalidatePath("/");
  }

  try {
    const list = await findReclaimList(token);
    if (!list) return { ok: false, reason: "no_reclaim_list" };

    const encode = pickEncoder(list.title);
    const unit: ScheduleUnit = {
      id: taskId,
      order: 1,
      total: 1,
      text: item.text,
      emoji: null,
      // The caller's clamped duration IS the estimate for a stepless to-do.
      estMinutes: minutes,
    };
    const intent = defaultIntentFor([unit]);
    const { windows } = deriveWindows(intent);
    const settings = await getSettings(workspaceId);
    const voice: Voice = settings.voice === "playful" ? "playful" : "plain";
    const encoded = encode({
      unit,
      window: windows[0],
      intent,
      taskTitle: item.text,
      parentEmoji: null,
      origin: publicOrigin(),
      voice,
      // #44 / #179 — resolved above, once, rather than read from `item.task`
      // here. That read was null in exactly the lazy-create case where the note
      // had just been written, so the note reached Postgres and never reached
      // Google. No step note: this path schedules a stepless to-do, whose unit id
      // is the TASK's id.
      taskNote,
    });
    const existing = await prisma.task.findFirst({
      where: { id: taskId, workspaceId },
      select: { googleTaskId: true },
    });
    const created = await upsertGoogleTask(
      token,
      list.id,
      existing?.googleTaskId ?? null,
      encoded,
    );

    await prisma.task.update({
      where: { id: taskId },
      data: {
        googleTaskId: created.id,
        googleTaskListId: list.id,
        // Stamp the provider-agnostic marker on the first schedule (any method).
        // Folded into this same update (rather than a second one) — which is why
        // the shared reward helper stays marker-agnostic (it awards, callers stamp).
        ...(alreadyScheduled
          ? {}
          : {
              scheduledAt: new Date(),
              scheduledVia: SchedulingMethod.GoogleTasks,
            }),
      },
    });

    // Best-effort rewards through the shared seam helper: the Google task +
    // task.update have already committed, so a reward failure must NOT return
    // { ok: false } (a retry would duplicate the Google task). Idempotent on the
    // captured `alreadyScheduled` marker so re-scheduling never re-awards (#34).
    await awardFirstSchedule(workspaceId, alreadyScheduled);

    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      message: err instanceof Error ? err.message : "Google Tasks push failed",
    };
  }
}

// #118 — the `googleStatus()` server action is GONE. It was owner-gated with
// zero non-test callers and still a reachable RPC endpoint; every real caller
// reads getGoogleStatus() at the server boundary instead. Deleted rather than
// re-gated: carrying a live endpoint forward for nobody is how a surface grows.

/**
 * Disconnect the CALLER's own Google connection.
 *
 * `ok` is not the whole answer (#126). The stored tokens are deleted whatever
 * Google says, so the disconnect at this end always happens — but Google can
 * refuse the revoke (a grant it has already expired, a 5xx), and then the
 * app is listed in that person's Google account with no token left here to
 * revoke it with. `revoked: false` says so, because the only remaining step is
 * theirs to take at <https://myaccount.google.com/permissions>, and telling
 * them it is finished when it is not is the withdrawal gap #126 exists to close.
 *
 * This is the caller's OWN connection, so there is nothing to withhold here —
 * unlike `revokePerson`, where the same information would disclose whether
 * another member had connected Google.
 */
export async function disconnectGoogleTasks(): Promise<{
  ok: true;
  /** Did Google accept the revoke? `false` leaves one step for the user. */
  revoked: boolean;
}> {
  // #118 Phase C — you disconnect YOUR OWN connection. No id parameter, so
  // there is no other account's credential this could revoke.
  const me = await currentUser();
  if (!me) throw new Error("sign in required");
  const revoked = await disconnectGoogle(me.id);
  revalidatePath("/settings");
  return { ok: true, revoked };
}
