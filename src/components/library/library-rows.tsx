"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { RowActions } from "@/components/inbox/row-actions";
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

  // Two-step delete confirm — one shared `confirmDeleteId` drives both the
  // end-cluster 🗑 icon and the ▾-menu entry, so confirming/cancelling either
  // keeps the other in sync (matches the Inbox rows).
  const deleteControl = (
    id: string,
    key: string,
    {
      fullWidth = false,
      icon = false,
    }: { fullWidth?: boolean; icon?: boolean } = {},
  ) =>
    confirmDeleteId === id ? (
      <span key={key} className="flex items-center gap-2">
        <button
          className="text-destructive rounded-md px-2.5 py-1 font-medium"
          onClick={() => {
            setConfirmDeleteId(null);
            run(() => deleteBrainDumpItem(id));
          }}
        >
          {t("action.delete", voice)}
        </button>
        <span className="text-muted-foreground">·</span>
        <button
          className="text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1"
          onClick={() => setConfirmDeleteId(null)}
        >
          {t("action.cancel", voice)}
        </button>
      </span>
    ) : icon ? (
      <button
        key={key}
        aria-label={t("action.delete", voice)}
        title={t("action.delete", voice)}
        className="text-muted-foreground hover:text-destructive rounded-md px-2.5 py-1"
        onClick={() => setConfirmDeleteId(id)}
      >
        🗑
      </button>
    ) : (
      <button
        key={key}
        className={cn(
          "text-muted-foreground hover:text-destructive rounded-md px-2.5 py-1",
          fullWidth && "hover:bg-accent hover:text-foreground w-full text-left",
        )}
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
              {!selecting && (
                <RowActions
                  inline={[
                    <button
                      key="focus"
                      type="button"
                      onClick={() => focusOnItem(item.id)}
                      className="bg-primary text-primary-foreground hover:opacity-90 rounded-md px-2.5 py-1 font-medium"
                    >
                      {t("action.startFocus", voice)}
                    </button>,
                    <CompleteButton
                      key="complete"
                      voice={voice}
                      onClick={() => run(() => completeItem(item.id))}
                    />,
                  ]}
                  del={deleteControl(item.id, "delete", { icon: true })}
                  menu={[
                    <button
                      key="focus-m"
                      type="button"
                      className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                      onClick={() => focusOnItem(item.id)}
                    >
                      {t("step.startFocusTimer", voice)}
                    </button>,
                    <button
                      key="complete-m"
                      type="button"
                      className="hover:bg-accent w-full rounded-md px-2.5 py-1 text-left"
                      onClick={() => run(() => completeItem(item.id))}
                    >
                      {t("action.completeFull", voice)}
                    </button>,
                    deleteControl(item.id, "delete-m", { fullWidth: true }),
                  ]}
                />
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
