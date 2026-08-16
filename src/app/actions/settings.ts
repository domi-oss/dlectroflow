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

/**
 * The freshness thresholds, in whole hours — the ONE unit (#261).
 *
 * `agingThresholdMinutes` and `demoOverrideSeconds` used to arrive here too. The
 * first was a second, minutes-denominated answer to the question `agingHours`
 * already answers; the second rescaled all four boundaries into seconds for a
 * stage demo that has now happened. Both columns are gone, so a stale bundle
 * that still posts them has its extra keys dropped by the explicit read below
 * rather than reaching Prisma, where an unknown key is a validation error.
 *
 * Each value is clamped to a whole number ≥ 1 hour. Not range-checked against
 * each other: a workspace is allowed to put `agingHours` above `overdueHours`
 * and gets the tier `freshnessTier` finds first, which is what this page has
 * always done.
 */
export async function updateAgingSettings(input: {
  agingHours: number;
  overdueHours: number;
  wayOverdueHours: number;
}) {
  const workspaceId = await currentWorkspaceId();
  const clampHours = (value: number) =>
    Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
  const data = {
    agingHours: clampHours(input.agingHours),
    overdueHours: clampHours(input.overdueHours),
    wayOverdueHours: clampHours(input.wayOverdueHours),
  };

  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, ...data },
    update: data,
  });
  revalidatePath("/");
}

/** Feature 3/9 — end-of-day round-up delivery settings. */
export async function updateRoundupSettings(input: {
  workdayEndTime: string; // HH:mm
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

/**
 * #199 — shopping-list mode's on/off switch. Off by default.
 *
 * Workspace-scoped, no owner gate — the same shape as every other taste setting
 * on this page (`updateFirstRunPreview`, `updateFocusShuffle`), and a guest
 * sandbox gets its own value. A plain Boolean column, so `Boolean()` is the only
 * validation it needs; the value arrives from a client-callable action, so it is
 * coerced rather than trusted.
 *
 * **It writes only this column.** Turning the switch off HIDES the list, it does
 * not delete it: the rows outlive the toggle, so a switch pressed by accident is
 * not destructive and turning it back on restores the list intact. Same reasoning
 * #180 gives for leaving `focusShuffle` and the playlist selection inert rather
 * than resetting them.
 *
 * `revalidatePath("/", "layout")` as well as `/settings`, and that second
 * argument is load-bearing: the menu entry is rendered by
 * `src/app/(app)/layout.tsx`, so invalidating the settings page alone would tick
 * the checkbox and leave the menu advertising the previous state until the next
 * full navigation. The layout-scoped invalidation is what makes the switch visible
 * where it acts.
 */
export async function updateShoppingList(enabled: boolean) {
  const workspaceId = await currentWorkspaceId();
  const shoppingList = Boolean(enabled);
  await prisma.settings.upsert({
    where: { workspaceId },
    create: { id: workspaceId, workspaceId, shoppingList },
    update: { shoppingList },
  });
  revalidatePath("/settings");
  revalidatePath("/", "layout");
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
  /** #252 — Settings.focusQuickAccess, the header's focus shortcut. */
  quickAccess?: boolean;
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
    // #252 — spread for the same reason, and NOT coerced like `pauseTogether`
    // above. The difference between the two is the column default and nothing
    // else: `focusPauseTogether` defaults false, so an omission lands on the
    // value a fresh row would have had, while `focusQuickAccess` defaults TRUE,
    // so coercing an omission would silently move a workspace off the default —
    // which is exactly what a browser still holding the previous deploy's bundle
    // would do to somebody who only changed their timer style.
    ...(input.quickAccess === undefined
      ? {}
      : { focusQuickAccess: Boolean(input.quickAccess) }),
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
