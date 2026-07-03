"use server";

import { revalidatePath } from "next/cache";
import { getSettings } from "@/lib/db";
import {
  generateTodayRollup,
  markRollupEmailed,
  type Rollup,
} from "@/lib/rollup";
import {
  emailConfigured,
  roundupEmailHtml,
  sendRoundupEmail,
} from "@/lib/email";

export type TriggerResult = {
  rollup: Rollup;
  email:
    | { attempted: false }
    | { attempted: true; ok: boolean; reason?: string };
};

/**
 * "Trigger now" demo override + the delivery path the workday-end timer calls.
 * Regenerates today's warm recap and, when the user has opted in AND Resend is
 * configured, emails it (once/day unless forced by the manual button).
 */
export async function triggerRollup(opts?: {
  force?: boolean;
  sendEmail?: boolean;
}): Promise<TriggerResult> {
  const force = opts?.force ?? true; // manual trigger regenerates by default
  const rollup = await generateTodayRollup(force);

  const settings = await getSettings();
  const wantsEmail = settings.roundupEmailEnabled && (opts?.sendEmail ?? true);

  let email: TriggerResult["email"] = { attempted: false };
  if (wantsEmail) {
    if (!emailConfigured()) {
      email = { attempted: true, ok: false, reason: "disabled" };
    } else if (!force && rollup.emailedAt) {
      // auto-path already sent today
      email = { attempted: false };
    } else {
      const result = await sendRoundupEmail(
        settings.roundupEmail,
        "🌇 Your dlectroflow day, wrapped",
        roundupEmailHtml({
          narrative: rollup.narrative,
          stepsDone: rollup.stepsDone,
          focusMin: rollup.focusMin,
          sessions: rollup.sessions,
          points: rollup.points,
          streakDay: rollup.streakDay,
          spark: rollup.spark,
        }),
      );
      if (result.ok) await markRollupEmailed(rollup.date);
      email = { attempted: true, ok: result.ok, reason: result.ok ? undefined : result.reason };
    }
  }

  revalidatePath("/dashboard");
  return { rollup, email };
}
