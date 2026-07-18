"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { pushStepsToGoogleTasks } from "@/app/actions/google-schedule";
import { scheduleViaIcs } from "@/app/actions/ics-schedule";
import { downloadIcs } from "@/lib/download-ics";
import { ScheduleControl, type ScheduleControlProps } from "@/components/inbox/row-actions";
import { scheduleState, SCHEDULE_ERROR_MESSAGES } from "@/components/inbox/inbox-view";
import { useVoice } from "@/components/voice-provider";
import { t, type Voice } from "@/lib/strings";

type GoogleStatus = { configured: boolean; connected: boolean; needsReconnect: boolean };

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
  scheduledAt,
  google,
  voice: voiceProp,
}: {
  taskId: string;
  scheduledAt: Date | null;
  /** Owner + Google connection status; null for guests — mirrors
   *  inbox/page.tsx's `google = owner ? googleStatus : null` (guests always
   *  get the ICS control, never a live Google one). */
  google: GoogleStatus | null;
  voice?: Voice;
}) {
  const contextVoice = useVoice();
  const voice = voiceProp ?? contextVoice;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Mirrors inbox-view's per-row reconnect handling: a reconnect_required
  // response swaps this control to the Reconnect link instead of leaving a
  // red error next to a control that would just fail again.
  const [reconnectRequired, setReconnectRequired] = useState(false);

  const effectiveGoogle: GoogleStatus | null = google
    ? { ...google, needsReconnect: google.needsReconnect || reconnectRequired }
    : null;

  const schedule: ScheduleControlProps = effectiveGoogle
    ? {
        state: scheduleState(effectiveGoogle, "ready_steps"),
        onScheduleSteps: () => {
          setError(null);
          startTransition(async () => {
            const res = await pushStepsToGoogleTasks(taskId);
            if (res.ok) {
              router.refresh();
              return;
            }
            if (res.reason === "reconnect_required") {
              setReconnectRequired(true);
              return;
            }
            setError(res.message ?? SCHEDULE_ERROR_MESSAGES[res.reason] ?? "Scheduling failed.");
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
            setError(res.message ?? "Couldn't build the calendar file.");
          });
        },
        pending,
      };

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span
        className={scheduledAt != null ? "font-medium text-emerald-600" : "text-muted-foreground"}
        title={scheduledAt != null ? "Scheduled" : undefined}
      >
        {t(scheduledAt != null ? "task.scheduled" : "task.notScheduled", voice)}
      </span>
      <ScheduleControl {...schedule} />
      {error && <span className="text-destructive text-xs">{error}</span>}
    </div>
  );
}
