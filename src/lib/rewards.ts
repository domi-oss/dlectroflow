import { prisma } from "@/lib/db";
import {
  RewardType,
  RewardPoints,
  BadgeKey,
  BrainDumpStatus,
  type RewardType as RewardTypeT,
  type BadgeKey as BadgeKeyT,
} from "@/lib/constants";
import { getSettings, getStreak } from "@/lib/db";

// ── helpers ────────────────────────────────────────────────────────────────
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function isoWeekday(d: Date): number {
  const wd = d.getDay(); // 0=Sun..6=Sat
  return wd === 0 ? 7 : wd; // 1=Mon..7=Sun
}
function parseWorkingDays(csv: string): number[] {
  return csv
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => n >= 1 && n <= 7);
}

// ── points ───────────────────────────────────────────────────────────────
export async function logReward(workspaceId: string, type: RewardTypeT, points?: number) {
  await prisma.rewardEvent.create({
    data: { type, points: points ?? RewardPoints[type], workspaceId },
  });
}

/** Award inbox-zero once/day when the needs-triage queue just hit empty. */
export async function maybeAwardInboxZero(workspaceId: string) {
  const now = new Date();
  const remaining = await prisma.brainDumpItem.count({
    where: {
      workspaceId,
      status: BrainDumpStatus.Inbox,
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    },
  });
  if (remaining > 0) return;
  const already = await prisma.rewardEvent.count({
    where: { workspaceId, type: RewardType.InboxZero, createdAt: { gte: startOfToday() } },
  });
  if (already > 0) return;
  await logReward(workspaceId, RewardType.InboxZero);
}

// ── badges ─────────────────────────────────────────────────────────────────
/** Award a badge once. Returns true if it was newly earned. */
export async function awardBadge(workspaceId: string, key: BadgeKeyT): Promise<boolean> {
  const existing = await prisma.badge.findUnique({
    where: { workspaceId_key: { workspaceId, key } },
  });
  if (existing) return false;
  await prisma.badge.create({ data: { key, workspaceId } });
  return true;
}

/** Award ten-steps-in-a-day once StepDone count for today reaches 10. */
export async function maybeAwardTenStepsDay(workspaceId: string): Promise<void> {
  const stepsToday = await prisma.rewardEvent.count({
    where: { workspaceId, type: RewardType.StepDone, createdAt: { gte: startOfToday() } },
  });
  if (stepsToday >= 10) await awardBadge(workspaceId, BadgeKey.TenStepsDay);
}

/**
 * Shared "a step got done" reward path — used by finishing a focus session AND
 * by completing a step directly. Logs StepDone, extends the streak, and awards
 * the ten-steps-in-a-day badge. Does NOT log SessionFinished (that is the focus
 * timer's own bonus).
 */
export async function rewardStepDone(workspaceId: string): Promise<StreakUpdate | null> {
  await logReward(workspaceId, RewardType.StepDone);
  const streak = await touchStreakOnCompletion(workspaceId);
  await maybeAwardTenStepsDay(workspaceId);
  return streak;
}

// ── streak ───────────────────────────────────────────────────────────────
export type StreakUpdate = {
  current: number;
  freshStart: boolean; // restarted after a reset
  continued: boolean; // extended an existing streak
};

/**
 * Record a completion toward the working-day streak. Consecutive *working days*
 * with ≥1 completion; non-working days are skipped (don't break it). Missing a
 * working day resets to 1 and files the ended streak into the Top-3 records.
 */
export async function touchStreakOnCompletion(workspaceId: string): Promise<StreakUpdate | null> {
  const settings = await getSettings(workspaceId);
  const workingDays = parseWorkingDays(settings.workingDays);
  const now = new Date();
  if (!workingDays.includes(isoWeekday(now))) return null; // non-working day: skip

  const streak = await getStreak(workspaceId);
  const today = ymd(now);
  if (streak.lastActiveWorkday === today) {
    return { current: streak.current, freshStart: false, continued: false };
  }

  // Most recent working day strictly before today.
  const prev = new Date(now);
  let prevWorkingDay: string | null = null;
  for (let i = 0; i < 14; i++) {
    prev.setDate(prev.getDate() - 1);
    if (workingDays.includes(isoWeekday(prev))) {
      prevWorkingDay = ymd(prev);
      break;
    }
  }

  const continues =
    streak.current > 0 && streak.lastActiveWorkday === prevWorkingDay;

  let current: number;
  let freshStart = false;
  if (continues) {
    current = streak.current + 1;
  } else {
    // reset — file the ended streak (if any) into Top-3 records
    if (streak.current > 0) {
      await prisma.streakRecord.create({
        data: {
          length: streak.current,
          startedAt: now,
          endedAt: now,
          workspaceId,
        },
      });
    }
    current = 1;
    freshStart = streak.current > 0; // only "fresh start" if there was a prior streak
  }

  await prisma.streak.update({
    where: { workspaceId },
    data: { current, lastActiveWorkday: today },
  });

  // streak badges
  if (current >= 5) await awardBadge(workspaceId, BadgeKey.Streak5);
  const best = await prisma.streakRecord.aggregate({
    _max: { length: true },
    where: { workspaceId },
  });
  if ((best._max.length ?? 0) > 0 && current > (best._max.length ?? 0)) {
    await awardBadge(workspaceId, BadgeKey.BeatBestStreak);
  }

  return { current, freshStart, continued: continues };
}

// ── dashboard aggregation ──────────────────────────────────────────────────
export type DashboardData = {
  todayPoints: number;
  totalPoints: number;
  currentStreak: number;
  topStreaks: { length: number; endedAt: Date }[];
  focusMinToday: number;
  sessionsToday: number;
  stepsDoneToday: number;
  badges: string[];
};

export async function getDashboardData(workspaceId: string): Promise<DashboardData> {
  const start = startOfToday();
  const [
    todayAgg,
    totalAgg,
    streak,
    topStreaks,
    todaySessions,
    stepsDoneToday,
    badges,
  ] = await Promise.all([
    prisma.rewardEvent.aggregate({
      _sum: { points: true },
      where: { workspaceId, createdAt: { gte: start } },
    }),
    prisma.rewardEvent.aggregate({
      _sum: { points: true },
      where: { workspaceId },
    }),
    getStreak(workspaceId),
    prisma.streakRecord.findMany({
      where: { workspaceId },
      orderBy: { length: "desc" },
      take: 3,
    }),
    prisma.focusSession.findMany({
      where: { workspaceId, startedAt: { gte: start }, endedAt: { not: null } },
      select: { durationMin: true },
    }),
    prisma.rewardEvent.count({
      where: { workspaceId, type: RewardType.StepDone, createdAt: { gte: start } },
    }),
    prisma.badge.findMany({
      where: { workspaceId },
      orderBy: { earnedAt: "asc" },
    }),
  ]);

  return {
    todayPoints: todayAgg._sum.points ?? 0,
    totalPoints: totalAgg._sum.points ?? 0,
    currentStreak: streak.current,
    topStreaks: topStreaks.map((r) => ({ length: r.length, endedAt: r.endedAt })),
    focusMinToday: todaySessions.reduce((n, s) => n + (s.durationMin ?? 0), 0),
    sessionsToday: todaySessions.length,
    stepsDoneToday,
    badges: badges.map((b) => b.key),
  };
}
