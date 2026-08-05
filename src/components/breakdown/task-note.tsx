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
