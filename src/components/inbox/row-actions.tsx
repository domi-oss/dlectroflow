"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { Popover } from "@base-ui/react/popover";
import { cn, touchTarget } from "@/lib/utils";
import {
  ANCHORED_POSITIONER,
  popupSurface,
  restoreFocusToTrigger,
  rowMenuEntry,
} from "@/components/ui/anchored-popup";
// Only the SENTENCE, not the component. #253 made the `menu` variant a navigation
// entry, so the one place this file still needs #128's guidance is the `icon`
// variant's `title` — the component itself is rendered by the surfaces that own a
// connect control (`settings/integrations-panel.tsx`, `breakdown/breakdown-chat.tsx`,
// and `breakdown/task-schedule.tsx`, which passes its own id in as `accountHintId`).
import { GOOGLE_ACCOUNT_HINT } from "@/components/integrations/google-account-hint";
import { ScheduleMenu } from "@/components/scheduling/schedule-menu";
import type { ScheduleIntent } from "@/lib/scheduling/types";

const DURATION_PRESETS = [15, 30, 60] as const;

const MAX_CUSTOM_MINUTES = 480;

export type ScheduleControlProps = {
  state:
    | "ready_steps"
    | "needs_duration"
    | "connect"
    | "reconnect"
    | "ics_ready_steps"
    | "ics_needs_duration";
  /** #106 — called with the intent the Schedule menu produced, or with no args
   *  when the menu was skipped (no intent supplied, or the `menu` variant). */
  onScheduleSteps?: (intent?: ScheduleIntent) => void;
  onScheduleSingle?: (minutes: number) => void;
  /** ICS "Add to calendar" handler — called with the chosen minutes for a
   *  stepless task (ics_needs_duration) or with no args for a task with steps
   *  (ics_ready_steps). */
  onScheduleIcs?: (minutes?: number) => void;
  /** True while a schedule call for this row is in flight — disables the 📅
   * button/popover Go so a slow request can't be double-submitted. */
  pending?: boolean;
  /** "icon" = the 📅 button with its own anchored popover; since #253 deleted the
   * row's end cluster its only caller is `breakdown/task-schedule.tsx`, the task
   * working view's bordered pill. "menu" = a full-width text entry for a row's ▾
   * list, which is now the ONLY Schedule affordance on a row — the duration presets
   * expand inline (in normal flow) rather than in an anchored popover, so they
   * reflow the dropdown column instead of floating inside it. */
  variant?: "icon" | "menu";
  /** Menu-variant trigger text (voice-resolved by the caller). Defaults to "Schedule". */
  label?: string;
  /**
   * #106 — the intent the Schedule menu opens with, resolved by the caller
   * (persisted-or-default). Present → the `ready_steps` 📅 opens the menu;
   * `null`/absent → it keeps firing immediately, so the control is never dead
   * while data is in flight.
   */
  scheduleIntent?: ScheduleIntent | null;
  /** Names the menu's dialog, so the wrong row's popover is obvious to AT. */
  taskTitle?: string;
  /**
   * #128 — id of a "which Google account" hint the CALLER renders, for the
   * `connect`/`reconnect` link to point at with `aria-describedby`. Supplied by
   * the one surface that has to place the sentence outside this control's own
   * markup: `breakdown/task-schedule.tsx`, which wraps the pill.
   *
   * #253 — `icon`-variant only now. The `menu` variant no longer renders a connect
   * link at all (it navigates to the Integrations settings section), so it has
   * nothing to describe and supplies no hint of its own.
   */
  accountHintId?: string;
};

/**
 * The 📅 control. `ready_steps` opens the Schedule menu when the caller supplied
 * an intent (#106) and otherwise schedules immediately on click; `needs_duration`
 * opens an inline popover (15/30/60 presets + a custom number input) and fires
 * `onScheduleSingle` once a valid duration is chosen; out-of-range custom values
 * (0, negative, non-numeric, or >480) visibly disable Go and show a hint instead
 * of silently doing nothing. `connect`/`reconnect` render an OAuth link instead
 * of a button (nothing to click-handle client-side).
 *
 * #92: the icon variant's popover is a `Popover.Positioner` (see
 * ui/anchored-popup.ts) — it used to be `absolute right-0`, which clipped it
 * past the bottom edge on any row low on a phone screen. The `menu` variant is
 * untouched: it expands in normal flow inside the 🔽 popover, so there is no
 * floating element to position and nothing to collide with — and for the same
 * reason it keeps firing `onScheduleSteps()` immediately rather than opening the
 * #106 menu, which would nest a floating popup inside the 🔽 popup.
 */
export function ScheduleControl({
  state,
  onScheduleSteps,
  onScheduleSingle,
  onScheduleIcs,
  pending,
  variant = "icon",
  label = "Schedule",
  scheduleIntent,
  taskTitle,
  accountHintId,
}: ScheduleControlProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const rootRef = useRef<HTMLSpanElement>(null);
  /** The control that opens the duration presets — the `menu` variant's entry or
   *  the icon variant's 📅 — so `close()` can hand focus back to it (#253). */
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const isMenu = variant === "menu";
  const isIcs = state === "ics_ready_steps" || state === "ics_needs_duration";
  const needsDuration =
    state === "needs_duration" || state === "ics_needs_duration";

  // Closing always clears the custom-duration input so a stale value can't
  // reappear on reopen (Duo review). #23 — every close route calls this
  // instead of an effect watching `open` (react-hooks/set-state-in-effect),
  // which cost an extra render pass on each dismissal.
  //
  // #253 — and it hands focus back to this control's own trigger first. The
  // `menu` variant's presets collapse INSIDE a row's ▾ popover, so whichever
  // preset was pressed unmounts with focus on it, and that popover then claims
  // the loose focus for its own container — no control, place in the list lost
  // (WCAG 2.4.3). `restoreFocusToTrigger` carries the mechanism and why the
  // hand-off has to be synchronous.
  const close = useCallback(() => {
    restoreFocusToTrigger(triggerRef.current);
    setOpen(false);
    setCustom("");
  }, []);

  // Dismissal for the `menu` variant only. Its presets expand in normal flow
  // (no popup), so nothing else manages them; the icon variant's dismissal now
  // comes from Popover, which routes every close through `close()` below.
  useEffect(() => {
    if (!isMenu || !open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onPointerDown = (e: Event) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [isMenu, open, close]);

  if (state === "connect" || state === "reconnect") {
    // ── #253: the `menu` variant NAVIGATES, it no longer connects ─────────────
    //
    // A row's ▾ entry for an unusable Google path is a link to the Integrations
    // settings section, labelled with the destination and the reason it cannot
    // happen ("Schedule to calendar (not connected)"). It is one 44px entry and
    // nothing else. The owner's call, and the measurement behind it: rendering an
    // inline `Connect Google →` plus #128's three-line caveat made the
    // NOT-connected menu 497px tall against the connected one's 429px at 360px —
    // the taller list, on the surface this whole issue is about.
    //
    // ⚠️ Those are the heights of the shape this REPLACED. What ships measures 368px
    // in both states (7 entries, every one 44px and one line, plain and playful);
    // they differ in width only. See `strings.ts`'s note on the same pair, and
    // `e2e/smoke/row-menu-viewport-fit.spec.ts`, which now asserts it instead of
    // logging it.
    //
    // ⚠️ **This is what keeps #128 satisfied rather than violating it.** #128
    // requires the "prefer a personal account" caveat at every connect entry
    // point, because a Workspace admin can refuse the app at Google's own consent
    // step: Google shows its own page, the person never returns to our callback,
    // and there is nothing to catch, log or render afterwards. The guidance only
    // works BEFORE the click. A row entry that merely navigates is not that click,
    // so the caveat belongs at the controls that are — and all three still carry
    // it: `settings/integrations-panel.tsx` (gated on `connectHref`, so it appears
    // exactly when a connect control does), `breakdown/breakdown-chat.tsx`, and the
    // `icon` branch below, which is the task working view's pill.
    //
    // `reconnect` takes the same treatment, deliberately. Leave it as an inline
    // link and the row is STILL a connect control, so #128's caveat has to stay for
    // that one state — which is the tall menu returning in the state nobody
    // screenshotted.
    if (isMenu) {
      // `/settings#settings-integrations` — the section id from
      // `src/lib/section-nav.ts`, which is also the anchor the panel renders and
      // the one `nav/collapsible-section.tsx` already scroll-restores. The
      // repo's convention for deep-linking a settings section.
      //
      // ⚠️ #262 restructures this page and puts Google Tasks under Integrations →
      // Scheduling. This link is one more entry on that issue's anchor-migration
      // list: the id must be preserved or redirected, not silently renamed.
      return (
        <Link
          href="/settings#settings-integrations"
          className={rowMenuEntry("font-medium")}
        >
          {label}
        </Link>
      );
    }
    // ── The `icon` variant still connects inline, and still carries #128 ──────
    //
    // Its one caller is `breakdown/task-schedule.tsx`, a single bordered pill on
    // the task working view. `accountHintId` is how that surface renders the
    // sentence itself, outside this component's wrapper; with no id supplied the
    // guidance rides on `title`, which is still the link's accessible description
    // and matches the tooltip idiom the pill's neighbours use.
    return (
      <a
        href="/api/google/oauth/start"
        aria-describedby={accountHintId}
        // Never both: `aria-describedby` already wins as the accessible
        // description, and a tooltip repeating it is noise on hover.
        title={accountHintId ? undefined : GOOGLE_ACCOUNT_HINT}
        className={cn(
          "hover:bg-accent rounded-md px-2.5 py-1 font-medium",
          touchTarget,
        )}
      >
        {state === "reconnect" ? "Reconnect Google →" : "Connect Google →"}
      </a>
    );
  }

  const customMinutes = Number(custom);
  const customOutOfRange =
    custom !== "" &&
    (!Number.isFinite(customMinutes) ||
      customMinutes < 1 ||
      customMinutes > MAX_CUSTOM_MINUTES);

  const fireCustom = () => {
    if (custom === "" || customOutOfRange) return;
    close();
    if (isIcs) onScheduleIcs?.(customMinutes);
    else onScheduleSingle?.(customMinutes);
  };

  const iconLabel = isIcs ? "Add to calendar (.ics)" : "Schedule";

  // #169 — a disabled control has to say why it is disabled.
  //
  // `disabled` is still the right mechanism: it is the double-submit guard this
  // prop was written for, and it stops the press rather than merely discouraging
  // it. But a bare disabled button swallows a press with no error, no toast and
  // no explanation beyond a briefly grey control, and "I pressed Schedule and
  // nothing happened" was the whole of #169's user-visible harm.
  //
  // Saying why is only possible now that the reason is TRUE per row. `pending`
  // used to be one list-wide flag set by rename, complete, snooze and delete
  // (inbox-view.tsx), so the only honest sentence would have been "something,
  // somewhere in this list, is busy". It now means one thing, so the control
  // states it.
  //
  // Appended to the existing name rather than replacing it, for two reasons:
  // the visible/idle name stays a stable query target, and for the `menu`
  // variant — whose name comes from visible, voice-resolved text — an accessible
  // name that dropped the visible label would break WCAG 2.5.3 (Label in Name).
  const busyReason = "already in progress for this row";
  const iconBusyLabel = pending ? `${iconLabel} — ${busyReason}` : iconLabel;
  const menuBusyLabel = pending ? `${label} — ${busyReason}` : undefined;
  // A disabled element is skipped by most screen readers, so the reason has to
  // ride on the name itself; `aria-busy` is the machine-readable half.
  const busyProps = pending ? ({ "aria-busy": true } as const) : {};
  // #253 — the `menu` variant is now the ONLY Schedule affordance on a row (the
  // 📅 icon it used to mirror went with the end cluster), so it takes the shared
  // 44px `rowMenuEntry`. The `icon` variant keeps its own sizing for its one
  // remaining caller, `breakdown/task-schedule.tsx`.
  const triggerClassName = isMenu
    ? rowMenuEntry("font-medium disabled:opacity-50")
    : cn(
        // Ghost hover (matches Complete/▾) + a slightly bigger glyph than the
        // surrounding text-xs row (owner: mobile icons read too tiny) — the label
        // stays `font-medium` text-xs.
        "hover:bg-accent rounded-md px-2 py-1 text-sm font-medium disabled:opacity-50",
        touchTarget,
      );

  const durationFields = (
    <>
      <span className="flex gap-1">
        {DURATION_PRESETS.map((minutes) => (
          <button
            key={minutes}
            type="button"
            // `disabled` stays as defence in depth; the busy AFFORDANCE does
            // not, because it can never paint. Every path that raises `pending`
            // calls `close()` first in the same handler, and re-opening needs
            // the trigger, which is itself `disabled={pending}` — so this popup
            // is unmounted for the whole time `pending` is true. A `title` and
            // an `aria-busy` that no user or screen reader can reach are worse
            // than nothing: they read as tested a11y work. Removed after an
            // independent review of !278 flagged them as unreachable. The
            // TRIGGER keeps both, where they do paint.
            disabled={pending}
            className={cn(
              "hover:bg-accent rounded-md px-2.5 py-1 font-medium disabled:opacity-50",
              touchTarget,
            )}
            onClick={() => {
              close();
              if (isIcs) onScheduleIcs?.(minutes);
              else onScheduleSingle?.(minutes);
            }}
          >
            {minutes} min
          </button>
        ))}
      </span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          min={1}
          max={MAX_CUSTOM_MINUTES}
          step={1}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          // #183 sweep — `placeholder="min"` was standing in for a name, the
          // same defect as the brain-dump capture input. The enclosing popup is
          // already named "… — duration", so this only has to identify itself
          // within that; the placeholder stays as the compact visible hint.
          aria-label="Custom duration in minutes"
          className="w-16 rounded-md border px-2 py-1"
          placeholder="min"
        />
        <button
          type="button"
          // Three reasons this can be off, and only two are reachable: the
          // popup is unmounted whenever `pending` is true (see the presets
          // above), so the busy title and `aria-busy` were dead. Out-of-range
          // has its own visible message below and an empty box explains itself,
          // so neither needs a title either.
          disabled={pending || custom === "" || customOutOfRange}
          className={cn(
            "hover:bg-accent rounded-md px-2.5 py-1 font-medium disabled:opacity-50",
            touchTarget,
          )}
          onClick={fireCustom}
        >
          Go
        </button>
      </span>
      {customOutOfRange && (
        <span className="text-destructive">
          Enter 1–{MAX_CUSTOM_MINUTES} minutes
        </span>
      )}
    </>
  );

  // #106 — the Google steps path asks first: deadline, priority, work-or-personal.
  //
  // ⚠️ This branch is ABOVE the `isMenu` one, and #253 is why. It used to sit
  // below, so the `menu` variant never reached it: the note here said a floating
  // popup must not nest inside the 🔽 popup, and while the 📅 icon existed that
  // cost nothing, because the icon was the surface people actually used.
  //
  // #253 deletes the icon. Left as it was, "all three cluster actions already
  // exist as menu entries" would have been true of the LABEL and false of the
  // BEHAVIOUR — Schedule would have silently fallen back to pushing with the
  // server-resolved defaults, and #106 (choose a deadline, a priority, and
  // work-or-personal before the push) would have become unreachable from any inbox
  // row. That is a feature deleted by a layout change, which is the worst shape a
  // regression can take because nothing fails.
  //
  // The nesting concern turned out to be already solved rather than real, and the
  // evidence for that is `ScheduleMenu`'s own — `e2e/smoke/schedule-menu.spec.ts`,
  // where the dialog opens from a ▾ entry, reads correctly, closes on Escape, and
  // hands focus back to the entry that opened it ("the menu remembers the choice,
  // and the .ics path keeps its one click" asserts the settled focus).
  //
  // ⚠️ This used to cite `MoveToMenu` nesting "inside this same 🔽 popup" as the
  // precedent, quoting a test titled "the 🔽 popup's nested Move-to menu still
  // dispatches a move". Neither survives #253: the "Move to…" entry is gone from
  // every ▾, so `MoveToMenu` no longer nests in this popup at all — it renders as
  // the inline 📥 on the idle Saved row and the Done row — and the real test is
  // "the Move-to menu opened from a row's 📥 still dispatches a move", which now
  // exercises that composition instead. A precedent that has been deleted cannot
  // carry the argument, so the argument rests on the nesting that actually ships.
  //
  // The .ics path still keeps its one click. A guest with no Reclaim has nothing
  // to choose that the menu could offer beyond a deadline, and turning their
  // download into a two-step dialog would be a regression, not a feature. With no
  // intent yet (a row whose parent has not resolved one) the control also stays
  // immediate, so it is never dead while data is in flight.
  if (state === "ready_steps" && scheduleIntent) {
    return (
      <ScheduleMenu
        taskTitle={taskTitle ?? ""}
        intent={scheduleIntent}
        // Always true here: this branch is the Google path by construction, and
        // priority/hours are exactly the fields an .ics VEVENT cannot carry.
        showReclaimFields
        pending={pending}
        onSchedule={(chosen) => onScheduleSteps?.(chosen)}
        trigger={
          <button
            type="button"
            // The menu variant is named by its visible text, so an `aria-label` is
            // written only when `pending` appends the busy reason — same contract
            // as the plain menu trigger below (WCAG 2.5.3: a name that dropped the
            // visible label would break Label in Name).
            aria-label={isMenu ? menuBusyLabel : iconBusyLabel}
            title={isMenu ? menuBusyLabel : iconBusyLabel}
            disabled={pending}
            {...busyProps}
            className={triggerClassName}
          >
            {isMenu ? label : "📅"}
          </button>
        }
      />
    );
  }

  // ▾-dropdown variant: presets expand inline, in normal flow, so the column
  // reflows around them. Nothing floats, nothing can be clipped.
  if (isMenu) {
    return (
      <span ref={rootRef} className="flex flex-col">
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup={needsDuration ? "dialog" : undefined}
          aria-expanded={needsDuration ? open : undefined}
          disabled={pending}
          aria-label={menuBusyLabel}
          title={menuBusyLabel}
          {...busyProps}
          onClick={() => {
            if (state === "ready_steps") onScheduleSteps?.();
            else if (state === "ics_ready_steps") onScheduleIcs?.();
            else if (open) close();
            else setOpen(true); // needs_duration | ics_needs_duration
          }}
          className={triggerClassName}
        >
          {label}
        </button>
        {needsDuration && open && (
          // #253 — this expansion GROWS the ▾ popup, wider (the three presets
          // measure ~190px against the popup's 160px `min-w-40`, and
          // `popupSurface` is a flex column, so it sizes to its widest child) and
          // ~88px taller. Nothing here constrains that, deliberately: Base UI
          // re-runs its collision handling on a content resize
          // (`useAnchorPositioning` passes floating-ui `autoUpdate`
          // `elementResize: true`), so the popup shifts and flips to stay on
          // screen by itself.
          //
          // Measured rather than assumed. A `max-w-40` cap plus `flex-wrap` on the
          // presets was written first, on the theory that the growth escaped the
          // viewport; removing both and re-running "the expanded duration presets
          // fit the phone viewport" (e2e/smoke/row-menu-viewport-fit.spec.ts) still
          // passed, which says the reflow handles it and the constraint was
          // decoration wearing a bug fix's comment. What the exercise did find is
          // that the re-position lands a FRAME LATE, from a ResizeObserver
          // callback — so that spec polls its measurement instead of reading it
          // once, and any future check of this popup has to as well.
          <span className="mt-1 flex flex-col gap-2 px-2.5 pb-1 text-xs">
            {durationFields}
          </span>
        )}
      </span>
    );
  }

  // Icon variant, nothing to choose: 📅 acts immediately, no popup at all.
  if (!needsDuration) {
    return (
      <span ref={rootRef} className="relative">
        <button
          type="button"
          aria-label={iconBusyLabel}
          title={iconBusyLabel}
          disabled={pending}
          {...busyProps}
          onClick={() => {
            if (state === "ready_steps") onScheduleSteps?.();
            else onScheduleIcs?.(); // ics_ready_steps
          }}
          className={triggerClassName}
        >
          📅
        </button>
      </span>
    );
  }

  // Icon variant + a duration to pick: a viewport-aware popover (#92).
  return (
    <span ref={rootRef} className="relative">
      <Popover.Root
        open={open}
        // Every close route — Escape, outside press, re-pressing 📅, picking a
        // preset — funnels through `close()`, which clears the custom-duration
        // input so a stale value can't reappear on reopen (#23).
        onOpenChange={(nextOpen) => (nextOpen ? setOpen(true) : close())}
      >
        <Popover.Trigger
          ref={triggerRef}
          aria-label={iconBusyLabel}
          title={iconBusyLabel}
          disabled={pending}
          {...busyProps}
          className={triggerClassName}
        >
          📅
        </Popover.Trigger>
        <Popover.Portal container={rootRef} render={<span />}>
          <Popover.Positioner {...ANCHORED_POSITIONER} render={<span />}>
            <Popover.Popup
              render={<span />}
              // Names the dialog for screen readers and for axe's
              // aria-dialog-name rule — there is no visible heading to point
              // `aria-labelledby` at.
              aria-label={`${iconLabel} — duration`}
              className={popupSurface("min-w-48 gap-2 p-2 text-xs")}
            >
              {durationFields}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </span>
  );
}

/**
 * The action line shared by every task row (v7): visible `inline` actions in
 * order, then the ▾ trigger pinned right, which opens a dismissable (Escape /
 * outside-click) list of the row's remaining options — `menu`, rendered
 * verbatim, caller-ordered. This is a plain dismissable popover, not an ARIA
 * menu — no `role="menu"` anywhere here, since `menu` entries are ordinary
 * buttons/links, not menuitems with roving-focus semantics.
 *
 * ── #253: v6's trailing icon cluster is gone ────────────────────────────────
 *
 * v5/v6 rendered 📥 move / 📅 schedule / 🗑 delete in a `flex-nowrap` group after
 * the inline actions, from `move` / `schedule` / `del` props. All three were
 * duplicates of entries the ▾ list already carried, and the group's own comment
 * recorded that it wraps onto a band of its own on a narrow row — which is a
 * third line of controls on every card, buying nothing the menu did not already
 * offer. On the owner's 360px screenshot one Needs-review row occupied roughly
 * seven stacked bands and this was two of them (the wrapped inline text plus the
 * icons).
 *
 * The three props are **removed**, not left accepting a value that renders
 * nothing. `schedule` was the cautionary case: it only ever rendered through
 * `{schedule && <ScheduleControl {...schedule} />}` inside that group, and #213
 * had already been written as "pass `schedule=` on library rows" — a fix
 * describing a prop with no render path. A silently-inert prop is worse than a
 * compile error, because it reads as wired.
 *
 * `ScheduleControl` is unaffected and still exported. Its `menu` variant is what
 * every row's ▾ list uses, and its `icon` variant still has a caller —
 * `breakdown/task-schedule.tsx`, the task working view's bordered pill.
 *
 * The nowrap group is not kept as a one-child wrapper. It existed to stop the
 * cluster splitting mid-way and stranding this trigger with a mis-anchored
 * popover (owner: mobile screenshot); one control cannot split.
 */
export function RowActions({
  inline,
  menu,
  scheduled = false,
  className,
}: {
  inline: ReactNode[];
  menu: ReactNode[];
  /** Renders a "Scheduled ✓" indicator when the row's task has a scheduledAt
   *  marker (any method). */
  scheduled?: boolean;
  /** Extra classes on the action line's root — inbox buckets pass a left inset
   * (`pl-9`) so the action row lines up under the title text, past the drag-grip
   * gutter, instead of sitting flush at the card edge. */
  className?: string;
}) {
  const menuRef = useRef<HTMLSpanElement>(null);

  return (
    <div
      // A stable hook for asserting WHICH controls belong to the action group.
      // #44 put the note trigger in here beside Complete (owner request), and
      // "is it in the action row or on its own line below" is otherwise only
      // checkable by walking anonymous divs, which rots on any wrapper change.
      data-row-actions=""
      className={cn(
        "mt-2 flex flex-wrap items-center gap-2 text-xs",
        className,
      )}
    >
      {scheduled && (
        <span
          className="text-emerald-700 dark:text-emerald-400 font-medium"
          title="Scheduled"
        >
          Scheduled ✓
        </span>
      )}
      {inline}
      {/* #92 — a Popover, not `absolute right-0`: this popup used to hang past
          the bottom edge from any row low on a phone screen. It was ~288px when
          #92 measured it; #253's canonical list makes the tallest case 368px
          (7 entries at 44px plus separators), which is what
          `e2e/smoke/row-menu-viewport-fit.spec.ts` measures now. Still
          NOT an ARIA menu (see the doc comment above): Popover.Popup is a
          `dialog`, and `menu` entries stay ordinary buttons/links. Portaled
          into `menuRef` rather than <body> so a press on a nested control
          (the Schedule dialog) is still a press inside this popup, and so
          row-scoped queries keep meaning "this row's options". That was
          written for the "Move to…" entry, which #253 removed; the Schedule
          dialog is the nested control it now protects.

          #253 — `ml-auto shrink-0` moved here from the deleted cluster span, so
          the trigger is still pinned right of the wrapped inline actions and
          still keeps its full ≥44px target rather than being squeezed.
          `data-row-menu` is a stable structural hook for the popup's markup, the
          same contract `data-row-actions` carries on the line: the tests used to
          find this group by its `.flex-nowrap` class, which is a styling
          decision and rots on any layout change. */}
      <span
        ref={menuRef}
        data-row-menu=""
        className="relative ml-auto shrink-0"
      >
        <Popover.Root>
          <Popover.Trigger
            aria-label="All options"
            className={cn(
              "hover:bg-accent rounded-md px-2 py-1 text-sm font-medium",
              touchTarget,
            )}
          >
            🔽
          </Popover.Trigger>
          <Popover.Portal container={menuRef} render={<span />}>
            <Popover.Positioner {...ANCHORED_POSITIONER} render={<span />}>
              <Popover.Popup
                render={<span />}
                // The dialog's accessible name (axe aria-dialog-name).
                aria-label="All options"
                className={popupSurface("min-w-40 gap-1 p-1")}
              >
                {menu}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </span>
    </div>
  );
}
