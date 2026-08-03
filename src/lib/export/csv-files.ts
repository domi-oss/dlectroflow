import { toCsv } from "@/lib/csv";
import { isoStamp, isoStampOrEmpty, type ExportSnapshot } from "./types";

/**
 * #129 — the spreadsheet tier: three related CSV files, keyed by `id` / `task_id`.
 *
 * ## Why three files and not one sheet
 *
 * CSV cannot represent `Task` → `Step[]`. Flattening either duplicates every task
 * field on every step row (so editing a title in a spreadsheet corrupts the
 * relation) or drops the steps entirely — and **the steps are what this app
 * actually produces**, so losing them would gut the export while appearing to
 * succeed. Two files joined on `task_id` is the shape a spreadsheet, a database
 * import and `pandas.merge` all already understand.
 *
 * ## What is deliberately not here
 *
 *  - **`estimateHistory`**, because it is a JSON array inside a column. A JSON
 *    blob in a CSV cell is neither readable by the human this tier serves nor
 *    parseable by the tool it serves; `export.json` expands it properly instead.
 *  - **`googleTaskId` / `googleTaskListId`**, which identify rows inside a Google
 *    account and mean nothing outside it. They stay in `export.json` so a
 *    re-import can reconcile.
 *  - **The coaching conversation** (`BreakdownTurn`). It is prose, and prose in a
 *    CSV cell is a cell nobody can read. It is in `tasks.md` and `export.json`.
 *  - **Streaks, badges, rewards, rollups and sparks.** Derived from activity, and
 *    they port nowhere.
 *
 * Every timestamp goes through `isoStampOrEmpty`, so an absent one is an EMPTY
 * field: a spreadsheet can filter on empty and cannot on the word "null".
 */

export const TASKS_CSV_HEADER = [
  "id",
  "title",
  "status",
  "source",
  "scheduled_at",
  "schedule_due_at",
  "priority",
  "hours",
  "created_at",
] as const;

export const STEPS_CSV_HEADER = [
  "id",
  "task_id",
  "order",
  "total",
  "text",
  "est_minutes",
  "done",
  "scheduled_at",
] as const;

export const INBOX_CSV_HEADER = [
  "id",
  "text",
  "status",
  "est_minutes",
  "task_id",
  "created_at",
  "triaged_at",
  "completed_at",
] as const;

export function tasksCsv(snapshot: ExportSnapshot): string {
  return toCsv(
    TASKS_CSV_HEADER,
    snapshot.tasks.map((task) => [
      task.id,
      task.title,
      task.status,
      task.source,
      // `scheduled_at` is when the task was FIRST scheduled by any method, not a
      // slot to do it in — see the note in `calendar.ts` about why that
      // distinction decides which rows become calendar events.
      isoStampOrEmpty(task.scheduledAt),
      isoStampOrEmpty(task.scheduleDueAt),
      task.schedulePriority,
      task.scheduleHours,
      isoStamp(task.createdAt),
    ]),
  );
}

export function stepsCsv(snapshot: ExportSnapshot): string {
  return toCsv(
    STEPS_CSV_HEADER,
    snapshot.tasks.flatMap((task) =>
      task.steps.map((step) => [
        step.id,
        task.id,
        step.order,
        step.total,
        step.text,
        step.estMinutes,
        step.done,
        isoStampOrEmpty(step.scheduledAt),
      ]),
    ),
  );
}

export function inboxCsv(snapshot: ExportSnapshot): string {
  return toCsv(
    INBOX_CSV_HEADER,
    snapshot.inbox.map((item) => [
      item.id,
      item.text,
      item.status,
      // Null stays null (an empty field). It is MEANINGFUL — #80: it says nobody
      // ever estimated this item — and the read side's display default of 5
      // minutes is a UI decision that has no business in an export.
      item.estMinutes,
      item.taskId,
      isoStamp(item.createdAt),
      isoStampOrEmpty(item.triagedAt),
      isoStampOrEmpty(item.completedAt),
    ]),
  );
}
