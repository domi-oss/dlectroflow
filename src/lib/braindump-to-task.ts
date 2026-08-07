/**
 * The ONE way a `BrainDumpItem` becomes a `Task` (#179).
 *
 * Pure module (no `fs`, no Prisma, no React) so every writer can call it inside
 * or outside a transaction, and so the shape it produces is unit-testable
 * without a database.
 *
 * ## Why this exists at all
 *
 * `item.text` becomes a task title in FOUR places — `keepAsTask` and
 * `ensureFocusStep` (src/app/actions/braindump.ts), `startBreakdown`
 * (src/app/actions/breakdown.ts), and the lazy create inside
 * `scheduleSingleTask` (src/app/actions/google-schedule.ts). Before #179 they
 * were four independent object literals that happened to agree. The moment the
 * item grew columns worth carrying, "happened to agree" became "three of them
 * carry the note", and the fourth would have been whichever path had no test —
 * which, for a silently-dropped note, is indistinguishable from working.
 *
 * `src/lib/braindump-to-task-hygiene.test.ts` is the other half: it fails the
 * build if a FIFTH `task.create` appears without going through here.
 *
 * ## What carries over, and why that is a decision rather than a copy
 *
 * **The note.** Triage is a routine action, and user content must not vanish
 * because of one. Leaving the note behind on the item would be worse than
 * losing it outright: every note surface reads `Task.notes`, so an orphaned
 * item note is unreachable without being deleted.
 *
 * **The schedule intent, all three columns.** The same argument one field
 * wider. An owner who set a deadline on an untriaged item and then pressed
 * "Keep as task" would otherwise reopen the Schedule menu on
 * `defaultIntentFor`'s fallback, with the choice they made replaced by one
 * nobody made — and `mergePersistedIntent` reads NULL as "nobody has said yet",
 * so it could not tell the difference.
 *
 * **What does NOT carry over:** nothing else, deliberately. `estMinutes` has no
 * `Task` twin (it lives on `Step`, and `ensureFocusStep` already seeds it), and
 * the triage timestamps describe the ITEM's journey rather than the task's.
 *
 * ## Both value classes are re-validated on the way across
 *
 * Not defensiveness for its own sake. Every column here is CHECK-constrained at
 * BOTH grains, so an illegal value is unreachable through the app — but if one
 * ever arrived, copying it forward would move the failure to a DIFFERENT action
 * at a LATER time (a `Task_notes_check` violation thrown from "Keep as task",
 * with nothing the user could act on). Normalising and validating here means
 * the worst case is a dropped field rather than a broken routine action, and
 * the pseudo-enums additionally feed a Reclaim title parameter, which is the
 * same reason `mergePersistedIntent` re-validates columns a CHECK already
 * guards.
 */
import { TaskSource, TaskStatus } from "@/lib/constants";
import { normalizeTaskNote } from "@/lib/task-notes";
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";

/**
 * The columns of a `BrainDumpItem` this conversion reads.
 *
 * A structural type rather than Prisma's `BrainDumpItem`, so the helper stays
 * usable from a caller holding a `select`ed subset — and so its tests do not
 * have to build a full row to exercise one field.
 */
export type BrainDumpItemForTask = {
  text: string;
  notes: string | null;
  scheduleDueAt: Date | null;
  schedulePriority: string | null;
  scheduleHours: string | null;
};

/** Exactly the `data` a `prisma.task.create` needs for a brain-dump item. */
export type BrainDumpTaskData = {
  title: string;
  source: string;
  status: string;
  workspaceId: string;
  notes: string | null;
  scheduleDueAt: Date | null;
  schedulePriority: string | null;
  scheduleHours: string | null;
};

const PRIORITIES = new Set<string>(Object.values(SchedulePriority));
const HOURS = new Set<string>(Object.values(ScheduleHours));

/** Keep a pseudo-enum value only if it is in the vocabulary; otherwise NULL. */
function inVocabulary(
  value: string | null,
  allowed: ReadonlySet<string>,
): string | null {
  return value && allowed.has(value) ? value : null;
}

/**
 * Build the `Task` row an item becomes.
 *
 * Returns data only — it does not write, so the caller keeps ownership of the
 * transaction (`scheduleSingleTask` needs the insert and the item link to
 * commit together) and of what happens to the item afterwards, which differs
 * per call site.
 */
export function brainDumpItemToTaskData(
  item: BrainDumpItemForTask,
  workspaceId: string,
): BrainDumpTaskData {
  return {
    title: item.text,
    source: TaskSource.BrainDump,
    status: TaskStatus.Active,
    workspaceId,
    // Idempotent on an already-normalised value, so this costs nothing on the
    // path every writer actually takes — and folds a stray "" back to NULL on
    // the one it does not, which is what keeps a blank line out of a calendar
    // entry.
    notes: normalizeTaskNote(item.notes),
    scheduleDueAt: item.scheduleDueAt,
    schedulePriority: inVocabulary(item.schedulePriority, PRIORITIES),
    scheduleHours: inVocabulary(item.scheduleHours, HOURS),
  };
}
