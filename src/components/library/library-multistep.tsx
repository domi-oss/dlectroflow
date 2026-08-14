"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn, touchTarget } from "@/lib/utils";
import { t, type Voice } from "@/lib/strings";
import { type AgingSettings } from "@/lib/aging";
import type { Item } from "@/components/inbox/bucket";
import { TaskSteps } from "@/components/breakdown/task-steps";
import { TaskNoteRow } from "@/components/breakdown/task-note";
import { bulkBrainDumpAction } from "@/app/actions/braindump";
import { useSelectMode } from "./use-select-mode";
import { SelectActionBar } from "./select-action-bar";
import {
  RowNumber,
  NextStepLine,
  ProgressBar,
  AgeLabel,
  EstimatePill,
  ActiveStepPill,
  rowEmoji,
  remainingMinutes,
} from "./library-row-meta";

/**
 * Multi-step tab of the Library hub: each row is a broken-down to-do that
 * inline-expands into its full `TaskSteps` working view (single-open —
 * expanding one row collapses any other), so switching a step's focus/complete
 * state never leaves the hub. The latest item (bucket order is createdAt desc)
 * opens by default. Collapsed rows show the meta bits from Task 6 (next-step
 * preview, progress bar, age label, remaining-estimate pill) so the row is
 * still scannable without opening it.
 *
 * Select mode (Task 7's hook/bar) suppresses expansion entirely — a tap on a
 * row toggles its checkbox instead of opening it — and reuses
 * `bulkBrainDumpAction` (Task 4) for the batch complete/save/delete ops so the
 * hub never re-implements the workspace-scoped per-item logic.
 *
 * Header row (!83 follow-up): a single-open expand/collapse toggle sits on the
 * left. When a row is open it reads "Collapse all" and clears the single-open
 * state; when none is open it reads "Expand all" and re-opens just the latest
 * row (items[0]) — it never fans out every row, so single-open holds either
 * way. Immediately to its LEFT, an "Open task" control links to the
 * currently-expanded row's task page — shown only while a row is expanded,
 * hidden entirely in select mode. "Select" stays on the right.
 */
export function LibraryMultistep({
  items,
  voice,
  now,
  settings,
}: {
  items: Item[];
  voice: Voice;
  now: number;
  settings: AgingSettings;
}) {
  const router = useRouter();
  // Default open = latest (bucket is createdAt desc → first row).
  const [expandedId, setExpandedId] = useState<string | null>(
    items[0]?.id ?? null,
  );
  const sel = useSelectMode();
  const [pending, startTransition] = useTransition();
  const ids = items.map((i) => i.id);
  const expandedItem = items.find((i) => i.id === expandedId) ?? null;

  const runBulk = (action: "complete" | "saveForLater" | "delete") =>
    startTransition(async () => {
      await bulkBrainDumpAction([...sel.selected], action);
      sel.exit();
      router.refresh();
    });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          {/* `?from=library` lets the task page's back link return here
              (→ /library?tab=sorted) instead of always going to / (the inbox
              root) (#8 follow-up — Library "Open task" back-button bug). Sits to the
              LEFT of the expand/collapse toggle; shown only while a row is
              expanded, hidden entirely in select mode (moved from the panel to
              the header in !83; positioned left of the toggle in its follow-up).

              #205 — sized even though it is a `<Link>`. That issue's table counts
              `<button>` and so does not list this control, but it is a bordered
              pill in the same header cluster at the same `py-1` as the toggle
              beside it, and the issue's OWN method (grep `py-1`) does flag this
              line. A control that looks identical to its neighbour and measures
              20px shorter is precisely the visible inconsistency being removed. */}
          {!sel.selecting && expandedItem?.taskId && (
            <Link
              href={`/tasks/${expandedItem.taskId}?from=library`}
              className={cn(
                touchTarget,
                "hover:bg-accent rounded-md border px-2.5 py-1",
              )}
            >
              {t("lib.openTask", voice)}
            </Link>
          )}
          {/* Single-open expand/collapse toggle. Open → "Collapse all" clears
              the single-open state; none open → "Expand all" re-opens just the
              latest row (items[0]; bucket is createdAt desc). It never fans out
              every row — single-open is preserved either way. */}
          <button
            type="button"
            className={cn(
              touchTarget,
              "hover:bg-accent rounded-md border px-2.5 py-1",
            )}
            onClick={() =>
              setExpandedId(expandedItem ? null : (items[0]?.id ?? null))
            }
          >
            {t(expandedItem ? "lib.collapseAll" : "lib.expandAll", voice)}
          </button>
        </div>
        {sel.selecting ? (
          <div className="flex gap-2 text-sm">
            <button
              className={cn(
                touchTarget,
                "hover:bg-accent rounded-md border px-2.5 py-1",
              )}
              onClick={() => sel.selectAll(ids)}
            >
              {t("lib.selectAll", voice)}
            </button>
            <button
              className={cn(
                touchTarget,
                "text-muted-foreground rounded-md border px-2.5 py-1",
              )}
              onClick={sel.exit}
            >
              {t("action.cancel", voice)}
            </button>
          </div>
        ) : (
          <button
            className={cn(
              touchTarget,
              "hover:bg-accent rounded-md border px-2.5 py-1 text-sm",
            )}
            onClick={sel.enter}
          >
            {t("lib.select", voice)}
          </button>
        )}
      </div>

      <ul className={cn("space-y-2", pending && "opacity-70")}>
        {items.map((item, i) => {
          const expanded = expandedId === item.id && !sel.selecting;
          const checked = sel.selected.has(item.id);
          const emoji = voice === "playful" ? rowEmoji(item) : null;
          return (
            <li
              key={item.id}
              className={cn(
                "rounded-lg border px-4 py-3 text-sm",
                checked && "ring-primary ring-2",
              )}
            >
              <div className="flex items-start gap-3">
                {sel.selecting && (
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={checked}
                    aria-label={item.text}
                    onChange={() => sel.toggle(item.id)}
                  />
                )}
                <RowNumber n={i + 1} />
                {emoji && (
                  <span aria-hidden className="text-base">
                    {emoji}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  {/* #205 — DELIBERATELY NOT given `touchTarget`, and the reason
                      is written here because that issue's scope asks for it in
                      the file rather than in the issue.

                      Three reasons, in order of weight. It is a disclosure TITLE
                      rather than a header control, and its target is already the
                      full row width — the dimension a thumb actually misses on a
                      phone. Sizing it would add ~20px to EVERY collapsed row,
                      which is the direct opposite of what #253 is doing to this
                      surface, and #205 says to check 390px before widening
                      anything. And `touchTarget` carries `justify-center` plus
                      `inline-flex`, either of which would centre a title that has
                      to stay left-aligned and kill the `block w-full` beside it.

                      `library-multistep.test.tsx` pins this as an assertion, so
                      "make everything 44px" cannot be applied here without a test
                      going red and pointing back at this comment. */}
                  <button
                    type="button"
                    className="block w-full text-left text-base font-semibold break-words"
                    aria-expanded={sel.selecting ? undefined : expanded}
                    aria-controls={
                      expanded && item.taskId
                        ? `lib-steps-${item.id}`
                        : undefined
                    }
                    onClick={() =>
                      sel.selecting
                        ? sel.toggle(item.id)
                        : setExpandedId(expanded ? null : item.id)
                    }
                  >
                    {item.text}
                  </button>
                  {!expanded && <NextStepLine item={item} voice={voice} />}
                  {!expanded && <ProgressBar item={item} />}
                  {!expanded && (
                    <div className="mt-1">
                      <AgeLabel
                        item={item}
                        now={now}
                        voice={voice}
                        settings={settings}
                      />
                    </div>
                  )}
                </div>
                {!expanded && (
                  <span className="text-muted-foreground shrink-0 rounded-full border px-2 py-0.5 text-xs">
                    {item.stepsDone}/{item.stepsTotal}{" "}
                    {t("progress.done", voice)}
                  </span>
                )}
                {!expanded && (
                  <EstimatePill
                    minutes={remainingMinutes(item)}
                    voice={voice}
                  />
                )}
                {!expanded && <ActiveStepPill item={item} voice={voice} />}
              </div>

              {/* #44 — the TASK's own note. Distinct from the per-step notes
                  in the expanded list below: this is context for the whole
                  task, so it stays available whether or not the steps are
                  showing.
                  STACKED here, unlike the other list rows, and deliberately:
                  this row has no `RowActions` group — it is a disclosure title
                  that expands into the step list — so there is no action group
                  for the trigger to join. */}
              {!sel.selecting && (
                <TaskNoteRow
                  taskId={item.taskId}
                  taskTitle={item.text}
                  notes={item.notes}
                  voice={voice}
                />
              )}

              {expanded && item.taskId && (
                <div id={`lib-steps-${item.id}`} className="mt-3 space-y-2">
                  <TaskSteps
                    taskId={item.taskId}
                    voice={voice}
                    steps={item.steps.map((s) => ({
                      id: s.id,
                      order: s.order,
                      total: item.stepsTotal,
                      text: s.text,
                      subtaskEmoji: s.subtaskEmoji,
                      estMinutes: s.estMinutes,
                      done: s.done,
                      notes: s.notes ?? null,
                      resumable: s.resumable,
                    }))}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {sel.selecting && (
        <SelectActionBar
          count={sel.selected.size}
          voice={voice}
          pending={pending}
          onComplete={() => runBulk("complete")}
          onSaveForLater={() => runBulk("saveForLater")}
          onDelete={() => runBulk("delete")}
        />
      )}
    </div>
  );
}
