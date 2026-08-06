"use client";

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { ensureFocusStep, completeItem } from "@/app/actions/braindump";
import { completeStep } from "@/app/actions/focus";
import { t, type Voice } from "@/lib/strings";
import type { SingleFocusable, FocusableStep } from "@/lib/focus-launcher";
import { CompleteButton } from "@/components/inbox/complete-button";
import { SubHeader, SEE_ALL } from "@/components/inbox/sub-header";

/**
 * #136 — the optimistic removal both lanes share.
 *
 * Completing a row drops it from the lane immediately and only then persists,
 * because waiting for a round trip to acknowledge a ✓ is the latency this whole
 * launcher exists to avoid. The FILTERED array is the only collection this
 * returns: the bug this refactor fixes was a second, unfiltered reading of the
 * same lane being taken elsewhere for the count, so there is deliberately
 * nothing else on offer.
 */
function useOptimisticRows<T>(items: T[], keyOf: (row: T) => string) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<Set<string>>(new Set());

  const rows = items.filter((row) => !done.has(keyOf(row)));

  /** Drop the row now, persist it, then let the server catch up. */
  const complete = (key: string, persist: () => Promise<void>) => {
    setDone((prev) => new Set(prev).add(key));
    startTransition(async () => {
      await persist();
      router.refresh();
    });
  };

  return {
    rows,
    pending,
    complete,
    startTransition,
    /** The user has completed at least one row here since this lane mounted —
     *  the memory that survives `router.refresh()` replacing `items`, so an
     *  emptied lane goes on reading as EMPTIED once the server catches up
     *  rather than reverting to "there was never anything here". */
    completedAny: done.size > 0,
  };
}

/**
 * #136 — one lane section: the SubHeader, then EITHER the rows or a zero-state.
 *
 * `rows` is the single source for all three of the count badge, the list, and
 * the choice between them. That is the point, not an implementation detail: the
 * count used to be rendered by the launcher shell (a Server Component) from the
 * SERVER's rows while the list was rendered here from the OPTIMISTICALLY
 * FILTERED ones, so completing the last row in a lane left "1" sitting beside a
 * bare empty `<ul>` until `router.refresh()` landed — a blank box and a number
 * denying it, at the moment the app should be acknowledging the user cleared
 * something. Taking the count from `rows.length` and the list from `rows.map()`
 * makes that disagreement structurally impossible; a `count` prop would leave it
 * one call site away from coming back.
 *
 * The zero-state follows the same new-vs-emptied distinction /focus already
 * draws at page level with `clearedToday`:
 *
 *  • `hadRows` false — the server handed this lane nothing and the user has
 *    completed nothing here. Neutral `bucket.empty` ("Nothing here yet"),
 *    exactly as before, and NOT a live region: it was there on first paint,
 *    nothing happened.
 *  • `hadRows` true with nothing left — the user emptied it. A small
 *    celebration (`focus.lane.cleared`), announced, because the list changing
 *    out from under them IS the event.
 *
 * That second branch has to outlive the optimistic window, not just fill it.
 * `router.refresh()` arrives a moment later with `items` legitimately empty, and
 * deciding on `items.length` alone would swap the acknowledgement for "nothing
 * here yet" a few hundred milliseconds after earning it — the wrong half of the
 * very distinction #136 asks for, since a lane the user emptied is still an
 * emptied lane once the server agrees.
 */
function Lane<T>({
  label,
  seeAllHref,
  voice,
  rows,
  hadRows,
  pending,
  row,
}: {
  label: string;
  seeAllHref: string;
  voice: Voice;
  /** The rows to render — and, therefore, the count beside them. */
  rows: readonly T[];
  /** This lane has held at least one row — either the server handed it some, or
   *  the user has completed one here since it mounted. Either way an empty
   *  `rows` means it was EMPTIED rather than never filled, which is the whole
   *  distinction the zero-state below turns on. */
  hadRows: boolean;
  pending: boolean;
  /** Renders one row (and owns its `key`). */
  row: (item: T) => ReactNode;
}) {
  const cleared = rows.length === 0 && hadRows;
  const noticeRef = useRef<HTMLParagraphElement>(null);

  // a11y (WCAG 2.4.3) — the ✓ that was just pressed unmounts along with its
  // row, and the repo's rule for a transition that unmounts the pressed control
  // (#65/#66/#137 in focus-timer.tsx) is that focus must land somewhere
  // sensible instead of dropping to <body>. The notice is the only sensible
  // place, and because the focus target IS the live region the announcement
  // cannot be cut short by the focus move — the problem the focus-timer failure
  // notice needs `aria-describedby` to work around.
  useEffect(() => {
    if (cleared) noticeRef.current?.focus();
  }, [cleared]);

  return (
    // A NAMED landmark (`<section>` + an accessible name → role="region", WCAG
    // 1.3.1) rather than the anonymous `<div>` the launcher shell used to wrap
    // each lane in. Two unnamed groups of rows on /focus gave a screen-reader
    // user nothing to distinguish "single-task" from "multi-step" while moving
    // between them, and now that the lane owns its own heading and count it can
    // carry the name too. `label` is used for both, from the one `t()` call the
    // lane makes, so the visible heading and the accessible name cannot drift.
    <section aria-label={label}>
      <SubHeader
        label={label}
        count={rows.length}
        seeAllHref={seeAllHref}
        voice={voice}
      />
      {rows.length > 0 ? (
        <ul className={cn("space-y-2", pending && "opacity-70")}>
          {rows.map(row)}
        </ul>
      ) : cleared ? (
        // `role="status"` — polite, and conditionally mounted, the same pattern
        // as the inbox capture confirmation and the focus-timer retry line.
        // Never `role="alert"`: finishing the last thing in a lane is not a
        // fault. Same element and same border tokens as the neutral paragraph
        // below (the pattern !215 established for #111), so the zero-tolerance
        // colour-contrast gate sees no new pairing; it drops
        // `text-muted-foreground` for the reason the page-level all-clear card
        // does, which is that a celebration is read at full contrast.
        <p
          ref={noticeRef}
          role="status"
          tabIndex={-1}
          className="focus-visible:ring-ring rounded-lg border border-dashed px-4 py-4 text-center text-xs outline-none focus-visible:ring-2"
        >
          {t("focus.lane.cleared", voice)}
        </p>
      ) : (
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-4 text-center text-xs">
          {t("bucket.empty", voice)}
        </p>
      )}
    </section>
  );
}

/** Single-task to-dos lane: ▶ Start (ensureFocusStep → route) + optimistic ✓. */
export function SingleTaskLane({
  items,
  voice,
}: {
  items: SingleFocusable[];
  voice: Voice;
}) {
  const router = useRouter();
  const { rows, pending, complete, startTransition, completedAny } =
    useOptimisticRows(items, (i) => i.itemId);

  const start = (itemId: string) =>
    startTransition(async () => {
      const stepId = await ensureFocusStep(itemId);
      if (stepId) router.push(`/focus/${stepId}`);
    });

  return (
    <Lane
      label={t("section.singleTask", voice)}
      seeAllHref={SEE_ALL.singleTask}
      voice={voice}
      rows={rows}
      hadRows={items.length > 0 || completedAny}
      pending={pending}
      row={(s) => (
        <li
          key={s.itemId}
          className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm"
        >
          <span className="min-w-0 flex-1 break-words">{s.text}</span>
          {s.estMinutes > 0 && (
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {s.estMinutes}m
            </span>
          )}
          <button
            type="button"
            onClick={() => start(s.itemId)}
            className="bg-primary text-primary-foreground inline-flex min-h-[44px] shrink-0 items-center rounded-md px-3 font-medium hover:opacity-90"
          >
            {t("focus.lane.start", voice)}
          </button>
          <CompleteButton
            voice={voice}
            onClick={() => complete(s.itemId, () => completeItem(s.itemId))}
          />
        </li>
      )}
    />
  );
}

/** Multi-step to-dos lane: ▶ Open (route straight to the shown step) + optimistic
 * ✓ that completes that step (completeStep). */
export function MultiStepLane({
  items,
  voice,
}: {
  items: FocusableStep[];
  voice: Voice;
}) {
  const router = useRouter();
  const { rows, pending, complete, completedAny } = useOptimisticRows(
    items,
    (e) => e.stepId,
  );

  return (
    <Lane
      label={t("section.multiStep", voice)}
      seeAllHref={SEE_ALL.multiStep}
      voice={voice}
      rows={rows}
      hadRows={items.length > 0 || completedAny}
      pending={pending}
      // #44 — NO note here, deliberately. These lanes are a navigation list:
      // every entry exists to be picked, and picking one lands in the focus
      // session, which shows both notes. Repeating them in the chooser would
      // make a scan-and-pick surface into a reading one, and the lane rows are
      // already carrying a task title, a step title and two counters.
      row={(e) => (
        <li
          key={e.stepId}
          className="flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-sm"
        >
          <span className="text-muted-foreground text-xs">{e.taskTitle}</span>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 break-words font-medium">
              {e.subtaskEmoji ? `${e.subtaskEmoji} ` : ""}
              {e.stepText}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {e.stepsDone}/{e.stepsTotal}
            </span>
            {e.estMinutes > 0 && (
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {e.estMinutes}m
              </span>
            )}
            <button
              type="button"
              onClick={() => router.push(`/focus/${e.stepId}`)}
              className="bg-primary text-primary-foreground inline-flex min-h-[44px] shrink-0 items-center rounded-md px-3 font-medium hover:opacity-90"
            >
              {t("focus.lane.open", voice)}
            </button>
            <CompleteButton
              voice={voice}
              onClick={() => complete(e.stepId, () => completeStep(e.stepId))}
            />
          </div>
        </li>
      )}
    />
  );
}
