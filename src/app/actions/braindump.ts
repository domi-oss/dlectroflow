"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  maybeAwardInboxZero,
  maybeAwardTenStepsDay,
  logReward,
  awardBadge,
  touchStreakOnCompletion,
  touchStreakOnEngagement,
  reverseItemCompletionRewards,
} from "@/lib/rewards";
import {
  BrainDumpStatus,
  TaskStatus,
  RewardType,
  BadgeKey,
} from "@/lib/constants";
import { currentWorkspaceId } from "@/lib/workspace";
import {
  splitInlineNote,
  resolveInlineNoteEdit,
} from "@/lib/braindump-note-syntax";
import { brainDumpItemToTaskData, liveNote } from "@/lib/braindump-to-task";
import { normalizeTaskNote } from "@/lib/task-notes";
import {
  completeGoogleTasksForItem,
  reopenGoogleTasksForItem,
} from "@/lib/google-task-sync";

const INBOX_PATH = "/";
const LIBRARY_PATH = "/library";

/**
 * Capture a brain dump, splitting off an inline note if it carries one (#179).
 *
 * `water the plants {can under sink}` stores text and note separately, so
 * context can be jotted at the speed of capture rather than after triage. The
 * rule is end-anchored and deliberately strict — see
 * `src/lib/braindump-note-syntax.ts` for why that is the whole design.
 *
 * The note goes through `normalizeTaskNote` rather than being left to
 * `BrainDumpItem_notes_check`: the constraint is the backstop for a writer that
 * forgot, and reaching it from the writer that did not would surface to the
 * person as a capture that silently failed.
 *
 * The empty guard reads the PARSED text, not the raw string. `{just a note}` is
 * refused by the parser and stored literally, so this cannot create a row whose
 * only content is hidden behind a note.
 */
export async function createBrainDumpItem(text: string) {
  const workspaceId = await currentWorkspaceId();
  const { text: itemText, note } = splitInlineNote(text);
  if (!itemText) return;
  await prisma.brainDumpItem.create({
    data: { text: itemText, notes: normalizeTaskNote(note), workspaceId },
  });
  // A capture is a qualifying engagement (Decision 1) — advances the streak at
  // most once per working day.
  await touchStreakOnEngagement(workspaceId);
  revalidatePath(INBOX_PATH);
}

export async function triageBrainDumpItem(id: string) {
  const workspaceId = await currentWorkspaceId();
  const existing = await prisma.brainDumpItem.findFirst({
    where: { id, workspaceId },
  });
  if (!existing) return;
  await prisma.brainDumpItem.update({
    where: { id },
    data: {
      status: BrainDumpStatus.Triaged,
      triagedAt: new Date(),
      breakdownRequestedAt: null,
    },
  });
  await maybeAwardInboxZero(workspaceId);
  revalidatePath(INBOX_PATH);
}

/**
 * Move an item into Multi-step before it has any steps (Phase B drop/menu
 * target): triages it and stamps breakdownRequestedAt so it sits in the
 * Multi-step bucket showing a "Break into steps now?" call-to-action instead
 * of silently landing in Single-task. Any move to another bucket clears the
 * stamp (you changed your mind).
 */
export async function requestBreakdown(id: string) {
  const workspaceId = await currentWorkspaceId();
  const existing = await prisma.brainDumpItem.findFirst({
    where: { id, workspaceId },
  });
  if (!existing) return;
  await prisma.brainDumpItem.update({
    where: { id },
    data: {
      status: BrainDumpStatus.Triaged,
      triagedAt: new Date(),
      breakdownRequestedAt: new Date(),
      snoozedUntil: null,
    },
  });
  await maybeAwardInboxZero(workspaceId);
  revalidatePath(INBOX_PATH);
}

/**
 * "Save for later" — a saved-for-later item is a paused inbox item regardless
 * of where it came from, so snoozing also un-triages it (status → inbox,
 * triagedAt → null). Otherwise a triaged single-task/multi-step to-do stays
 * in its original bucket (bucket.ts's savedLater rule requires status ===
 * "inbox"), making the move a silent no-op. Waking via triageBrainDumpItem
 * re-triages symmetrically.
 */
export async function snoozeBrainDumpItem(id: string, minutes: number) {
  const workspaceId = await currentWorkspaceId();
  const existing = await prisma.brainDumpItem.findFirst({
    where: { id, workspaceId },
  });
  if (!existing) return;
  await prisma.brainDumpItem.update({
    where: { id },
    data: {
      status: BrainDumpStatus.Inbox,
      triagedAt: null,
      snoozedUntil: new Date(Date.now() + minutes * 60_000),
      remindedAt: null,
      breakdownRequestedAt: null,
    },
  });
  await maybeAwardInboxZero(workspaceId);
  revalidatePath(INBOX_PATH);
}

/**
 * Rename an item from its row (✎). Keeps a linked task's title in sync so
 * the breakdown editor / focus timer never show a stale name (steps keep
 * their own texts). Empty input is a no-op.
 *
 * ## This is also the note edit path, and therefore the erosion path (#179)
 *
 * The ✎ field is pre-filled with `inlineNoteSource(stored)` — the item's text
 * with its note put back between braces, which is the string a capture would
 * have received. So the field holds ONE honest representation of the source and
 * a rename re-parses it, which means the same string can arrive as "the user
 * typed this fresh" or as "this is what we saved last time" with nothing in it
 * to tell the two apart.
 *
 * `resolveInlineNoteEdit` is what makes that safe rather than lossy: an
 * unchanged submission is not an edit, and the note is only ever written by note
 * syntax. Without it, saving without typing re-split the pre-filled text —
 * eroding it one brace group per save and overwriting the note it already had.
 * Read that function's doc comment before changing anything here.
 *
 * ## Which of the two note columns is written
 *
 * `liveNote` decides, and it is `taskId` that decides for it. Before triage the
 * note lives on the item; after triage `brainDumpItemToTaskData` has copied it
 * onto the `Task`, and that is the column every note surface reads. Writing the
 * item's copy for a task-backed row would store an edit nothing displays, and
 * pre-filling from it would silently revert a note edited through `NoteField`.
 */
export async function renameItem(id: string, text: string) {
  const workspaceId = await currentWorkspaceId();
  const trimmed = text.trim();
  if (!trimmed) return;
  const existing = await prisma.brainDumpItem.findFirst({
    where: { id, workspaceId },
    // The task's note comes through the SAME workspace-scoped read as the item,
    // so the value a rename compares against cannot arrive un-authorised.
    include: { task: { select: { notes: true } } },
  });
  if (!existing) return;

  const next = resolveInlineNoteEdit(trimmed, {
    text: existing.text,
    note: liveNote({
      taskId: existing.taskId,
      itemNotes: existing.notes,
      taskNotes: existing.task?.notes ?? null,
    }),
  });
  const note = normalizeTaskNote(next.note);

  await prisma.brainDumpItem.update({
    where: { id },
    data: {
      text: next.text,
      // Only the live grain. A task-backed row's item copy is a leftover from
      // triage, and rewriting it here would put a second, divergent answer in
      // the database for something with one visible value.
      ...(existing.taskId ? {} : { notes: note }),
    },
  });
  if (existing.taskId) {
    await prisma.task.update({
      where: { id: existing.taskId },
      data: { title: next.text, notes: note },
    });
    revalidatePath(`/tasks/${existing.taskId}`);
  }
  revalidatePath(INBOX_PATH);
  // A rename can now change a NOTE, and the Library renders one — the same set
  // `updateTaskNotes` invalidates, for the same reason (#139's class of bug).
  revalidatePath(LIBRARY_PATH);
}

/**
 * Deleting an item must not orphan its linked Task (#64): Focus reads Task
 * directly with no existence check against BrainDumpItem, so a Task left
 * behind here would linger forever in the Focus launcher while being
 * structurally invisible to the Library (whose only source query is
 * BrainDumpItem) — a permanent phantom that can never be completed from the
 * Library's point of view either. Once this item is gone, delete the Task
 * too if nothing else still references it; Step/BreakdownTurn cascade for
 * free (schema.prisma onDelete: Cascade on their taskId FK). Both deletes run
 * in one transaction so a mid-way failure can't leave a half-orphaned state.
 *
 * `existing` is read outside the transaction as a workspace-ownership guard,
 * so a concurrent delete of the same item between that read and the
 * transaction is possible. The item delete below uses `deleteMany` (not
 * `delete`) specifically so that race is a silent 0-row no-op instead of a
 * Prisma P2025 "record not found" throw that would roll back the transaction;
 * when that happens we skip the Task cleanup too, since there is nothing left
 * that this call actually removed.
 */
export async function deleteBrainDumpItem(id: string) {
  const workspaceId = await currentWorkspaceId();
  const existing = await prisma.brainDumpItem.findFirst({
    where: { id, workspaceId },
  });
  if (!existing) return;

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.brainDumpItem.deleteMany({
      where: { id, workspaceId },
    });
    if (count === 0) return; // already deleted concurrently — nothing to clean up
    if (existing.taskId) {
      // Defensive: the schema allows multiple BrainDumpItems to reference the
      // same Task, though no code path today creates more than one. Only
      // delete the Task once this was the last item pointing at it.
      const stillLinked = await tx.brainDumpItem.count({
        where: { taskId: existing.taskId },
      });
      if (stillLinked === 0) {
        await tx.task.deleteMany({
          where: { id: existing.taskId, workspaceId },
        });
      }
    }
  });

  await maybeAwardInboxZero(workspaceId);
  revalidatePath(INBOX_PATH);
}

/** Mark an aging item as reminded so we don't re-notify (step 4). */
export async function markReminded(id: string) {
  const workspaceId = await currentWorkspaceId();
  const existing = await prisma.brainDumpItem.findFirst({
    where: { id, workspaceId },
  });
  if (!existing) return;
  await prisma.brainDumpItem.update({
    where: { id },
    data: { remindedAt: new Date() },
  });
  revalidatePath(INBOX_PATH);
}

/** Freshen an aging item — resets the freshness clock without triaging it. */
export async function freshenItem(id: string) {
  const workspaceId = await currentWorkspaceId();
  await prisma.brainDumpItem.updateMany({
    where: { id, workspaceId },
    data: { freshenedAt: new Date() },
  });
  revalidatePath(INBOX_PATH);
}

/** Dismiss the freshness prompt for an item without freshening or triaging it. */
export async function dismissPrompt(id: string) {
  const workspaceId = await currentWorkspaceId();
  await prisma.brainDumpItem.updateMany({
    where: { id, workspaceId },
    data: { promptDismissedAt: new Date() },
  });
  revalidatePath(INBOX_PATH);
}

/**
 * "Keep as task" — promote an inbox item into a Task without breaking it down.
 * (Step 5 will add the conversational-breakdown launch.)
 */
export async function keepAsTask(id: string) {
  const workspaceId = await currentWorkspaceId();
  const item = await prisma.brainDumpItem.findFirst({
    where: { id, workspaceId },
  });
  if (!item) return;
  // #179 — the ONE conversion, so the item's note and its three schedule-intent
  // columns cross with it. Triage is a routine action and must not silently drop
  // content somebody typed; `braindump-to-task-hygiene` fails the build if a
  // writer stops going through here.
  const task = await prisma.task.create({
    data: brainDumpItemToTaskData(item, workspaceId),
  });
  await prisma.brainDumpItem.update({
    where: { id },
    data: {
      status: BrainDumpStatus.Triaged,
      triagedAt: new Date(),
      taskId: task.id,
      breakdownRequestedAt: null,
    },
  });
  await maybeAwardInboxZero(workspaceId);
  revalidatePath(INBOX_PATH);
  return task.id;
}

/**
 * ▶ Focus on a single to-do: the focus timer is step-based, so ensure the
 * item has a task with one step mirroring its text (created on first use,
 * idempotent) and return the id of the first not-done step to focus on.
 * A one-step task still counts as a single to-do (bucket.ts: multi-step
 * needs 2+ steps), so the item stays in its bucket.
 */
export async function ensureFocusStep(id: string): Promise<string | null> {
  const workspaceId = await currentWorkspaceId();
  const item = await prisma.brainDumpItem.findFirst({
    where: { id, workspaceId },
    include: { task: { include: { steps: { orderBy: { order: "asc" } } } } },
  });
  if (!item) return null;

  let taskId = item.taskId;
  let steps = item.task?.steps ?? [];

  if (!taskId) {
    // #179 — same conversion as `keepAsTask`. Pressing ▶ Focus is a triage in
    // everything but name, so it has to carry the note across too.
    const task = await prisma.task.create({
      data: brainDumpItemToTaskData(item, workspaceId),
    });
    taskId = task.id;
    await prisma.brainDumpItem.update({ where: { id }, data: { taskId } });
    steps = [];
  }

  if (steps.length === 0) {
    const step = await prisma.step.create({
      data: { taskId, text: item.text, order: 1, total: 1, estMinutes: 10 },
    });
    revalidatePath(INBOX_PATH);
    return step.id;
  }

  const next = steps.find((s) => !s.done) ?? steps[0];
  return next.id;
}

export async function completeItem(id: string) {
  const workspaceId = await currentWorkspaceId();
  const item = await prisma.brainDumpItem.findFirst({
    where: { id, workspaceId },
    include: { task: { include: { steps: true } } },
  });
  if (!item || item.completedAt) return;

  // The steps this call is about to close. Read before the write, and reused
  // after it as the set whose Google Tasks to patch (#209) — a step that was
  // already done was patched when it was done, and re-patching costs a request
  // per step for no change.
  const closing = item.task?.steps.filter((s) => !s.done) ?? [];

  if (item.task) {
    await prisma.step.updateMany({
      where: { taskId: item.task.id },
      data: { done: true },
    });
    await prisma.task.update({
      where: { id: item.task.id },
      data: { status: TaskStatus.Done },
    });
    for (const _step of closing)
      await logReward(workspaceId, RewardType.StepDone);
    await maybeAwardTenStepsDay(workspaceId);
  }

  await prisma.brainDumpItem.update({
    where: { id },
    data: { completedAt: new Date(), breakdownRequestedAt: null },
  });
  await logReward(workspaceId, RewardType.TaskComplete);
  await touchStreakOnCompletion(workspaceId);
  await awardBadge(workspaceId, BadgeKey.TaskComplete);
  await maybeAwardInboxZero(workspaceId);

  // #195 + #209 — close every Google Task this to-do owns, at both grains.
  //
  // The task row carries an id when the to-do was scheduled while it was still
  // stepless, and each step carries its own when it was scheduled after a
  // breakdown; a to-do can have both, and they are always different Google
  // tasks. #195 fixed the task grain here and #209 the step grain: `updateMany`
  // above closes every step in one write, so the per-step patch `completeStep`
  // performs never happened and Reclaim went on holding every block.
  //
  // Runs after the local writes and outside any transaction, and swallows its
  // own failures per patch, so neither an unreachable Google nor one slow step
  // can cost the user the completion they asked for.
  if (item.task) await completeGoogleTasksForItem(item.task, closing);

  revalidatePath(INBOX_PATH);
  revalidatePath("/dashboard");
  if (item.task) revalidatePath(`/tasks/${item.task.id}`);
}

/**
 * Un-complete a to-do from the inbox Done view, whole or step by step.
 *
 * Three things have to be undone, not one, and #196 is the record of the two
 * that were missing.
 *
 * 1. **The local state** — `completedAt`, the task's status, and the selected
 *    steps. This is what the action always did.
 * 2. **Google Tasks** — every task this reopen just un-completed goes back to
 *    `needsAction`, so Reclaim re-books the time. Without it the two sides
 *    diverged permanently: nothing else in the app ever sends `needsAction` for
 *    these rows, and nothing reads Google back to notice (that inbound half is
 *    #194's). This runs AFTER the transaction and outside it, so an unreachable
 *    Google can never roll back a reopen the user asked for.
 * 3. **The points** — `completeItem` banks one `step_done` per step it closes
 *    plus a `task_complete`, and taking none of it back meant complete → reopen
 *    → complete paid twice for one piece of work. The reversal runs INSIDE the
 *    transaction, for the reason `uncompleteStep` records at length: if it
 *    fails, the local writes must fail with it, or the to-do is reopened with
 *    the points still banked and nothing will ever take them. It is counted off
 *    what the writes CHANGED rather than off the read above, so a second
 *    concurrent reopen reverses nothing instead of reaching into unrelated work
 *    — the note on the transaction below has the whole argument.
 *
 * Badges stand. They are once-ever achievements, `awardBadge` is idempotent so
 * re-completing cannot earn a second one, and revoking one would make the
 * collection lie about the past — the rule `reverseItemCompletionRewards`
 * already carries, applied here rather than left unstated.
 */
export async function reopenItem(id: string, stepIds?: string[]) {
  const workspaceId = await currentWorkspaceId();
  const item = await prisma.brainDumpItem.findFirst({
    where: { id, workspaceId },
    include: { task: { include: { steps: true } } },
  });
  if (!item) return;

  const steps = item.task?.steps ?? [];
  const resetIds = new Set(
    stepIds && stepIds.length
      ? steps.filter((s) => stepIds.includes(s.id)).map((s) => s.id)
      : steps.map((s) => s.id),
  );
  // Guarantee ≥1 not-done step so the task re-enters To-do.
  const anyNotDone = steps.some((s) => resetIds.has(s.id) || !s.done);
  if (!anyNotDone && steps.length) resetIds.add(steps[steps.length - 1].id);

  // Both undos are counted off what the writes below actually CHANGED, never off
  // the read above (review round 12 — the whole-to-do twin of the holes #198
  // rounds 10 and 11 closed in `uncompleteStep`).
  //
  // The read is a `findFirst` outside the transaction and takes no lock, so it
  // cannot stop two reopens of the same to-do — a double-tap outrunning the
  // button's own `disabled`, or the same Done row open in two tabs. Both would
  // see `completedAt` set and the same steps done, and a second pass is NOT
  // harmlessly idempotent: the local writes are (clearing an already-null
  // `completedAt`, setting an Active task Active), but `reverseLatestReward`
  // takes back *the newest row of that type in the WORKSPACE* — `RewardEvent`
  // holds no link back to the to-do that earned it — so the loser's reversal
  // reaches unrelated, already-settled work. One reopen, the payout taken twice.
  //
  // So the preconditions move INTO the writes, which is the same guarded-bulk
  // shape `uncompleteStep` and `reverseLatestReward` both adopted: Postgres
  // re-evaluates an UPDATE's WHERE after the row lock it was waiting on is
  // released, so the loser matches nothing and reports `count: 0` rather than
  // quietly overwriting. `count: 0` means "another caller has already done all of
  // this" — a no-op, not an error, and nothing may be raised at someone who
  // merely clicked twice.
  const { uncompleted, reopened } = await prisma.$transaction(async (tx) => {
    // First write in the transaction on purpose: two concurrent reopens of one
    // to-do contend on THIS row, so the loser blocks here and re-reads
    // `completedAt` as null the moment the winner commits. `updateMany` rather
    // than `update` for the same reason `reverseLatestReward` uses `deleteMany` —
    // a precondition that matches nothing must report a count, not raise.
    const { count: uncompleted } = await tx.brainDumpItem.updateMany({
      where: { id, workspaceId, completedAt: { not: null } },
      data: { completedAt: null },
    });

    // The steps this call actually turns done → not-done, and the only source of
    // truth for that: the reward reversal owes one `step_done` each, and Google
    // owes one `needsAction` each. A step in `resetIds` that was already open
    // earned nothing and is already `needsAction` on Google's side, so the
    // `done: true` precondition drops it from both — and drops everything when a
    // concurrent reopen got there first.
    //
    // `updateManyAndReturn` rather than `updateMany`, because at this arity the
    // count is not enough: `uncompleteStep` undoes one named step and can gate on
    // `count > 0`, whereas a to-do reopens N and Google has to be told WHICH.
    // Deriving that from the pre-transaction snapshot instead would put the two
    // undos back on two different sources of truth, which is the shape of this
    // whole defect.
    //
    // Scoped by `task.workspaceId` as well as by id, the same way
    // `uncompleteStep`'s step write is: a bulk operation carries the scope in its
    // own arguments rather than inheriting it from a read further up. `Step`
    // declares no `workspaceId` of its own, so `scoping.harness.test.ts` does not
    // enrol it and this is belt and braces — but the row ids came from a
    // workspace-scoped read and are re-proved against it here, which costs one
    // join and removes a whole class of "the read was right, the write drifted".
    //
    // `updateManyAndReturn` was absent from that harness's op list until this
    // call went in; it is the codebase's first, and the list has been corrected
    // rather than left to the next caller to discover.
    let reopened: {
      googleTaskId: string | null;
      googleTaskListId: string | null;
    }[] = [];
    if (item.task) {
      // Deliberately NOT gated. Setting an Active task Active is idempotent, and
      // the loser of the race wants the task open just as much as the winner did
      // — while a task some other path had already reactivated could still be
      // carrying a completed inbox item. The defect being fixed is a miscounted
      // reward, not this write.
      await tx.task.update({
        where: { id: item.task.id },
        data: { status: TaskStatus.Active },
      });
      if (resetIds.size) {
        reopened = await tx.step.updateManyAndReturn({
          where: {
            id: { in: [...resetIds] },
            done: true,
            task: { workspaceId },
          },
          data: { done: false },
          select: { googleTaskId: true, googleTaskListId: true },
        });
      }
    }

    // On `tx`, not `prisma`: a reversal that committed independently would
    // survive the rollback, which is the bug wearing the fix's clothes.
    //
    // `uncompleted > 0` — did THIS call un-complete the item — replaces the
    // `item.completedAt !== null` snapshot as the gate on `task_complete`, for
    // the reason round 11 gives one level down: the snapshot means "it looked
    // completed when I read it", which both callers see and only one of them
    // earns. An item that was not completed never banked a `task_complete`, so
    // reversing one would take points from a different, genuinely finished to-do.
    await reverseItemCompletionRewards(
      workspaceId,
      { stepDone: reopened.length, includeTaskComplete: uncompleted > 0 },
      tx,
    );
    return { uncompleted, reopened };
  });

  // After the transaction and outside it — see (2) above. Best-effort per patch,
  // so one unreachable step does not abandon the others or the reopen.
  //
  // Told only what this call changed, at both grains. The task's own Google task
  // pairs with the item's `completedAt` (`completeItem` sets the two together),
  // so a caller that un-completed nothing passes `null` and a caller that
  // reopened no steps passes nothing — `patchPool` drops an empty queue before it
  // costs a credential lookup. That is the same saving `uncompleteStep` makes
  // with `if (applied)`: the winner has already sent the PATCH, and a second one
  // is a redundant round trip to an API this app is rate-limited against.
  // `revalidatePath` below is NOT skipped — each request still has to refresh its
  // own render, whoever did the write.
  await reopenGoogleTasksForItem(uncompleted > 0 ? item.task : null, reopened);

  revalidatePath(INBOX_PATH);
  revalidatePath("/dashboard");
  if (item.task) revalidatePath(`/tasks/${item.task.id}`);
}

/**
 * Un-triage an item back to the "needs review" queue (Phase B drag/menu target).
 * Keeps the linked task + its steps intact so re-triaging reuses the same
 * breakdown (startBreakdown returns the existing taskId). Only the item's
 * placement changes: status → inbox, and triaged/snoozed/completed cleared.
 */
export async function moveToReview(id: string) {
  const workspaceId = await currentWorkspaceId();
  const existing = await prisma.brainDumpItem.findFirst({
    where: { id, workspaceId },
  });
  if (!existing) return;
  await prisma.brainDumpItem.updateMany({
    where: { id, workspaceId },
    data: {
      status: BrainDumpStatus.Inbox,
      triagedAt: null,
      snoozedUntil: null,
      completedAt: null,
      breakdownRequestedAt: null,
    },
  });
  revalidatePath(INBOX_PATH);
}

/**
 * Set a single-task item's time estimate (minutes). Workspace-scoped +
 * IDOR-safe via updateMany's workspace filter. Clamped to a sane [1, 600].
 */
export async function setItemEstimate(id: string, minutes: number) {
  if (!Number.isFinite(minutes)) return;
  const workspaceId = await currentWorkspaceId();
  const clamped = Math.max(1, Math.min(600, Math.round(minutes)));
  await prisma.brainDumpItem.updateMany({
    where: { id, workspaceId },
    data: { estMinutes: clamped },
  });
  revalidatePath(INBOX_PATH);
  revalidatePath("/library");
}

/**
 * Bulk edit for the Library to-do tabs. Reuses the per-item actions (which are
 * each workspace-scoped + carry the reward/badge/streak/graduation logic) so we
 * never re-implement that. Pre-filters ids to the caller's workspace for an
 * accurate count + explicit IDOR guard.
 */
export async function bulkBrainDumpAction(
  ids: string[],
  action: "complete" | "saveForLater" | "delete",
): Promise<{ count: number }> {
  if (!ids.length) return { count: 0 };
  const workspaceId = await currentWorkspaceId();
  const owned = await prisma.brainDumpItem.findMany({
    where: { id: { in: ids }, workspaceId },
    select: { id: true },
  });
  for (const { id } of owned) {
    if (action === "delete") await deleteBrainDumpItem(id);
    else if (action === "saveForLater") await snoozeBrainDumpItem(id, 60);
    else await completeItem(id);
  }
  return { count: owned.length };
}
