"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { currentWorkspaceId, isOwnerRequest } from "@/lib/workspace";
import { OWNER_BREAKDOWN_ALLOWLIST, isGuestWorkspace } from "@/lib/constants";
import { isValidHHmm } from "@/lib/daily-review-nudge";

export async function updateAgingSettings(input: {
  agingThresholdMinutes: number;
  demoOverrideSeconds: number | null;
  agingHours: number;
  overdueHours: number;
  wayOverdueHours: number;
}) {
  const workspaceId = await currentWorkspaceId();
  const agingThresholdMinutes = Math.max(
    1,
    Math.round(input.agingThresholdMinutes || 1),
  );
  const demoOverrideSeconds =
    input.demoOverrideSeconds != null && input.demoOverrideSeconds > 0
      ? Math.round(input.demoOverrideSeconds)
      : null;
  const clampHours = (value: number) =>
    Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
  const agingHours = clampHours(input.agingHours);
  const overdueHours = clampHours(input.overdueHours);
  const wayOverdueHours = clampHours(input.wayOverdueHours);

  await prisma.settings.upsert({
    where: { workspaceId },
    create: {
      id: workspaceId,
      workspaceId,
      agingThresholdMinutes,
      demoOverrideSeconds,
      agingHours,
      overdueHours,
      wayOverdueHours,
    },
    update: {
      agingThresholdMinutes,
      demoOverrideSeconds,
      agingHours,
      overdueHours,
      wayOverdueHours,
    },
  });
  revalidatePath("/inbox");
}

/** Feature 3/9 — end-of-day round-up delivery settings. */
export async function updateRoundupSettings(input: {
  workdayEndTime: string; // HH:mm
  roundupDemoOverride: boolean;
  roundupEmailEnabled: boolean;
  roundupEmail: string | null;
}) {
  const workspaceId = await currentWorkspaceId();
  const workdayEndTime = /^\d{2}:\d{2}$/.test(input.workdayEndTime)
    ? input.workdayEndTime
    : "17:00";
  // Outbound email is owner-only: a guest sandbox may tune the demo knobs but
  // must never aim Resend at an arbitrary address (#20).
  const isGuest = isGuestWorkspace(workspaceId);
  const roundupEmail = isGuest ? null : input.roundupEmail?.trim() || null;
  const data = {
    workdayEndTime,
    roundupDemoOverride: Boolean(input.roundupDemoOverride),
    roundupEmailEnabled: isGuest ? false : Boolean(input.roundupEmailEnabled),
    roundupEmail,
  };
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, ...data },
    update: data,
  });
  revalidatePath("/dashboard");
}

/**
 * Phase 6 — per-type notification preferences. Workspace-scoped (guests keep
 * their own values; no email involved, so no owner gate). Client-delivered
 * only: these flags gate browser notifications at delivery time. The nudge time
 * is validated to HH:mm and falls back to 17:00 when malformed.
 */
export async function updateNotificationSettings(input: {
  notifyRoundup: boolean;
  notifyAging: boolean;
  notifyDailyReview: boolean;
  dailyReviewNudgeTime: string; // HH:mm
}) {
  const workspaceId = await currentWorkspaceId();
  const dailyReviewNudgeTime = isValidHHmm(input.dailyReviewNudgeTime)
    ? input.dailyReviewNudgeTime
    : "17:00";
  const data = {
    notifyRoundup: Boolean(input.notifyRoundup),
    notifyAging: Boolean(input.notifyAging),
    notifyDailyReview: Boolean(input.notifyDailyReview),
    dailyReviewNudgeTime,
  };
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, ...data },
    update: data,
  });
  revalidatePath("/settings");
  revalidatePath("/dashboard");
  revalidatePath("/inbox");
}

/** Voice preference — workspace-scoped; validates to {"plain","playful"} only. */
export async function updateVoice(voice: string) {
  if (voice !== "plain" && voice !== "playful") return; // no-op on invalid values
  const workspaceId = await currentWorkspaceId();
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, voice },
    update: { voice },
  });
  revalidatePath("/", "layout");
}

/** Phase 2 — owner picks their breakdown model (allowlist-validated, owner-only). */
export async function updateBreakdownModel(model: string) {
  if (!(await isOwnerRequest())) return; // guests can't set a model
  if (!(OWNER_BREAKDOWN_ALLOWLIST as readonly string[]).includes(model)) return;
  const workspaceId = await currentWorkspaceId();
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, breakdownModel: model },
    update: { breakdownModel: model },
  });
  revalidatePath("/inbox");
}

/** Phase 5 — persist that the workspace dismissed the first-run welcome card. */
export async function dismissWelcome() {
  const workspaceId = await currentWorkspaceId();
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, welcomeDismissedAt: new Date() },
    update: { welcomeDismissedAt: new Date() },
  });
  revalidatePath("/inbox");
}

/** Phase 5 — Demo: First-run preview toggle (auto-saved). Forces the Inbox to
 * render as a brand-new user sees it (welcome + empty), non-destructively. */
export async function updateFirstRunPreview(enabled: boolean) {
  const workspaceId = await currentWorkspaceId();
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, firstRunPreview: Boolean(enabled) },
    update: { firstRunPreview: Boolean(enabled) },
  });
  revalidatePath("/inbox");
}
