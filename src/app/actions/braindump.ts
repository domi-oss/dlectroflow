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
  TASK_WRITER_TX_BUDGET,
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
 *
 * ## At most one Task per item, however many times this is called (#225)
 *
 * This used to be `findFirst`-then-`task.create` with no precondition on the
 * create at all. A second call therefore built a second `Task` and repointed the
 * item at it, leaving the first reachable from no inbox row while the focus
 * lanes, the ICS feed and the data export all still counted it — and taking its
 * steps out of reach with it.
 *
 * **A correction to what stood here** (!306, substitute review). This paragraph
 * used to call it "the only one of the four brain-dump→task writers without one
 * (`startBreakdown` and `ensureFocusStep` both return the item's existing
 * `taskId` before creating)", and that was wrong twice over. Those two *check*
 * `taskId` — with a `findFirst` outside any transaction, which is the unlocked
 * check-then-act the paragraph below describes as the defect, not a precondition
 * against it; measured on real Postgres, each of them produced two Tasks and an
 * orphan under contention, as did one of them racing this one. And the fourth
 * writer is `scheduleSingleTask` (`src/lib/braindump-to-task.ts` names all four),
 * which was left out of the count entirely. `startBreakdown` and
 * `ensureFocusStep` are guarded now, each in the shape its own columns allow;
 * `scheduleSingleTask` still has the unlocked check and is recorded as
 * outstanding rather than quietly counted as safe.
 *
 * Three ways to reach that, none of them exotic:
 *
 * 1. **Retry after a timeout** (!306, Duo review round 13). `inbox-view.tsx`
 *    bounds how long the UI waits at `INBOX_ACTION_TIMEOUT_MS`, not how long the
 *    request runs — a server action cannot be aborted from the client. The
 *    notice says so honestly ("this may already have gone through") and offers a
 *    Retry, and the client's `inFlight` guard has already been released by then,
 *    so taking that Retry sends a second `keepAsTask` at a row whose first one
 *    may have landed. The client guard is per-press and cannot see this; nothing
 *    but the write itself can.
 * 2. **▶ Focus first.** `ensureFocusStep` gives an item a Task without triaging
 *    it, so "Add to-do" afterwards met a row that already had one.
 * 3. **Re-triage.** `moveToReview` un-triages an item and deliberately keeps its
 *    Task, "so re-triaging reuses the same breakdown" — which is precisely what
 *    a second create stopped it from doing.
 *
 * So the precondition moves INTO the write. Related to the guarded shape
 * `reopenItem`, `uncompleteStep` and `reverseLatestReward` use, but deliberately
 * NOT the same one, and the difference matters enough to say (!306, substitute
 * review): those three put the precondition in the `where` and gate on `count`.
 * This one carries no precondition in its `where` and branches in JS on the row
 * it gets back, **because it must still stamp the triage columns on the adopt
 * path** — a `taskId: null` term in the `where` would refuse the very press that
 * is asking for a triage the item has not had. `ensureFocusStep` can use the
 * `where`-precondition form precisely because it has no stamp to land.
 *
 * The triage stamp is the first write in the transaction and takes the row lock,
 * and `updateManyAndReturn` hands back the row AS UPDATED. A second caller
 * blocks on that lock, and
 * Postgres re-evaluates a blocked `UPDATE` against the committed version, so the
 * `taskId` it reads back is the winner's. Zero rows means the row is gone or
 * belongs to somebody else — a no-op, not an error to raise at someone who
 * pressed a button twice.
 *
 * The link write has to be inside the same transaction rather than after it:
 * autocommit would release the lock the moment the stamp landed, and the second
 * caller would read `taskId` as NULL because the first has not created its Task
 * yet. That window is the whole defect.
 *
 * Guarded on `taskId`, NOT on `status`. `triageBrainDumpItem` and
 * `requestBreakdown` both set `Triaged` without creating a Task, so a
 * status-shaped guard would refuse the one press that still owes those items a
 * Task. What must not happen twice is the CREATE; re-stamping the triage columns
 * is what the caller asked for either way.
 *
 * Re-stamping is *nearly* idempotent rather than idempotent, and the exception is
 * worth naming (!306, substitute review): `status` and `breakdownRequestedAt` are
 * written by value, but `triagedAt: new Date()` moves forward on every call. No
 * bucket rule reads it — `bucket.ts` declares it and never branches on it — and
 * its one reader is the CSV export (`src/lib/export/csv-files.ts`), so a retry
 * shifts an exported triage timestamp and nothing else. Accepted rather than
 * fixed: pinning the original would mean reading it back before writing it, which
 * is the extra round trip the guard exists to avoid.
 *
 * The item is read through the guarded write instead of ahead of it, so the
 * columns `brainDumpItemToTaskData` copies come from the same locked row version
 * the decision was made on rather than from a snapshot a concurrent rename could
 * already have superseded.
 */
export async function keepAsTask(id: string) {
  const workspaceId = await currentWorkspaceId();

  const taskId = await prisma.$transaction(async (tx) => {
    const [item] = await tx.brainDumpItem.updateManyAndReturn({
      where: { id, workspaceId },
      data: {
        status: BrainDumpStatus.Triaged,
        triagedAt: new Date(),
        breakdownRequestedAt: null,
      },
      // Exactly `BrainDumpItemForTask` plus the guard column. A `select` rather
      // than the whole row because the conversion helper is typed structurally
      // for this, and naming the five columns is what makes a sixth one being
      // added to the conversion a compile error here rather than a silent drop.
      select: {
        taskId: true,
        text: true,
        notes: true,
        scheduleDueAt: true,
        schedulePriority: true,
        scheduleHours: true,
      },
    });
    // The row is gone, or is not this workspace's. Same no-op the `findFirst`
    // guard used to give, now decided by the write's own `where` — so the scope
    // travels with the operation instead of being inherited from a read above it.
    if (!item) return null;
    // Somebody already gave this item a Task: the winner of a race, an earlier
    // call this one is a retry of, or ▶ Focus. Adopt it. Returning it rather
    // than `null` keeps the action honestly idempotent — two calls answer with
    // the same task id, which is what every caller of the first one assumed.
    if (item.taskId) return item.taskId;
    // #179 — the ONE conversion, so the item's note and its three schedule-intent
    // columns cross with it. Triage is a routine action and must not silently drop
    // content somebody typed; `braindump-to-task-hygiene` fails the build if a
    // writer stops going through here.
    const task = await tx.task.create({
      data: brainDumpItemToTaskData(item, workspaceId),
    });
    await tx.brainDumpItem.update({
      where: { id },
      data: { taskId: task.id },
    });
    return task.id;
  }, TASK_WRITER_TX_BUDGET);

  if (taskId === null) return;
  await maybeAwardInboxZero(workspaceId);
  revalidatePath(INBOX_PATH);
  return taskId;
}

/**
 * ▶ Focus on a single to-do: the focus timer is step-based, so ensure the
 * item has a task with one step mirroring its text (created on first use,
 * idempotent) and return the id of the first not-done step to focus on.
 * A one-step task still counts as a single to-do (bucket.ts: multi-step
 * needs 2+ steps), so the item stays in its bucket.
 */
/**
 * ▶ Focus on a single to-do: make sure the item has a Task with at least one
 * Step, and answer with the step to open the timer on.
 *
 * ## At most one Task, however many times this is called (#225)
 *
 * This used to be `findFirst` → `if (!taskId)` → `task.create` → link, with no
 * transaction and no precondition on either write. `keepAsTask`'s docblock above
 * excused it as already safe — "`startBreakdown` and `ensureFocusStep` both
 * return the item's existing `taskId` before creating" — and that is the one
 * sentence in this file that was wrong. They *check* it. An unlocked
 * check-then-act is precisely the shape the paragraph above describes as the
 * defect: the read is served from a snapshot taken before the winner committed,
 * so both callers see NULL, both create, and the second link repoints the item
 * at its own Task — leaving the first reachable from no inbox row while
 * `focus/page.tsx`, `calendar-feed.ts` and `export/collect.ts` all still count
 * it, and taking any steps it had out of reach with it.
 *
 * Measured on real Postgres before the fix (!306, substitute review): two
 * overlapping presses produced two Tasks and one orphan, and so did one press
 * of ▶ Focus overlapping one of "Add to-do".
 *
 * !306 makes that materially worse rather than merely latent, because it puts
 * this write behind the failure notice's **Retry**: `withActionTimeout` bounds
 * how long the UI waits, not how long the request runs, so the Retry can fire a
 * second press at a row whose first one is still going.
 *
 * ## Why the guard is shaped differently from `keepAsTask`'s
 *
 * `keepAsTask` takes the row lock with its triage stamp, because it has one to
 * write. **▶ Focus must not triage** — it deliberately leaves the item in the
 * review queue, which is the very reason that guard is on `taskId` rather than
 * on `status` — so there is no column here to stamp and no lock to take up
 * front. The precondition therefore goes on the LINK, which is the write that
 * must not happen twice: `taskId: null` in the `where`, gated on `count`, the
 * shape `reopenItem` and `uncompleteStep` use. A loser's `UPDATE` blocks on the
 * winner's row lock, Postgres re-qualifies it against the committed row, the
 * `taskId IS NULL` term no longer holds and it matches zero rows — which is how
 * it learns it lost, deterministically rather than by comparing reads.
 *
 * The Task it had already built is then discarded inside the same transaction,
 * so nothing outside it ever sees the speculative row, and the winner's Task is
 * adopted instead.
 *
 * ## The STEP create, closed at the table grain (#245)
 *
 * This heading used to read "what is NOT guarded". Two concurrent calls against an
 * item that ALREADY has a Task with no steps take **no lock at all** — neither
 * enters the block above, because `taskId` is already set — so both read
 * `steps: []` from their own snapshot and both create one, leaving two steps at
 * `order: 1, total: 1`. `!306` made that easier to reach rather than merely latent,
 * by putting the write behind the notice's Retry.
 *
 * No precondition in application code can close it, which is why it was filed
 * separately (#245) instead of bolted on as a fourth guard. An `UPDATE`'s `where`
 * can carry a precondition; an `INSERT`'s cannot, and there is no row to lock
 * because the whole question is whether a row should exist. Both transactions
 * genuinely find nothing.
 *
 * The paragraph that stood here named the two real options — "a unique index on
 * `(taskId, order)` or an explicit lock on the Task row" — and #245 took the
 * index (`20260811120000_step_task_order_unique`, which carries the full argument
 * and the repair pass). It also named the exact reason the cheap instrument was
 * unavailable: "`Step` has no unique constraint, so `createMany({ skipDuplicates:
 * true })` — the `ON CONFLICT DO NOTHING` shape `src/lib/db.ts` recommends — has
 * nothing to conflict on". **It has something to conflict on now**, so this is
 * that shape and not a `P2002` catch.
 *
 * The distinction matters and is the whole reason the index was preferred to the
 * lock: `src/lib/db.ts` keeps `log: ["error"]` deliberately truthful, so a caught
 * `P2002` still prints before any `catch` runs — the defect #156 and #158 exist
 * for, once escalated as an incident. `ON CONFLICT DO NOTHING` raises nothing,
 * which is what makes a duplicate press a real no-op rather than a handled error.
 *
 * `createManyAndReturn` rather than `createMany`, because the count is not enough
 * here: this action owes its caller a step id to open the timer on. The winner
 * gets its row back; the loser gets `[]`, which is how it learns to go and read
 * what actually landed. An empty array is a **result**, not an error — the same
 * reading `linked.count === 0` gets above.
 */
export async function ensureFocusStep(id: string): Promise<string | null> {
  const workspaceId = await currentWorkspaceId();

  /** Whether anything was actually written, so the revalidation below matches
   *  the pre-#225 behaviour of firing only when a Step was created. */
  let wrote = false;
  const stepId = await prisma.$transaction(async (tx) => {
    const item = await tx.brainDumpItem.findFirst({
      where: { id, workspaceId },
      include: { task: { include: { steps: { orderBy: { order: "asc" } } } } },
    });
    if (!item) return null;

    let taskId = item.taskId;
    let steps = item.task?.steps ?? [];

    if (!taskId) {
      // #179 — same conversion as `keepAsTask`. Pressing ▶ Focus is a triage
      // in everything but name, so it has to carry the note across too.
      const task = await tx.task.create({
        data: brainDumpItemToTaskData(item, workspaceId),
      });
      const linked = await tx.brainDumpItem.updateMany({
        // `taskId: null` is the guard, and `workspaceId` keeps the scope on
        // the write itself rather than inherited from the read above it.
        where: { id, workspaceId, taskId: null },
        data: { taskId: task.id },
      });
      if (linked.count === 0) {
        // Lost the race. Drop the Task nobody has seen and adopt the winner's
        // — a duplicate press is a no-op, not an error to raise at somebody
        // who pressed a button twice. The re-read is a new statement, so it
        // sees the commit whose lock this transaction just waited on.
        await tx.task.delete({ where: { id: task.id } });
        const winner = await tx.brainDumpItem.findFirst({
          where: { id, workspaceId },
          include: {
            task: { include: { steps: { orderBy: { order: "asc" } } } },
          },
        });
        if (!winner?.taskId) return null;
        taskId = winner.taskId;
        steps = winner.task?.steps ?? [];
      } else {
        taskId = task.id;
        steps = [];
      }
    }

    if (steps.length === 0) {
      // #245 — `INSERT … ON CONFLICT DO NOTHING`, against
      // `Step_taskId_order_key`. `steps: []` came from a read that took no lock,
      // so it is a hint that this branch is worth entering rather than a fact
      // this write may rely on; the index is what decides between two callers
      // who both saw nothing.
      const [created] = await tx.step.createManyAndReturn({
        data: [{ taskId, text: item.text, order: 1, total: 1, estMinutes: 10 }],
        skipDuplicates: true,
      });
      if (created) {
        wrote = true;
        return created.id;
      }
      // Lost the race. Nothing was inserted and nothing was raised, so go and
      // read the step the winner committed — a new statement, which sees it.
      // `wrote` stays false: the revalidation below fires only when this call
      // actually wrote, which is what it did before #225 moved the body into a
      // transaction, and the winner did its own.
      // `done` first, then `order`, which is exactly what
      // `steps.find((s) => !s.done) ?? steps[0]` below computes — the first open
      // step, or the lowest-ordered one when they are all closed. Written as the
      // same rule rather than "the lowest order" because the two branches answer
      // the same question and a reader should not have to check whether they
      // agree.
      const landed = await tx.step.findFirst({
        where: { taskId, task: { workspaceId } },
        orderBy: [{ done: "asc" }, { order: "asc" }],
      });
      // Null only if the winner's step has since been deleted — an eject or a
      // re-plan between its commit and this read. There is nothing to focus, and
      // that is the same answer this action already gives for an item it cannot
      // resolve, rather than an error raised at somebody who pressed ▶ twice.
      return landed?.id ?? null;
    }

    const next = steps.find((s) => !s.done) ?? steps[0];
    return next.id;
  }, TASK_WRITER_TX_BUDGET);

  // Outside the transaction, and only when a Step was actually created — which
  // is exactly when it fired before #225 moved the body into a transaction. A
  // revalidation is a consequence of the write; one that threw inside would roll
  // back a Task that had been created correctly.
  if (wrote) revalidatePath(INBOX_PATH);
  return stepId;
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
