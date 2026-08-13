"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  BrainDumpStatus,
  TaskSource,
  TaskStatus,
  RewardType,
  BadgeKey,
  TASK_WRITER_TX_BUDGET,
} from "@/lib/constants";
import { logReward, awardBadge, touchStreakOnEngagement } from "@/lib/rewards";
import { bestEffort } from "@/lib/best-effort";
import type { Proposal } from "@/lib/breakdown";
import { currentWorkspaceId } from "@/lib/workspace";
import { brainDumpItemToTaskData } from "@/lib/braindump-to-task";

/**
 * Launch a breakdown from a brain-dump item: create (or reuse) its Task and
 * triage the item. Returns the task id to navigate to.
 *
 * ## At most one Task per item, however many times this is called (#225)
 *
 * This used to be `findFirst` → `if (item.taskId) return item.taskId` →
 * `task.create` → link, outside any transaction. `keepAsTask`'s docblock in
 * `braindump.ts` excused it as already guarded on the strength of that check,
 * and the check is the problem: an unlocked check-then-act is the exact shape
 * that docblock's own reasoning describes as the defect. The read is served from
 * a snapshot taken before a concurrent winner committed, so both callers see
 * `taskId` as NULL, both create, and the second link repoints the item at its
 * own Task — leaving the first reachable from no inbox row while
 * `focus/page.tsx`, `calendar-feed.ts` and `export/collect.ts` all still count
 * it, and stranding any steps it carried.
 *
 * Measured on real Postgres before the fix (!306, substitute review): two
 * overlapping presses produced two Tasks and one orphan. !306 also puts this
 * write behind the failure notice's **Retry**, and `withActionTimeout` bounds how
 * long the UI waits rather than how long the request runs, so a Retry can fire a
 * second press at a row whose first one is still going.
 *
 * The fix is `keepAsTask`'s, because this action has what that one has and
 * `ensureFocusStep` does not: a triage stamp to write. That stamp becomes the
 * FIRST write in an interactive transaction and takes the row lock;
 * `updateManyAndReturn` scoped `{ id, workspaceId }` hands the row back AS
 * UPDATED, and Postgres re-evaluates a blocked `UPDATE` against the committed
 * version, so the `taskId` a loser reads back is the winner's. Zero rows means
 * the row is gone or belongs to somebody else — a no-op, not an error to raise at
 * someone who pressed a button twice.
 *
 * The link write is inside the same transaction rather than after it: autocommit
 * would release the lock the moment the stamp landed, and a second caller would
 * then read `taskId` as NULL because the first has not created its Task yet.
 * That window is the whole defect.
 *
 * The guard is on `taskId`, NOT on `status`: `triageBrainDumpItem` and
 * `requestBreakdown` both set `Triaged` without creating a Task, so a
 * status-shaped guard would refuse the one press that still owes those items one.
 */
export async function startBreakdown(itemId: string): Promise<string | null> {
  const workspaceId = await currentWorkspaceId();

  const taskId = await prisma.$transaction(async (tx) => {
    const [item] = await tx.brainDumpItem.updateManyAndReturn({
      where: { id: itemId, workspaceId },
      data: {
        status: BrainDumpStatus.Triaged,
        triagedAt: new Date(),
      },
      // Exactly `BrainDumpItemForTask` plus the guard column, for the reason
      // `keepAsTask` names: a `select` rather than the whole row is what makes a
      // sixth column being added to the conversion a compile error here rather
      // than a silent drop.
      select: {
        taskId: true,
        text: true,
        notes: true,
        scheduleDueAt: true,
        schedulePriority: true,
        scheduleHours: true,
      },
    });
    // The row is gone, or is not this workspace's — the same no-op the
    // `findFirst` guard gave, now decided by the write's own `where`, so the
    // scope travels with the operation instead of being inherited from a read.
    if (!item) return null;
    // Somebody already gave this item a Task: the winner of a race, an earlier
    // call this one is a retry of, ▶ Focus, or a re-triage after `moveToReview`
    // (which keeps the Task on purpose, "so re-triaging reuses the same
    // breakdown"). Adopt it — and returning it rather than null is what keeps
    // this action honestly idempotent, since the caller navigates to whatever
    // comes back.
    if (item.taskId) return item.taskId;

    // #179 — the ONE conversion, so the note and the schedule intent cross with
    // the item. This path is the one a breakdown reads from, which makes a dropped
    // note here a worse failure than elsewhere: the AI would plan the task without
    // the detail that most often makes the steps sensible.
    const task = await tx.task.create({
      data: brainDumpItemToTaskData(item, workspaceId),
    });
    await tx.brainDumpItem.update({
      where: { id: itemId },
      data: { taskId: task.id },
    });
    return task.id;
  }, TASK_WRITER_TX_BUDGET);

  if (taskId === null) return null;
  revalidatePath("/");
  return taskId;
}

/** Create a standalone task (not from the inbox) and return its id. */
export async function createTask(title: string): Promise<string | null> {
  const workspaceId = await currentWorkspaceId();
  const trimmed = title.trim();
  if (!trimmed) return null;
  const task = await prisma.task.create({
    data: {
      title: trimmed,
      source: TaskSource.Manual,
      status: TaskStatus.Active,
      workspaceId,
    },
  });
  return task.id;
}

/**
 * Eject a persisted step back into the inbox as its own "needs review" item
 * (a bigger task to re-triage), remove it from its task, and renumber the
 * remaining steps so order/total stay contiguous. Workspace-scoped + IDOR-safe
 * (findFirst gated on `task.workspaceId`, so another workspace's step id
 * resolves to null and is a no-op). Returns the task id and how many steps
 * remain (0 ⇒ the task is now empty, which the caller resolves via the re-plan
 * / keep-as-todo chooser).
 */
export async function ejectStepToInbox(
  stepId: string,
): Promise<{ taskId: string; remaining: number } | null> {
  const workspaceId = await currentWorkspaceId();
  const step = await prisma.step.findFirst({
    where: { id: stepId, task: { workspaceId } },
  });
  if (!step) return null;
  const { taskId } = step;

  await prisma.brainDumpItem.create({
    data: { text: step.text, workspaceId, status: BrainDumpStatus.Inbox },
  });
  await prisma.step.delete({ where: { id: stepId } });

  const remaining = await prisma.step.findMany({
    where: { taskId },
    orderBy: { order: "asc" },
  });
  const total = remaining.length;
  if (total > 0) {
    await prisma.$transaction(
      remaining.map((s, i) =>
        prisma.step.update({
          where: { id: s.id },
          data: { order: i + 1, total },
        }),
      ),
    );
  }

  revalidatePath(`/tasks/${taskId}`);
  revalidatePath("/");
  return { taskId, remaining: total };
}

/**
 * Persist a confirmed breakdown: set the parent emoji and replace the task's
 * steps with the proposal. (Scheduling is wired via the Google Tasks / calendar
 * export routes.)
 *
 * ## The payout is BEST-EFFORT (#257)
 *
 * The steps commit in their own `$transaction`, and everything after it is a
 * consequence of that success — so none of it may report the breakdown as
 * failed. Until #257 the three statements below propagated: a user pressed
 * Confirm, the steps landed, a transient fault in the streak touch rejected the
 * action, and the UI said the breakdown had not saved over steps that were in
 * the database. Their next move is to press Confirm again, which is a wasted
 * press rather than a duplicate — `confirmBreakdown` replaces the step set
 * rather than appending to it — but the message is still a lie.
 *
 * All three are wrapped, not only the streak touch the issue names: it is the
 * LAST of the three, so fixing it alone would leave `logReward` and `awardBadge`
 * able to un-report the same commit one line earlier. Read `src/lib/best-effort.ts`
 * for the rule, the two rejected alternatives (join the transaction, recover on
 * retry) and why they are worse.
 *
 * **The residual, stated rather than implied:** exactly the payout that faulted,
 * and not the other two. The badge is once-ever and idempotent, so the next
 * confirm earns it. The streak is not banked *at all* only when the person makes
 * no other qualifying engagement that working day — `Streak.lastActiveWorkday`
 * makes it a per-day boolean, so any capture, completion or later confirm credits
 * the same day in full and nothing is left half-advanced. The points for this one
 * confirm are lost, and that is the whole cost.
 *
 * ## THREE calls, not one thunk (Duo review, `!339`)
 *
 * These three were bundled into a single `bestEffort` thunk, which was wrong in a
 * way the false-failure framing above hides. A thunk runs sequentially, so the
 * FIRST rejection cancelled the statements behind it: a `logReward` fault
 * silently cost the FirstBreakdown badge and the day's streak credit too, and one
 * shared tag could not tell an operator which of the three had actually been
 * lost. Three calls with three tags, the shape `completeFocus` already uses.
 *
 * **Splitting is safe here, and that had to be checked rather than assumed** —
 * `best-effort.ts` notes that `rewardStepDone`'s payouts must stay bundled
 * because `maybeAwardTenStepsDay` counts the `RewardEvent` that `logReward` has
 * just written. These three have no such edge: `awardBadge` is a once-ever
 * `findUnique` + `skipDuplicates` insert, `touchStreakOnEngagement` reads
 * `Settings` and `Streak` and takes its own `SELECT … FOR UPDATE`, and neither
 * reads `RewardEvent` at all. Splitting also introduces no double-pay, because it
 * changes nothing about what a retry re-runs — a retried confirm always re-runs
 * all three, which is the pre-existing reason this swallow exists at all
 * (`logReward` appends, so a false failure that provoked a retry would bank the
 * points twice).
 *
 * The revalidations run either way, deliberately, and are NOT gated on the
 * payout: the steps are saved, so skipping them would leave the person's own tab
 * rendering a task with no steps. `reopenItem` records the same rule in as many
 * words — "each request still has to refresh its own render, whoever did the
 * write".
 */
export async function confirmBreakdown(taskId: string, proposal: Proposal) {
  const workspaceId = await currentWorkspaceId();
  const steps = (proposal.steps ?? []).filter((s) => s.text?.trim());
  const total = steps.length;
  if (total === 0) return;

  const existingTask = await prisma.task.findFirst({
    where: { id: taskId, workspaceId },
  });
  if (!existingTask) return;

  await prisma.$transaction([
    prisma.task.update({
      where: { id: taskId },
      data: {
        parentEmoji: proposal.parentEmoji || null,
        status: TaskStatus.Active,
      },
    }),
    prisma.step.deleteMany({ where: { taskId } }),
    prisma.step.createMany({
      data: steps.map((s, i) => ({
        taskId,
        text: s.text.trim(),
        order: i + 1,
        total,
        estMinutes: Math.max(1, Math.round(s.estMinutes || 15)),
        subtaskEmoji: s.subtaskEmoji || null,
      })),
    }),
  ]);

  // Best-effort: the steps above are committed, so no fault here may report the
  // confirm as failed (#257). THREE calls rather than one thunk so that one
  // failing payout cannot cancel the others, and so the tag alone says which was
  // lost — see this function's docblock for the independence argument and the
  // residual.
  await bestEffort("breakdown_points_failed", workspaceId, () =>
    logReward(workspaceId, RewardType.BreakdownConfirmed),
  );
  await bestEffort("breakdown_badge_failed", workspaceId, () =>
    awardBadge(workspaceId, BadgeKey.FirstBreakdown),
  );
  // A breakdown-confirm is a qualifying engagement (Decision 1) — advances the
  // streak at most once per working day.
  await bestEffort("breakdown_streak_touch_failed", workspaceId, () =>
    touchStreakOnEngagement(workspaceId),
  );

  revalidatePath(`/tasks/${taskId}`);
  revalidatePath("/");
}
