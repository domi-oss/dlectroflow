"use client";

import { updateTaskNotes } from "@/app/actions/task-notes";
import { updateStepNotes } from "@/app/actions/step-notes";
import { NoteField } from "@/components/breakdown/note-field";
import type { Voice } from "@/lib/strings";

/**
 * Bind the note disclosure to a task (#44).
 *
 * A three-line client wrapper rather than a prop on `NoteField`, because
 * `NoteField` deliberately imports NEITHER server action: keeping it action-free
 * is what lets one component serve both grains, and what lets its own test
 * exercise the whole disclosure with a plain function instead of mocking a
 * module boundary.
 *
 * No `router.refresh()` after a save, unlike the settings sections. The action
 * calls `revalidatePath`, which App Router applies to the client router cache
 * when the action resolves, and the only surface rendering this note is the
 * component that already holds the value. Refreshing on every debounced save
 * would re-render the server tree under a field the user is still typing in,
 * for nothing.
 */
export function TaskNote({
  taskId,
  taskTitle,
  notes,
  voice,
  autoSaveDelayMs,
}: {
  taskId: string;
  /** Goes into the control's accessible name. */
  taskTitle: string;
  notes: string | null;
  voice: Voice;
  autoSaveDelayMs?: number;
}) {
  return (
    <NoteField
      subject={taskTitle}
      initialNote={notes}
      voice={voice}
      autoSaveDelayMs={autoSaveDelayMs}
      onSave={(next) => updateTaskNotes(taskId, next)}
    />
  );
}

/**
 * The task note as a LIST ROW mounts it (#44).
 *
 * One wrapper for the Inbox and both Library components, rather than the same
 * three-line conditional written out three times — the gap this exists to close
 * was exactly a surface where somebody wrote it twice and missed the third.
 *
 * `taskId` is nullable across every one of those surfaces, and the null is not
 * an edge case: a brain-dump item that has never been triaged has NO `Task`
 * row, so there is no `notes` column to write to. Rendering nothing is correct
 * — the alternative is an affordance whose save can only fail.
 *
 * ## Where the note is offered, and where it deliberately is not (#44)
 *
 * Kept here because a deliberate absence and a forgotten one look identical in
 * a diff, which is how the Library gap shipped.
 *
 * | Surface | Grain | Note | Why |
 * |---|---|---|---|
 * | `/tasks/[id]` header card | task | editable | the task's home |
 * | `/tasks/[id]` step rows | step | editable | `TaskSteps` |
 * | `/tasks/[id]` done step rows | step | read-only | annotating finished work has no purpose; hiding what was written would be worse |
 * | `/` Inbox rows | task | editable | via this component |
 * | `/` Inbox expanded step rows | step | editable | `TaskSteps` |
 * | `/library` Single-task + Saved-for-later | task | editable | via this component |
 * | `/library` Multi-step row | task | editable | via this component |
 * | `/library` Multi-step expanded steps | step | editable | `TaskSteps` |
 * | `/library` Done | task | read-only | a closure view with no other controls; same call as a done step row |
 * | `/focus/[stepId]` session | task + step | read-only | see `FocusNotes` in the timer — the point of the surface is not editing |
 * | `/focus` launcher lanes | task + step | none | a navigation list; every entry is a link INTO the session, which shows the note |
 * | `/tasks/[id]?edit=1` breakdown chat | task + proposed steps | none | the steps are an unsaved model proposal with no ids, so a step note has nowhere to live; the working view one click away owns the task note |
 * | Dashboard | none | none | aggregates and badges, no task or step rows |
 * | Any row with `taskId === null` | — | none | no `Task` row exists, so there is no column to write |
 */
export function TaskNoteRow({
  taskId,
  taskTitle,
  notes,
  voice,
  autoSaveDelayMs,
}: {
  taskId: string | null;
  taskTitle: string;
  notes?: string | null;
  voice: Voice;
  autoSaveDelayMs?: number;
}) {
  if (!taskId) return null;
  return (
    <TaskNote
      taskId={taskId}
      taskTitle={taskTitle}
      notes={notes ?? null}
      voice={voice}
      autoSaveDelayMs={autoSaveDelayMs}
    />
  );
}

/**
 * The same disclosure bound to one step.
 *
 * `subject` names the step by POSITION as well as text — "step 2 of 5: Plan" —
 * because a screen-reader user meeting these controls in a list needs the
 * ordinal to tell two similarly-worded steps apart, and the position is the
 * thing the visible row shows that the button's own label does not.
 */
export function StepNote({
  stepId,
  order,
  total,
  text,
  notes,
  voice,
  autoSaveDelayMs,
}: {
  stepId: string;
  order: number;
  total: number;
  text: string;
  notes: string | null;
  voice: Voice;
  autoSaveDelayMs?: number;
}) {
  return (
    <NoteField
      subject={`step ${order} of ${total}: ${text}`}
      initialNote={notes}
      voice={voice}
      autoSaveDelayMs={autoSaveDelayMs}
      dense
      onSave={(next) => updateStepNotes(stepId, next)}
    />
  );
}
