"use server";

import { revalidatePath } from "next/cache";
import { getSettings } from "@/lib/db";
import {
  generateTodayRollup,
  markRollupEmailed,
  claimRollupEmail,
  releaseRollupEmailClaim,
  type Rollup,
} from "@/lib/rollup";
import {
  emailConfigured,
  roundupEmailHtml,
  sendRoundupEmail,
} from "@/lib/email";
import { currentWorkspaceId } from "@/lib/workspace";
import { isGuestWorkspace } from "@/lib/workspace-kind";

export type TriggerResult = {
  rollup: Rollup;
  email:
    { attempted: false } | { attempted: true; ok: boolean; reason?: string };
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
  const workspaceId = await currentWorkspaceId();
  const force = opts?.force ?? true; // manual trigger regenerates by default
  const rollup = await generateTodayRollup(workspaceId, force);

  const settings = await getSettings(workspaceId);
  // Send-site guard, independent of the settings action: guest workspaces
  // never email, even if their Settings row predates the owner-only rule (#20).
  const wantsEmail =
    !(await isGuestWorkspace(workspaceId)) &&
    settings.roundupEmailEnabled &&
    (opts?.sendEmail ?? true);

  // Build + send the email; shared by the manual and auto paths so the
  // recipient and content stay identical.
  const deliver = () =>
    sendRoundupEmail(
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

  let email: TriggerResult["email"] = { attempted: false };
  if (wantsEmail) {
    if (!emailConfigured()) {
      email = { attempted: true, ok: false, reason: "disabled" };
    } else if (force) {
      // Manual "Trigger now" demo override: always (re)send, bypassing the
      // once-per-day guard so the button can be re-demoed on stage.
      const result = await deliver();
      if (result.ok) await markRollupEmailed(workspaceId, rollup.date);
      email = {
        attempted: true,
        ok: result.ok,
        reason: result.ok ? undefined : result.reason,
      };
    } else {
      // Auto/client-triggered path: atomically claim the once-per-day send so
      // two overlapping triggers can't both email the owner (#18). Only the
      // caller that wins the claim sends; the rest skip silently. If the send
      // fails, release the claim so a later trigger can retry.
      const claimed = await claimRollupEmail(workspaceId, rollup.date);
      if (!claimed) {
        // Already sent (or being sent) today by a concurrent trigger.
        email = { attempted: false };
      } else {
        // Release the claim on ANY failure — a returned { ok: false } OR a
        // thrown/rejected send (network error, unhandled Resend rejection).
        // Otherwise the day stays stamped as emailed and every future
        // auto-trigger skips forever, never retrying.
        let result;
        try {
          result = await deliver();
        } catch (err) {
          await releaseRollupEmailClaim(workspaceId, rollup.date);
          throw err;
        }
        if (!result.ok) await releaseRollupEmailClaim(workspaceId, rollup.date);
        email = {
          attempted: true,
          ok: result.ok,
          reason: result.ok ? undefined : result.reason,
        };
      }
    }
  }

  revalidatePath("/dashboard");
  return { rollup, email };
}
