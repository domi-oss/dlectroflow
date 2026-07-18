"use client";

import { useVoice } from "@/components/voice-provider";
import { t, type Voice } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * Ground-truth scheduling banner for a confirmed breakdown.
 *
 * `scheduled` MUST come from persisted state (`task.scheduledAt != null`), not
 * optimistic UI — so reopening a "Sorted" task always shows its true state:
 * green "Scheduled" when a calendar actually received the steps, amber "Not
 * scheduled yet" otherwise. The banner never assumes success (wireframe:
 * Breakdown / confirmed + confirmed-unscheduled substates).
 */
export function ScheduleStatusBanner({
  scheduled,
  voice: voiceProp,
}: {
  scheduled: boolean;
  /** Optional explicit voice; falls back to the VoiceProvider context. */
  voice?: Voice;
}) {
  const contextVoice = useVoice();
  const voice = voiceProp ?? contextVoice;
  return (
    <div
      role="status"
      className={cn(
        "rounded-lg border p-3 text-sm font-medium",
        scheduled
          ? "border-green-600/30 bg-green-600/10 text-green-700"
          : "border-amber-500/30 bg-amber-500/10 text-amber-700",
      )}
    >
      {t(scheduled ? "banner.scheduled" : "banner.notScheduled", voice)}
    </div>
  );
}
