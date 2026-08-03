"use client";

import { useVoice } from "@/components/voice-provider";
import { t, type Voice } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { STATUS_BANNER_TONE } from "@/lib/status-banner-style";

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
        // #109 — the tone table, not a local copy. The comment that used to sit
        // here claimed "-700 is AA on the light tint": measured, green-700 on
        // this banner's own tint is 4.16:1 and amber-700 is 4.42:1, both under
        // 4.5:1. The claim came from measuring the token against the bare
        // --background instead of against the composite the banner actually
        // paints. status-banner-style.ts carries the corrected numbers.
        scheduled ? STATUS_BANNER_TONE.ok : STATUS_BANNER_TONE.warn,
      )}
    >
      {t(scheduled ? "banner.scheduled" : "banner.notScheduled", voice)}
    </div>
  );
}
