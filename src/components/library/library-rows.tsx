"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn, touchTarget } from "@/lib/utils";
import { RowActions } from "@/components/inbox/row-actions";
import { rowMenuEntry } from "@/components/ui/anchored-popup";
import { rowMenuSeparator } from "@/components/ui/row-menu-separator";
import { CompleteButton } from "@/components/inbox/complete-button";
import {
  ensureFocusStep,
  completeItem,
  deleteBrainDumpItem,
  bulkBrainDumpAction,
  setItemEstimate,
} from "@/app/actions/braindump";
import { t, type Voice } from "@/lib/strings";
import { type AgingSettings } from "@/lib/aging";
import type { Item } from "@/components/inbox/bucket";
import { formatWake } from "@/lib/format";
import { useSelectMode } from "./use-select-mode";
import { SelectActionBar } from "./select-action-bar";
import { RowNumber, AgeLabel, singleTaskEstimate } from "./library-row-meta";
import { TaskNoteRow } from "@/components/breakdown/task-note";

/**
 * Inline estimate editor for a single-task ("plated") row — mirrors the
 * breakdown step-estimate input. Shows a compact "≈N min" pill; tapping it
 * swaps to a number input that persists via `setItemEstimate` on blur/Enter
 * and calls `onSaved` (the caller's `router.refresh()`) only when the value
 * actually changed.
 */
function EstimateEditor({
  id,
  minutes,
  voice,
  onSaved,
}: {
  id: string;
  minutes: number;
  voice: Voice;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(minutes);
  if (!editing) {
    return (
      <button
        type="button"
        aria-label={t("lib.editEstimate", voice)}
        className="text-muted-foreground hover:text-foreground shrink-0 rounded-full border px-2 py-0.5 text-xs"
        onClick={() => setEditing(true)}
      >
        ≈{minutes} {t("lib.min", voice)}
      </button>
    );
  }
  const commit = async () => {
    setEditing(false);
    // Guard against non-numeric/empty input. Both cases end up as `val = 0`
    // (a `type="number"` input sanitizes an invalid string to "" before
    // onChange fires, and Number("") is 0 — never literal NaN in practice,
    // but Number.isFinite is kept as a defensive belt-and-suspenders check).
    // Only persist + refresh a real, changed, positive value; the server
    // still clamps 1–600 on save.
    if (Number.isFinite(val) && val > 0 && val !== minutes) {
      // Await the write before refreshing, or router.refresh() can re-render
      // the route with the stale estimate before the server action commits.
      await setItemEstimate(id, val);
      onSaved();
    }
  };
  return (
    <input
      type="number"
      min={1}
      autoFocus
      aria-label={t("lib.editEstimate", voice)}
      value={val}
      onChange={(e) => setVal(Number(e.target.value))}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") void commit();
      }}
      className="border-input w-16 rounded-md border px-1 py-0.5 text-right text-xs"
    />
  );
}

/**
 * Interactive rows for the Library hub's in-flight tabs (Single-task / Saved
 * for later). Deliberately reuses the Inbox's `RowActions` layout + the same
 * workspace-scoped server actions (`ensureFocusStep` / `completeItem` /
 * `deleteBrainDumpItem`) rather than reinventing them, so the hub and the Inbox
 * share one code path and can't drift. Each action refreshes the current route
 * so the hub re-reads live data (the actions revalidate the Inbox, not here).
 *
 * The two-step delete confirm mirrors the Inbox's row pattern exactly: the
 * first tap reveals "Delete · Cancel"; only the confirming tap deletes.
 *
 * Single-task ("plated") rows additionally get the Task 6 meta bits (row
 * number + age label), an inline-editable estimate (rightmost, `EstimateEditor`
 * above), and select mode (Task 7's hook/bar + Task 4's `bulkBrainDumpAction`)
 * — mirroring `LibraryMultistep`. Saved-for-later ("pantry") rows are
 * deliberately left untouched: no meta, no select, no estimate, same wake-time
 * label + `RowActions` as before. Everything new below is gated on
 * `tab === "plated"` so pantry's markup/behavior can't drift.
 */
export function LibraryRows({
  items,
  tab,
  voice,
  now,
  settings,
}: {
  items: Item[];
  tab: "plated" | "pantry";
  voice: Voice;
  now: number;
  settings: AgingSettings;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const sel = useSelectMode();
  const ids = items.map((i) => i.id);
  const selecting = tab === "plated" && sel.selecting;

  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      await fn();
      router.refresh();
    });

  const runBulk = (action: "complete" | "saveForLater" | "delete") =>
    startTransition(async () => {
      await bulkBrainDumpAction([...sel.selected], action);
      sel.exit();
      router.refresh();
    });

  // ▶ Start focusing — ensure the item has a one-step task, then open the timer.
  const focusOnItem = (id: string) =>
    startTransition(async () => {
      const stepId = await ensureFocusStep(id);
      if (stepId) router.push(`/focus/${stepId}`);
    });

  // Two-step delete confirm, driven by one shared `confirmDeleteId` (matches the
  // Inbox rows).
  //
  // #251 sized the armed pair with `touchTarget`. #184 had sized every
  // end-cluster icon in the Inbox and this file's copy of the same factory was
  // missed, so the hub shipped a 24px 🗑 sitting next to a 44px note trigger. The
  // armed pair matters for a second reason: it REPLACES the resting control, so a
  // smaller pair shrank the action line under the pointer at exactly the moment a
  // mis-tap deletes something.
  //
  // #253 removed the `icon` variant along with the end cluster it was the only
  // caller of. Delete is now reached from the ▾ list, whose entry is 44px via
  // `rowMenuEntry` — the resting target did not shrink, it moved.
  const deleteControl = (id: string, key: string) =>
    confirmDeleteId === id ? (
      <span key={key} className="flex items-center gap-2">
        <button
          className={cn(
            touchTarget,
            "text-destructive rounded-md px-2.5 py-1 font-medium",
          )}
          onClick={() => {
            setConfirmDeleteId(null);
            run(() => deleteBrainDumpItem(id));
          }}
        >
          {t("action.delete", voice)}
        </button>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <button
          className={cn(
            touchTarget,
            "text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1",
          )}
          onClick={() => setConfirmDeleteId(null)}
        >
          {t("action.cancel", voice)}
        </button>
      </span>
    ) : (
      <button
        key={key}
        // Colours unchanged from the ▾-menu variant this replaces: muted at rest,
        // `hover:text-foreground` on the accent background. #253 changed WHERE the
        // resting delete lives, not how it reads.
        className={rowMenuEntry("text-muted-foreground hover:text-foreground")}
        onClick={() => setConfirmDeleteId(id)}
      >
        {t("action.delete", voice)}
      </button>
    );

  return (
    <>
      {tab === "plated" && (
        <div className="mb-2 flex justify-end">
          {sel.selecting ? (
            <div className="flex gap-2 text-sm">
              <button
                className="hover:bg-accent rounded-md border px-2.5 py-1"
                onClick={() => sel.selectAll(ids)}
              >
                {t("lib.selectAll", voice)}
              </button>
              <button
                className="text-muted-foreground rounded-md border px-2.5 py-1"
                onClick={sel.exit}
              >
                {t("action.cancel", voice)}
              </button>
            </div>
          ) : (
            <button
              className="hover:bg-accent rounded-md border px-2.5 py-1 text-sm"
              onClick={sel.enter}
            >
              {t("lib.select", voice)}
            </button>
          )}
        </div>
      )}

      <ul className={cn("space-y-2", pending && "opacity-70")}>
        {items.map((item, i) => {
          const checked = tab === "plated" && sel.selected.has(item.id);
          return (
            <li
              key={item.id}
              className={cn(
                "rounded-lg border px-4 py-3 text-sm",
                checked && "ring-primary ring-2",
              )}
            >
              <div className="flex items-center gap-3">
                {selecting && (
                  <input
                    type="checkbox"
                    checked={checked}
                    aria-label={item.text}
                    onChange={() => sel.toggle(item.id)}
                  />
                )}
                {tab === "plated" && <RowNumber n={i + 1} />}
                {/* #51: the title is the dominant row text; the row meta
                    (age / estimate / wake) recedes to text-xs muted. */}
                <span className="min-w-0 flex-1 text-base font-semibold break-words">
                  {item.text}
                </span>
                {tab === "plated" ? (
                  <AgeLabel
                    item={item}
                    now={now}
                    voice={voice}
                    settings={settings}
                  />
                ) : (
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {item.snoozedUntil
                      ? `${t("lib.wakes", voice)} ${formatWake(item.snoozedUntil)}`
                      : null}
                  </span>
                )}
                {tab === "plated" && (
                  <EstimateEditor
                    id={item.id}
                    minutes={singleTaskEstimate(item)}
                    voice={voice}
                    onSaved={() => router.refresh()}
                  />
                )}
              </div>
              {/* #44 — the note's collapsed trigger goes INSIDE the action
                  group, beside Complete (owner request from the review app);
                  the editor body opens below the action line but stays in this
                  same <li>, so it reads as belonging to this row and not to the
                  next one. `TaskNoteRow` hands back both halves and yields
                  nulls for a row with no `Task`, which is why the action group
                  is rendered from inside it rather than beside it. */}
              {!selecting && (
                <TaskNoteRow
                  taskId={item.taskId}
                  taskTitle={item.text}
                  notes={item.notes}
                  voice={voice}
                >
                  {({ trigger, body }) => (
                    <>
                      <RowActions
                        inline={[
                          <button
                            key="focus"
                            type="button"
                            onClick={() => focusOnItem(item.id)}
                            className={cn(
                              touchTarget,
                              "bg-primary text-primary-foreground rounded-md px-2.5 py-1 font-medium hover:opacity-90",
                            )}
                          >
                            {t("action.startFocus", voice)}
                          </button>,
                          <CompleteButton
                            key="complete"
                            voice={voice}
                            onClick={() => run(() => completeItem(item.id))}
                          />,
                          // #44 — third inline control, after Complete. Null for a
                          // row with no task, and `inline` is rendered as a list, so
                          // a null simply contributes nothing.
                          trigger,
                        ]}
                        /* ── #253: the ▾ is this row's CANONICAL action list ────
                           A mid-issue pass in this MR stripped every entry that
                           mirrored an inline button, leaving this list as
                           `[delete]` alone. Withdrawn, and the owner's reason is
                           that a principle held on one surface and reversed on two
                           others is not a principle: **the ▾ is the complete list
                           of what a row can do; the inline bar is a shortcut subset
                           of it.** #253 is about the row's HEIGHT, and this list is
                           behind a trigger, so its length costs the card nothing.

                           So both twins are back — `action.startFocusTimer` for the
                           inline `▶ Start focusing`, `action.completeFull` for the
                           inline `Complete` — with `Delete` last behind a
                           separator, the same grouping every inbox row now uses.

                           DERIVED from what this row can do, not copied from the
                           inbox's eight. Three deliberate absences:

                           • No `Move to…`. There is no bucket-move plumbing on this
                             surface at all (`LibraryRows` has no `moveItemToBucket`
                             and `library/page.tsx` resolves no dispatcher), so an
                             entry would be new capability rather than a restored
                             route. Not this issue's to add.
                           • No `Add as multi-step to-do` / `Add as single-task
                             to-do`. Both tabs here are ALREADY triaged — `plated` IS
                             the single-task bucket and `pantry` the saved one — so
                             one names what the row already is and the other has no
                             handler here.
                           • No `Edit time estimate`, on the rule the owner set for
                             the ✎ pencil: a permanently-visible control on the
                             row's own title/meta line stays OFF the canonical list.
                             `EstimateEditor` is exactly that — a 44px button in the
                             meta line — so a ▾ twin would be the `editMenuItem`
                             mirror again. (Contrast `task-steps.tsx`, where the
                             estimate is a plain `<span>` and its ▾ entry is the
                             only route, so it stays.)

                           ── #213's library leg, decided here ──────────────────
                           Schedule does NOT arrive on library rows in this MR, and
                           the reason is not scope: there is nothing to preserve.
                           `LibraryRows` never passed `schedule=`, so no affordance
                           is lost by deleting the icon cluster that prop rendered
                           through — #213's checkbox described a prop whose only
                           render path was `row-actions.tsx`'s deleted cluster,
                           which is why it could not be written independently of
                           this change.

                           Making it real needs three things this surface has none
                           of: Google connection state resolved in
                           `library/page.tsx` (which resolves none), a per-row
                           in-flight flag, and somewhere to PUT a failure. That
                           last one is the blocker — library rows have no
                           failure-notice surface at all, which is the open defect
                           in #230. Adding a network write to the one surface that
                           cannot report a failed write ships #230's bug again in a
                           new place, so #213's library leg is re-specified (add a
                           `ScheduleControl variant="menu"` entry + plumb the
                           state) and sequenced after #230, not closed here. */
                        menu={[
                          <button
                            key="focus-m"
                            type="button"
                            className={rowMenuEntry()}
                            onClick={() => focusOnItem(item.id)}
                          >
                            {t("action.startFocusTimer", voice)}
                          </button>,
                          <button
                            key="complete-m"
                            type="button"
                            className={rowMenuEntry()}
                            onClick={() => run(() => completeItem(item.id))}
                          >
                            {t("action.completeFull", voice)}
                          </button>,
                          rowMenuSeparator("sep-destructive"),
                          deleteControl(item.id, "delete-m"),
                        ]}
                      />
                      {body}
                    </>
                  )}
                </TaskNoteRow>
              )}
            </li>
          );
        })}
      </ul>

      {tab === "plated" && sel.selecting && (
        <SelectActionBar
          count={sel.selected.size}
          voice={voice}
          pending={pending}
          onComplete={() => runBulk("complete")}
          onSaveForLater={() => runBulk("saveForLater")}
          onDelete={() => runBulk("delete")}
        />
      )}
    </>
  );
}
