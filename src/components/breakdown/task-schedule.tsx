"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { pushStepsToGoogleTasks } from "@/app/actions/google-schedule";
import { scheduleViaIcs } from "@/app/actions/ics-schedule";
import { downloadIcs } from "@/lib/download-ics";
import {
  ScheduleControl,
  type ScheduleControlProps,
} from "@/components/inbox/row-actions";
import {
  scheduleState,
  SCHEDULE_ERROR_MESSAGES,
} from "@/components/inbox/inbox-view";
import { GoogleAccountHint } from "@/components/integrations/google-account-hint";
import { leadSchedulingMethod } from "@/lib/scheduling/providers";
import type { GoogleConnStatus, ScheduleIntent } from "@/lib/scheduling/types";
import { t, type Voice } from "@/lib/strings";

/**
 * The task working-view's own Schedule control (#8 follow-up to !83) — split
 * out of the old merged "Refine breakdown / schedule" footer link, which only
 * ever navigated to the breakdown editor and never actually scheduled
 * anything.
 *
 * Reuses the Inbox's `<ScheduleControl>` + its owner/guest wiring VERBATIM
 * (`scheduleState` + `SCHEDULE_ERROR_MESSAGES`, both exported from
 * inbox-view.tsx) instead of reinventing the scheduling flow: an owner with
 * Google connected pushes the task's steps to Google Tasks (Reclaim then
 * auto-schedules them); a guest, or an owner who hasn't finished connecting
 * Google, downloads an .ics instead. This page's working view only ever
 * renders once the task HAS steps, so `ready_steps` / `ics_ready_steps` are
 * the only reachable "go" states here — `connect`/`reconnect` still surface
 * for an owner who's mid-setup.
 */
export function TaskSchedule({
  taskId,
  taskTitle,
  scheduledAt,
  scheduleIntent = null,
  google,
  voice,
}: {
  taskId: string;
  /** Names the #106 Schedule menu's dialog. */
  taskTitle: string;
  scheduledAt: Date | null;
  /** #106 — persisted-or-default intent, resolved on the server by the page so
   *  the menu opens prefilled with no client round trip. Null for a guest (or
   *  any caller with nothing to prefill), which keeps 📅 immediate. */
  scheduleIntent?: ScheduleIntent | null;
  /** Owner + Google connection status; null for guests — mirrors
   *  inbox/page.tsx's `google = owner ? googleStatus : null` (guests always
   *  get the ICS control, never a live Google one). */
  google: GoogleConnStatus | null;
  // Required — the sole caller (tasks/[taskId]/page.tsx) always resolves and
  // passes this from settings, so a useVoice() context fallback here was dead.
  voice: Voice;
}) {
  const router = useRouter();
  // #128 — this view renders ONE schedule control, so unlike an inbox row it
  // can afford the visible "which Google account" hint. It has to own the
  // element, though: <ScheduleControl> is wrapped in the bordered pill below,
  // and a sentence rendered inside that wrapper would be drawn as part of the
  // button. So the hint sits outside the pill and the control is handed its id.
  const accountHintId = useId();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Mirrors inbox-view's per-row reconnect handling: a reconnect_required
  // response swaps this control to the Reconnect link instead of leaving a
  // red error next to a control that would just fail again.
  const [reconnectRequired, setReconnectRequired] = useState(false);

  const effectiveGoogle: GoogleConnStatus | null = google
    ? { ...google, needsReconnect: google.needsReconnect || reconnectRequired }
    : null;

  // Route the primary-vs-ICS choice through the seam (S1, #34): owners lead with
  // the Google control, guests get ICS. `&& effectiveGoogle` only narrows the
  // type — it is always non-null when the seam picks googleTasks.
  const schedule: ScheduleControlProps =
    leadSchedulingMethod(effectiveGoogle) === "googleTasks" && effectiveGoogle
      ? {
          state: scheduleState(effectiveGoogle, "ready_steps"),
          taskTitle,
          scheduleIntent,
          onScheduleSteps: (intent?: ScheduleIntent) => {
            setError(null);
            startTransition(async () => {
              const res = await pushStepsToGoogleTasks(taskId, intent);
              if (res.ok) {
                router.refresh();
                return;
              }
              if (res.reason === "reconnect_required") {
                setReconnectRequired(true);
                return;
              }
              setError(
                res.message ??
                  SCHEDULE_ERROR_MESSAGES[res.reason] ??
                  "Scheduling failed.",
              );
            });
          },
          pending,
        }
      : {
          state: "ics_ready_steps",
          onScheduleIcs: () => {
            setError(null);
            startTransition(async () => {
              const res = await scheduleViaIcs(taskId);
              if (res.ok) {
                downloadIcs(res.ics, res.icsFilename);
                router.refresh();
                return;
              }
              setError(
                res.message ??
                  SCHEDULE_ERROR_MESSAGES[res.reason] ??
                  "Couldn't build the calendar file.",
              );
            });
          },
          pending,
        };

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span
        className={
          scheduledAt != null
            ? "font-medium text-emerald-600"
            : "text-muted-foreground"
        }
        title={scheduledAt != null ? "Scheduled" : undefined}
      >
        {t(scheduledAt != null ? "task.scheduled" : "task.notScheduled", voice)}
      </span>
      {/* Outer-trigger wrap (!83 owner tweak): <ScheduleControl> is shared
          verbatim with every Inbox row and takes no `className`, so the
          bordered "Select"-button look is applied to a wrapping span here
          instead of editing the shared component's own button classes —
          doing that there would also restyle every Inbox row's 📅 / Connect /
          Reconnect control. No padding on the wrapper: the inner button
          already carries "px-2.5 py-1", so adding it here would double it. */}
      <span className="hover:bg-accent rounded-md border text-sm">
        <ScheduleControl {...schedule} accountHintId={accountHintId} />
      </span>
      {error && <span className="text-destructive text-xs">{error}</span>}
      {/* Rendered only while there is an account left to pick — including when
          a mid-flight `reconnect_required` swaps the control to a link, since
          `schedule.state` is recomputed from `effectiveGoogle`. `basis-full`
          gives it its own line in this flex-wrap row rather than squeezing the
          control. */}
      {(schedule.state === "connect" || schedule.state === "reconnect") && (
        <GoogleAccountHint id={accountHintId} className="basis-full text-xs" />
      )}
    </div>
  );
}
