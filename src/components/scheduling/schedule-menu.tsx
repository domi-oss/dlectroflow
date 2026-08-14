"use client";

import { useCallback, useId, useRef, useState, type ReactElement } from "react";
import { Popover } from "@base-ui/react/popover";
import { cn, touchTarget } from "@/lib/utils";
import {
  ANCHORED_POSITIONER,
  popupSurface,
  restoreFocusToTrigger,
} from "@/components/ui/anchored-popup";
import { fromZonedDateInput, toZonedDateInput } from "@/lib/scheduling/hours";
import { scheduleSummary } from "@/lib/scheduling/summary";
import { deriveWindows } from "@/lib/scheduling/windows";
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";
import type { ScheduleIntent } from "@/lib/scheduling/types";

/** Reclaim's four priorities, in the order a human ranks them. */
const PRIORITY_OPTIONS: ReadonlyArray<{
  value: SchedulePriority;
  label: string;
}> = [
  { value: SchedulePriority.Critical, label: "Critical" },
  { value: SchedulePriority.High, label: "High" },
  { value: SchedulePriority.Normal, label: "Normal" },
  { value: SchedulePriority.Low, label: "Low" },
];

const HOURS_OPTIONS: ReadonlyArray<{ value: ScheduleHours; label: string }> = [
  { value: ScheduleHours.Work, label: "Work" },
  { value: ScheduleHours.Personal, label: "Personal" },
];

const FIELD = "min-h-11 rounded-md border px-2";

export type ScheduleMenuProps = {
  /** Named in the dialog's accessible name, so the wrong row's menu is obvious. */
  taskTitle: string;
  /** What the menu opens with — persisted-or-default, resolved by the caller. */
  intent: ScheduleIntent;
  /** Reclaim-specific fields are hidden when the active method is ICS-only. */
  showReclaimFields: boolean;
  /** True while a push for this task is in flight; disables the primary action. */
  pending?: boolean;
  onSchedule: (intent: ScheduleIntent) => void;
  /** The control that opens the menu — rendered AS the popover trigger (Base UI's
   *  `render` prop), so its own label/title/classes are what the user sees and
   *  hears rather than a wrapper's. An element, not a ReactNode: Base UI merges
   *  its trigger props into this element and has nothing to merge them into
   *  otherwise. */
  trigger: ReactElement;
};

/**
 * The Schedule menu (#106): say when a task must be done and how urgent it is,
 * before it is pushed to Reclaim.
 *
 * Presentational by design. It owns a draft of the intent it was handed, shows
 * what that draft implies, and calls back — no data fetching, no server actions,
 * no Prisma. That is what lets it be tested with RTL alone while the persistence
 * stays in `pushStepsToGoogleTasks` and the prefill in `loadScheduleIntent`.
 *
 * Follows the popover idiom row-actions.tsx already established (#92) rather than
 * inventing a second one: `Popover.Portal container={rootRef}` so the popup is
 * still "inside this row" for row-scoped queries and nested presses,
 * `ANCHORED_POSITIONER` so it cannot be clipped off a phone screen, `render={<span
 * />}` throughout because the action line is phrasing content, and an explicit
 * `aria-label` on the popup because there is no visible heading for
 * `aria-labelledby` to point at (axe's aria-dialog-name).
 *
 * The summary never blocks: an over-committed deadline is warned about and the
 * Schedule button stays enabled, because a deliberate over-commit is the owner's
 * call. The one thing it does refuse is an EMPTY deadline, which is not a choice.
 */
export function ScheduleMenu({
  taskTitle,
  intent,
  showReclaimFields,
  pending,
  onSchedule,
  trigger,
}: ScheduleMenuProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  // `HTMLButtonElement` because Base UI's `Popover.Trigger` renders (and types)
  // a native button, which is what every caller supplies through `trigger`.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const hoursLabelId = useId();
  // Unique per instance: two rows' menus must not share one radio group, or
  // picking "Personal" in either would uncheck the other's.
  const hoursName = `schedule-hours-${useId()}`;

  const [open, setOpen] = useState(false);
  // The date field's RAW value, not a Date: an `<input type="date">` is empty
  // mid-edit, and holding the text is what lets "no deadline" be a visible,
  // refusable state instead of an Invalid Date reaching Reclaim.
  const [dateText, setDateText] = useState(() =>
    toZonedDateInput(intent.dueAt),
  );
  const [priority, setPriority] = useState<SchedulePriority>(intent.priority);
  const [hours, setHours] = useState<ScheduleHours>(intent.hours);
  // The clock is snapshotted when the menu opens rather than read during render:
  // feasibility is relative to "now", and a value that changes on every render
  // would make this component impure. Only read while open, which is the same
  // render pass that sets it.
  const [openedAt, setOpenedAt] = useState<Date | null>(null);

  /**
   * OPENING is what (re)seeds the draft, not closing.
   *
   * Both directions matter: an abandoned edit must not reappear on reopen (the
   * #23 lesson from the duration popover), AND a freshly persisted intent must.
   * Seeding on close would have shown the intent as it was at close time, so the
   * very first reopen after a successful push — the moment prefill exists for —
   * would still have shown the old values until the next one.
   */
  const openWithPrefill = useCallback(() => {
    setDateText(toZonedDateInput(intent.dueAt));
    setPriority(intent.priority);
    setHours(intent.hours);
    setOpenedAt(new Date());
    setOpen(true);
  }, [intent]);

  /**
   * Every close route funnels through here — Escape and outside press (via
   * `onOpenChange`), Cancel, and the primary Schedule press — so the focus
   * hand-off is written once.
   *
   * #253 — the hand-off is explicit, and BEFORE `setOpen(false)`, because this
   * dialog is now opened from an entry inside a row's ▾ popover: that enclosing
   * popup out-races Base UI's own async restoration and parks focus on its own
   * container, which is not a control. `restoreFocusToTrigger` carries the
   * mechanism; e2e/smoke/schedule-menu.spec.ts is the assertion (WCAG 2.4.3 —
   * "Focus comes back to the control that opened it"), and it failed 2 for 2 on
   * CI, retry included, before this line existed.
   *
   * Correct for the icon variant too (`breakdown/task-schedule.tsx`, the task
   * working view's pill), where it is what Base UI was already doing by default.
   */
  const close = useCallback(() => {
    restoreFocusToTrigger(triggerRef.current);
    setOpen(false);
  }, []);

  const dueAt = fromZonedDateInput(dateText, intent.dueAt);

  const draft: ScheduleIntent | null = dueAt
    ? { ...intent, dueAt, priority, hours }
    : null;
  const summary =
    draft && openedAt
      ? scheduleSummary(
          deriveWindows(draft, openedAt),
          draft.units.length,
          draft.dueAt,
        )
      : null;

  return (
    <span ref={rootRef} className="relative">
      <Popover.Root
        open={open}
        onOpenChange={(nextOpen) => (nextOpen ? openWithPrefill() : close())}
      >
        <Popover.Trigger ref={triggerRef} render={trigger} />
        <Popover.Portal container={rootRef} render={<span />}>
          <Popover.Positioner {...ANCHORED_POSITIONER} render={<span />}>
            <Popover.Popup
              render={<span />}
              aria-label={`Schedule ${taskTitle}`}
              className={popupSurface("min-w-64 gap-3 p-3 text-xs")}
            >
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">Done by</span>
                <input
                  type="date"
                  value={dateText}
                  onChange={(e) => setDateText(e.target.value)}
                  className={FIELD}
                />
              </label>

              {/* Not rendered at all on the .ics-only path — see the doc comment:
                  neither priority nor an hours category survives into a VEVENT,
                  so a control with no effect stays out of the tab order. */}
              {showReclaimFields && (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Priority</span>
                    <select
                      value={priority}
                      onChange={(e) =>
                        setPriority(e.target.value as SchedulePriority)
                      }
                      className={FIELD}
                    >
                      {PRIORITY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  {/* role=radiogroup on a span rather than a fieldset/legend: the
                      popup lives in phrasing content, where a fieldset is invalid
                      nesting. The ARIA group is named by the same visible text a
                      legend would have carried. */}
                  <span
                    role="radiogroup"
                    aria-labelledby={hoursLabelId}
                    className="flex flex-col gap-1"
                  >
                    <span id={hoursLabelId} className="text-muted-foreground">
                      Hours
                    </span>
                    <span className="flex gap-2">
                      {HOURS_OPTIONS.map((o) => (
                        <label
                          key={o.value}
                          className={cn(
                            touchTarget,
                            "justify-start gap-2 px-1",
                          )}
                        >
                          <input
                            type="radio"
                            name={hoursName}
                            value={o.value}
                            checked={hours === o.value}
                            onChange={() => setHours(o.value)}
                          />
                          {o.label}
                        </label>
                      ))}
                    </span>
                  </span>
                </>
              )}

              {/* Polite, not assertive: this is recomputed on every keystroke in
                  the date field, and an assertive region would interrupt the
                  typing it is describing. */}
              <span
                role="status"
                aria-live="polite"
                className={cn(
                  "text-pretty",
                  summary?.warning
                    ? "text-amber-700 dark:text-amber-400"
                    : "text-muted-foreground",
                )}
              >
                {summary?.text ?? "Pick a date to schedule this."}
              </span>

              <span className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={close}
                  className={cn(
                    "hover:bg-accent rounded-md px-2.5 font-medium",
                    touchTarget,
                  )}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={pending || draft == null}
                  onClick={() => {
                    if (!draft) return;
                    close();
                    onSchedule(draft);
                  }}
                  className={cn(
                    "bg-primary text-primary-foreground hover:opacity-90 rounded-md px-2.5 font-medium disabled:opacity-50",
                    touchTarget,
                  )}
                >
                  Schedule
                </button>
              </span>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </span>
  );
}
