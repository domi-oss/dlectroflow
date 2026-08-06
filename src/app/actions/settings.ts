"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { currentWorkspaceId, isOwnerRequest } from "@/lib/workspace";
import {
  OWNER_BREAKDOWN_ALLOWLIST,
  FocusTimerStyle,
  FocusSound,
  FocusSoundCategory,
  CompleteTickColor,
  Typeface,
} from "@/lib/constants";
import { isGuestWorkspace } from "@/lib/workspace-kind";
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
  revalidatePath("/");
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
  const isGuest = await isGuestWorkspace(workspaceId);
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
  revalidatePath("/");
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
  revalidatePath("/");
}

/** Phase 5 — persist that the workspace dismissed the first-run welcome card. */
export async function dismissWelcome() {
  const workspaceId = await currentWorkspaceId();
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, welcomeDismissedAt: new Date() },
    update: { welcomeDismissedAt: new Date() },
  });
  revalidatePath("/");
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
  revalidatePath("/");
}

/**
 * MR ② — Focus timer preferences. Workspace-scoped personalisation (guests keep
 * their own values; no owner gate). timerStyle + sound are allowlist-validated
 * against FocusTimerStyle / FocusSound so a bad value can never reach the DB
 * (mirrors the Settings_focusTimerStyle_check / Settings_focusSound_check
 * constraints); an unknown style falls back to null (→ resolve by voice) and an
 * unknown sound falls back to "off". The timer route is force-dynamic (reads
 * settings fresh on load); we revalidate /settings so the section re-seeds.
 *
 * #65 — pauseTogether (the opt-in music→timer pause coupling) is OPTIONAL here:
 * a caller that predates it, or one that only means to change the style, must
 * never silently switch a workspace's focus session over to "the music can stop
 * my timer". Omitted ⇒ false, same as the column default.
 *
 * #180 — `sound` is now a two-value switch, and `categories`
 * (Settings.focusSoundCategories) is the playlist selection. Three decisions
 * here, all of them reversals of what #70 did, because the two facts stopped
 * being one radio group:
 *
 *  * **Omitted ⇒ the column is not written at all**, rather than cleared. The
 *    Settings page sends only the switch now — the playlist is chosen from the
 *    player (#181) — so treating "not mentioned" as "empty it" would wipe a
 *    selection every time somebody toggled sound off and on again.
 *  * **`sound: "off"` no longer clears the selection.** They were mutually
 *    exclusive options in one group and are now two independent controls on two
 *    surfaces; keeping the playlist through a silent spell is what makes the
 *    switch reversible. This makes it behave like focusShuffle and
 *    focusPauseTogether, which are also left inert rather than reset.
 *  * **Out-of-set slugs are dropped rather than rejected**, so a retired category
 *    shrinks the selection instead of failing the whole write — and the survivors
 *    are stored in catalogue order with duplicates removed, so one selection has
 *    exactly one stored spelling. Nothing out-of-set can reach
 *    Settings_focusSoundCategories_check.
 */
/**
 * #180 — the stored form of a category selection: known slugs only, no
 * duplicates, in catalogue order.
 *
 * Canonicalising the ORDER is what stops two rows that mean the same thing from
 * looking different — the pool is a filter over the catalogue, so order carries
 * no meaning and preserving the caller's would only make equality checks and
 * diffs lie. `FocusSoundCategory`'s declaration order is the catalogue's, which
 * is why it is read from there rather than sorted alphabetically.
 */
function normaliseFocusCategories(input: readonly string[]): string[] {
  const chosen = new Set(input);
  return (Object.values(FocusSoundCategory) as string[]).filter((slug) =>
    chosen.has(slug),
  );
}

export async function updateFocusTimerSettings(input: {
  timerStyle: string | null;
  minimalMode: boolean;
  keepAwake: boolean;
  alarmEnabled: boolean;
  sound: string;
  categories?: readonly string[];
  pauseTogether?: boolean;
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
    focusPauseTogether: Boolean(input.pauseTogether),
    // Spread, not a null: an absent key leaves the stored selection alone, which
    // is the difference between "the switch moved" and "the playlist changed".
    ...(input.categories === undefined
      ? {}
      : { focusSoundCategories: normaliseFocusCategories(input.categories) }),
  };
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, ...data },
    update: data,
  });
  revalidatePath("/settings");
}

/**
 * #68 — the mini-player's shuffle toggle. Workspace-scoped taste setting (guests
 * keep their own value; no owner gate, same as the other focus-timer prefs) and
 * a plain Boolean column, so the only validation needed is the coercion below.
 * Called fire-and-forget from the timer: the toggle's own state lives in
 * useFocusSound for the rest of the session, and the force-dynamic focus route
 * re-reads Settings on the next load — so there is nothing to revalidate here.
 */
export async function updateFocusShuffle(enabled: boolean) {
  const workspaceId = await currentWorkspaceId();
  const focusShuffle = Boolean(enabled);
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, focusShuffle },
    update: { focusShuffle },
  });
}

/**
 * #181 — the playlist tick-list in the in-session player.
 *
 * A dedicated action rather than a `categories`-only call to
 * `updateFocusTimerSettings`, and the difference is a lost update rather than
 * tidiness: that action writes five other focus preferences on every call, so
 * the player would be posting the timer style, minimal mode, keep-awake, the
 * alarm and the sound switch as they were when the page loaded — reverting
 * anything changed on the Settings page in another tab since. `updateFocusShuffle`
 * (#68) is the precedent: a player-side control owns exactly its own column.
 *
 * Same normalisation as `updateFocusTimerSettings`, through the same helper, so
 * one selection has exactly one stored spelling whichever surface wrote it — and
 * nothing outside `FocusSoundCategory` can reach
 * `Settings_focusSoundCategories_check`. A non-array (a caller that predates the
 * player, a malformed action payload) is the empty selection, which is the
 * column's own way of saying "the whole catalogue"; the column is NOT NULL, so
 * there is no other value it could take.
 *
 * Nothing is revalidated, for `updateFocusShuffle`'s reason: the tick-list's own
 * state lives in the timer for the rest of the session, and the focus route is
 * force-dynamic, so it re-reads Settings on the next load. The Settings page does
 * not render the selection at all since #180.
 */
export async function updateFocusSoundCategories(
  categories: readonly string[],
) {
  const workspaceId = await currentWorkspaceId();
  const focusSoundCategories = normaliseFocusCategories(
    Array.isArray(categories) ? categories : [],
  );
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, focusSoundCategories },
    update: { focusSoundCategories },
  });
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
 * MR ③ / #40 — app-wide Appearance prefs. Workspace-scoped personalisation
 * (guests keep their own values; no owner gate). completeTickColor and typeface
 * are both allowlist-validated against CompleteTickColor / Typeface — anything
 * else falls back to green / figtree respectively, matching the
 * Settings_completeTickColor_check / Settings_typeface_check CHECK constraints so
 * a bad value can never reach the DB. typeface is optional here (an omitted
 * value defaults to figtree). Revalidates the whole layout because both
 * treatments are applied app-wide in (app)/layout.tsx (like voice).
 */
export async function updateAppearanceSettings(input: {
  completeStrikethrough: boolean;
  completeTickColor: string;
  typeface?: string;
}) {
  const workspaceId = await currentWorkspaceId();
  const completeTickColor = (
    Object.values(CompleteTickColor) as string[]
  ).includes(input.completeTickColor)
    ? input.completeTickColor
    : CompleteTickColor.Green;
  const typeface = (Object.values(Typeface) as string[]).includes(
    input.typeface ?? "",
  )
    ? (input.typeface as string)
    : Typeface.Figtree;
  const data = {
    completeStrikethrough: Boolean(input.completeStrikethrough),
    completeTickColor,
    typeface,
  };
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, ...data },
    update: data,
  });
  revalidatePath("/", "layout");
}
