import { prisma } from "@/lib/db";
import {
  RewardType,
  RewardPoints,
  BadgeKey,
  BrainDumpStatus,
  SINGLETON_ID,
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
export async function logReward(type: RewardTypeT, points?: number) {
  await prisma.rewardEvent.create({
    data: { type, points: points ?? RewardPoints[type] },
  });
}

/** Award inbox-zero once/day when the needs-triage queue just hit empty. */
export async function maybeAwardInboxZero() {
  const now = new Date();
  const remaining = await prisma.brainDumpItem.count({
    where: {
      status: BrainDumpStatus.Inbox,
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    },
  });
  if (remaining > 0) return;
  const already = await prisma.rewardEvent.count({
    where: { type: RewardType.InboxZero, createdAt: { gte: startOfToday() } },
  });
  if (already > 0) return;
  await logReward(RewardType.InboxZero);
}

// ── badges ─────────────────────────────────────────────────────────────────
/** Award a badge once. Returns true if it was newly earned. */
export async function awardBadge(key: BadgeKeyT): Promise<boolean> {
  const existing = await prisma.badge.findUnique({ where: { key } });
  if (existing) return false;
  await prisma.badge.create({ data: { key } });
  return true;
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
export async function touchStreakOnCompletion(): Promise<StreakUpdate | null> {
  const settings = await getSettings();
  const workingDays = parseWorkingDays(settings.workingDays);
  const now = new Date();
  if (!workingDays.includes(isoWeekday(now))) return null; // non-working day: skip

  const streak = await getStreak();
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
        },
      });
    }
    current = 1;
    freshStart = streak.current > 0; // only "fresh start" if there was a prior streak
  }

  await prisma.streak.update({
    where: { id: SINGLETON_ID },
    data: { current, lastActiveWorkday: today },
  });

  // streak badges
  if (current >= 5) await awardBadge(BadgeKey.Streak5);
  const best = await prisma.streakRecord.aggregate({ _max: { length: true } });
  if ((best._max.length ?? 0) > 0 && current > (best._max.length ?? 0)) {
    await awardBadge(BadgeKey.BeatBestStreak);
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

export async function getDashboardData(): Promise<DashboardData> {
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
      where: { createdAt: { gte: start } },
    }),
    prisma.rewardEvent.aggregate({ _sum: { points: true } }),
    getStreak(),
    prisma.streakRecord.findMany({ orderBy: { length: "desc" }, take: 3 }),
    prisma.focusSession.findMany({
      where: { startedAt: { gte: start }, endedAt: { not: null } },
      select: { durationMin: true },
    }),
    prisma.rewardEvent.count({
      where: { type: RewardType.StepDone, createdAt: { gte: start } },
    }),
    prisma.badge.findMany({ orderBy: { earnedAt: "asc" } }),
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
