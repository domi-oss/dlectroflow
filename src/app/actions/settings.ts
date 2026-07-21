"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { currentWorkspaceId, isOwnerRequest } from "@/lib/workspace";
import {
  OWNER_BREAKDOWN_ALLOWLIST,
  isGuestWorkspace,
  FocusTimerStyle,
  FocusSound,
  CompleteTickColor,
} from "@/lib/constants";
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

/**
 * MR ② — Focus timer preferences. Workspace-scoped personalisation (guests keep
 * their own values; no owner gate). timerStyle + sound are allowlist-validated
 * against FocusTimerStyle / FocusSound so a bad value can never reach the DB
 * (mirrors the Settings_focusTimerStyle_check / Settings_focusSound_check
 * constraints); an unknown style falls back to null (→ resolve by voice) and an
 * unknown sound falls back to "off". The timer route is force-dynamic (reads
 * settings fresh on load); we revalidate /settings so the section re-seeds.
 */
export async function updateFocusTimerSettings(input: {
  timerStyle: string | null;
  minimalMode: boolean;
  keepAwake: boolean;
  alarmEnabled: boolean;
  sound: string;
}) {
  const workspaceId = await currentWorkspaceId();
  const styles = Object.values(FocusTimerStyle) as string[];
  const focusTimerStyle =
    input.timerStyle && styles.includes(input.timerStyle)
      ? input.timerStyle
      : null;
  const sounds = Object.values(FocusSound) as string[];
  const focusSound = sounds.includes(input.sound)
    ? input.sound
    : FocusSound.Off;
  const data = {
    focusTimerStyle,
    focusMinimalMode: Boolean(input.minimalMode),
    focusKeepAwake: Boolean(input.keepAwake),
    focusAlarmEnabled: Boolean(input.alarmEnabled),
    focusSound,
  };
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, ...data },
    update: data,
  });
  revalidatePath("/settings");
}

/** MR ② — record that the workspace dismissed the one-time "make this timer
 * yours" hint (via ✕ or by tapping through to settings). One-shot flag; the
 * force-dynamic timer route won't show it again on the next load. */
export async function dismissFocusTimerTip() {
  const workspaceId = await currentWorkspaceId();
  const now = new Date();
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, focusTimerTipDismissedAt: now },
    update: { focusTimerTipDismissedAt: now },
  });
}

/**
 * MR ③ — app-wide completion style (Appearance). Workspace-scoped personalisation
 * (guests keep their own values; no owner gate). completeTickColor is
 * allowlist-validated against CompleteTickColor — anything else falls back to
 * green, matching the Settings_completeTickColor_check CHECK constraint so a
 * bad value can never reach the DB. Revalidates the whole layout because the
 * completion treatment is applied app-wide in (app)/layout.tsx (like voice).
 */
export async function updateAppearanceSettings(input: {
  completeStrikethrough: boolean;
  completeTickColor: string;
}) {
  const workspaceId = await currentWorkspaceId();
  const completeTickColor = (
    Object.values(CompleteTickColor) as string[]
  ).includes(input.completeTickColor)
    ? input.completeTickColor
    : CompleteTickColor.Green;
  const data = {
    completeStrikethrough: Boolean(input.completeStrikethrough),
    completeTickColor,
  };
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, ...data },
    update: data,
  });
  revalidatePath("/", "layout");
}
