"use client";

import { updateTaskNotes } from "@/app/actions/task-notes";
import { updateStepNotes } from "@/app/actions/step-notes";
import { updateItemNotes } from "@/app/actions/item-notes";
import { NoteField } from "@/components/breakdown/note-field";
import type { ReactNode } from "react";
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
  children,
}: {
  taskId: string;
  /** Goes into the control's accessible name. */
  taskTitle: string;
  notes: string | null;
  voice: Voice;
  autoSaveDelayMs?: number;
  /** Placement, passed straight to `NoteField`. Omit for the stacked layout the
   *  task detail page uses; supply it to put the trigger in a row's action
   *  group and the body below the action line. */
  children?: (parts: { trigger: ReactNode; body: ReactNode }) => ReactNode;
}) {
  return (
    <NoteField
      subject={taskTitle}
      initialNote={notes}
      voice={voice}
      autoSaveDelayMs={autoSaveDelayMs}
      onSave={(next) => updateTaskNotes(taskId, next)}
    >
      {children}
    </NoteField>
  );
}

/**
 * The same disclosure bound to an UNTRIAGED brain-dump item (#186).
 *
 * A third grain rather than a fork: `NoteField` imports no server action, which
 * is exactly what lets one component serve all three. This is the `TaskNote`
 * wrapper with `updateItemNotes` in place of `updateTaskNotes` — nothing about
 * the disclosure, the naming discipline or the autosave differs, because nothing
 * about them should.
 *
 * It exists now and did not before because the COLUMN did not exist before.
 * `!270` left the Needs-review row with no note affordance and said why: an
 * untriaged item has no `Task` row, so the control could only ever fail. #186
 * added `BrainDumpItem.notes`, and #179 then began WRITING it at capture — a note
 * split off inline needs somewhere to be read, or an inline capture looks like
 * text that went missing.
 */
export function ItemNote({
  itemId,
  itemTitle,
  notes,
  voice,
  autoSaveDelayMs,
  children,
}: {
  itemId: string;
  /** Goes into the control's accessible name, same as `taskTitle` above. */
  itemTitle: string;
  notes: string | null;
  voice: Voice;
  autoSaveDelayMs?: number;
  children?: (parts: { trigger: ReactNode; body: ReactNode }) => ReactNode;
}) {
  return (
    <NoteField
      subject={itemTitle}
      initialNote={notes}
      voice={voice}
      autoSaveDelayMs={autoSaveDelayMs}
      onSave={(next) => updateItemNotes(itemId, next)}
    >
      {children}
    </NoteField>
  );
}

/**
 * The task note as a LIST ROW mounts it (#44).
 *
 * One wrapper for the Inbox and both Library components, rather than the same
 * three-line conditional written out three times — the gap this exists to close
 * was exactly a surface where somebody wrote it twice and missed the third.
 *
 * `taskId` is nullable across every one of those surfaces, and the null is not an
 * edge case: a brain-dump item that has never been triaged has no `Task` row.
 *
 * ## It picks the GRAIN, and that is the load-bearing part (#186)
 *
 * There are two note columns and only one of them is live. Before triage the note
 * is on the item; `brainDumpItemToTaskData` then COPIES it onto the `Task`, and
 * from that point every note surface reads `Task.notes` while the item's copy is a
 * historical leftover. So `taskId` selects the column, exactly as `liveNote`
 * (src/lib/braindump-to-task.ts) does for the ✎ title editor and for `renameItem`
 * — three readers, one rule, because a reader that picked the other column would
 * write an edit nothing displays.
 *
 * Until #186 the untriaged branch rendered NOTHING, and the reason was good: there
 * was no `notes` column on `BrainDumpItem` at all, so the affordance's save could
 * only fail. #186 added the column and #179 began writing it at CAPTURE, which is
 * what changed the answer — a note split off inline has to be readable, or an
 * inline capture looks like text that went missing.
 *
 * Both ids null is still "render nothing": a surface that has not been given the
 * item's id has no row to write to either.
 *
 * ## Where the note is offered, and where it deliberately is not (#44)
 *
 * Kept here because a deliberate absence and a forgotten one look identical in
 * a diff, which is how the Library gap shipped.
 *
 * PLACEMENT of the collapsed trigger (owner request, from the review app):
 * every LIST ROW puts it inside the row's action group, beside Complete, with
 * the expanded body opening below the action line but still inside the row's
 * own `<li>` so it reads as belonging to that row. The task detail page keeps
 * the stacked layout — it has no `RowActions` group to join, and the note is a
 * field of the task there rather than one more row control.
 *
 * | Surface | Grain | Note | Placement | Why |
 * |---|---|---|---|---|
 * | `/tasks/[id]` header card | task | editable | stacked | no `RowActions` group to join; here the note is a field of the task, not one more row control |
 * | `/tasks/[id]` step rows | step | editable | in the action group | `TaskSteps` |
 * | `/tasks/[id]` done step rows | step | read-only | — | annotating finished work has no purpose; hiding what was written would be worse |
 * | `/` Inbox — To-do rows | task | editable | in the action group | |
 * | `/` Inbox — Multi-step rows | task | editable | in the action group | |
 * | `/` Inbox — expanded step rows | step | editable | in the action group | `TaskSteps` |
 * | `/` Inbox — Needs review rows | item | editable | in the action group | #186 gave `BrainDumpItem` its own `notes`; #179 writes it at capture |
 * | `/` Inbox — Saved-for-later rows | item | editable | in the action group | untriaged too, and a note must not vanish because a row was parked |
 * | `/library` Single-task + Saved-for-later | task | editable | in the action group | |
 * | `/library` rows with no task | item | **none, for now** | — | #186 wired the item grain on the Inbox only; `library/page.tsx` does not select `BrainDumpItem.notes`, so `itemId` is not passed and the null branch still applies. Stated because a deliberate gap and a forgotten one look identical in a diff — which is how the #44 Library gap shipped |
 * | `/library` Multi-step row | task | editable | **stacked** | this row has no `RowActions` at all — it is a disclosure title that expands into the step list |
 * | `/library` Multi-step expanded steps | step | editable | in the action group | `TaskSteps` |
 * | `/library` Done | task | read-only | — | closure view with no other controls; same call as a done step row |
 * | `/focus/[stepId]` session | task + step | read-only | — | the point of the surface is not editing |
 * | `/focus` launcher lanes | task + step | none | — | a navigation list; every entry links INTO the session, which shows the note |
 * | `/tasks/[id]?edit=1` breakdown chat | task + proposed steps | none | — | the steps are an unsaved model proposal with no ids, so a step note has nowhere to live |
 * | Dashboard | none | none | — | aggregates and badges, no task or step rows |
 * | Any row with BOTH ids null | — | none | — | no row of either grain to write to |
 */
export function TaskNoteRow({
  taskId,
  itemId = null,
  taskTitle,
  notes,
  itemNotes,
  voice,
  autoSaveDelayMs,
  children,
}: {
  taskId: string | null;
  /**
   * The `BrainDumpItem` behind this row, for the untriaged grain (#186).
   *
   * OPTIONAL and defaulting to null, so a surface that has not been taught about
   * the second grain keeps exactly its old behaviour instead of silently
   * mounting a control against `undefined`. The Library rows are that case
   * today; their `page.tsx` does not select the column yet.
   */
  itemId?: string | null;
  /** The row's title, whichever grain it is in. Goes into both controls'
   *  accessible names. */
  taskTitle: string;
  /** `Task.notes` — live once the row is task-backed. */
  notes?: string | null;
  /** `BrainDumpItem.notes` — live until then (#186). */
  itemNotes?: string | null;
  voice: Voice;
  autoSaveDelayMs?: number;
  /**
   * Receives the two halves to place: `trigger` goes in the row's action group
   * beside Complete (owner request), `body` below the action line. Called with
   * BOTH null when the row has no task — the caller still has to render its
   * action group, so returning null here would take the whole row with it.
   *
   * OPTIONAL, because not every task row has an action group to join.
   * `LibraryMultistep`'s row is a disclosure title with no `RowActions` at all,
   * so there is nothing to move the trigger into and it stays stacked. Omitting
   * this is that decision, and the default below is the stacked layout.
   */
  children?: (parts: { trigger: ReactNode; body: ReactNode }) => ReactNode;
}) {
  if (!taskId) {
    // #186 — the item grain. Nothing at all only when there is no row of EITHER
    // kind to write to.
    if (!itemId) return <>{children?.({ trigger: null, body: null })}</>;
    return (
      <ItemNote
        itemId={itemId}
        itemTitle={taskTitle}
        notes={itemNotes ?? null}
        voice={voice}
        autoSaveDelayMs={autoSaveDelayMs}
      >
        {children}
      </ItemNote>
    );
  }
  return (
    <TaskNote
      taskId={taskId}
      taskTitle={taskTitle}
      notes={notes ?? null}
      voice={voice}
      autoSaveDelayMs={autoSaveDelayMs}
    >
      {children}
    </TaskNote>
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
  children,
}: {
  stepId: string;
  order: number;
  total: number;
  text: string;
  notes: string | null;
  voice: Voice;
  autoSaveDelayMs?: number;
  children?: (parts: { trigger: ReactNode; body: ReactNode }) => ReactNode;
}) {
  return (
    <NoteField
      subject={`step ${order} of ${total}: ${text}`}
      initialNote={notes}
      voice={voice}
      autoSaveDelayMs={autoSaveDelayMs}
      dense
      onSave={(next) => updateStepNotes(stepId, next)}
    >
      {children}
    </NoteField>
  );
}
