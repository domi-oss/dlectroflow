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
export async function logReward(
  workspaceId: string,
  type: RewardTypeT,
  points?: number,
) {
  await prisma.rewardEvent.create({
    data: { type, points: points ?? RewardPoints[type], workspaceId },
  });
}

/**
 * When the needs-triage queue just hit empty: award the once-ever Inbox-zero
 * badge (idempotent) and the once/day Inbox-zero points.
 */
export async function maybeAwardInboxZero(workspaceId: string) {
  const now = new Date();
  const remaining = await prisma.brainDumpItem.count({
    where: {
      workspaceId,
      status: BrainDumpStatus.Inbox,
      completedAt: null,
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    },
  });
  if (remaining > 0) return;
  // Inbox-zero badge — once ever, awarded the first time the queue empties.
  await awardBadge(workspaceId, BadgeKey.InboxZero);
  // Inbox-zero points — once/day.
  const already = await prisma.rewardEvent.count({
    where: {
      workspaceId,
      type: RewardType.InboxZero,
      createdAt: { gte: startOfToday() },
    },
  });
  if (already > 0) return;
  await logReward(workspaceId, RewardType.InboxZero);
}

// ── badges ─────────────────────────────────────────────────────────────────
/**
 * Award a badge once. Returns true if it was newly earned, false if it was
 * already held.
 *
 * The findUnique→create pair is a TOCTOU by design: two concurrent awards can
 * both pass the existence check and both write. That used to be handled by
 * catching the resulting P2002, which was correct and still printed — Prisma's
 * client logger fires before our `catch` ever sees the error (#158, and see the
 * note on `log` in src/lib/db.ts). `createMany` + `skipDuplicates` compiles to
 * `INSERT ... ON CONFLICT DO NOTHING`, so the loser inserts nothing and is told
 * so by `count`, rather than raising.
 *
 * `createMany` rather than `!240`'s `createManyAndReturn`: the caller wants the
 * boolean, never the row, so there is nothing to RETURNING. And `count` carries
 * exactly the fact the old `catch` was reconstructing — 1 means this call
 * earned it, 0 means somebody already had.
 *
 * The leading read stays. Most calls are for a badge already held
 * (`maybeAwardTenStepsDay` fires on every step completion past the tenth), and
 * an indexed SELECT is cheaper than a speculative insert that has to be rolled
 * back on conflict.
 */
export async function awardBadge(
  workspaceId: string,
  key: BadgeKeyT,
): Promise<boolean> {
  const existing = await prisma.badge.findUnique({
    where: { workspaceId_key: { workspaceId, key } },
  });
  if (existing) return false;
  const { count } = await prisma.badge.createMany({
    data: { key, workspaceId },
    skipDuplicates: true,
  });
  return count > 0; // 0 = a concurrent award won the race; the badge exists
}

/** Award ten-steps-in-a-day once StepDone count for today reaches 10. */
export async function maybeAwardTenStepsDay(
  workspaceId: string,
): Promise<void> {
  const stepsToday = await prisma.rewardEvent.count({
    where: {
      workspaceId,
      type: RewardType.StepDone,
      createdAt: { gte: startOfToday() },
    },
  });
  if (stepsToday >= 10) await awardBadge(workspaceId, BadgeKey.TenStepsDay);
}

/**
 * Shared "a step got done" reward path — used by finishing a focus session AND
 * by completing a step directly. Logs StepDone, extends the streak, and awards
 * the ten-steps-in-a-day badge. Does NOT log SessionFinished (that is the focus
 * timer's own bonus).
 */
export async function rewardStepDone(
  workspaceId: string,
): Promise<StreakUpdate | null> {
  await logReward(workspaceId, RewardType.StepDone);
  const streak = await touchStreakOnEngagement(workspaceId); // completion is a qualifying engagement
  await maybeAwardTenStepsDay(workspaceId);
  return streak;
}

/**
 * Take back the points a step completion awarded, because that completion is
 * being undone (#198).
 *
 * ── What gets reversed, and the rule behind it ──────────────────────────────
 *
 * A reward is reversed when **the same work could otherwise be paid for twice**.
 * It is kept when the reward records something that genuinely happened and does
 * not un-happen. Applying that rule to the four types this app awards:
 *
 *  * **`step_done` — reversed.** Awarded once per completion of a step, and a
 *    step can be completed, undone and completed again with no new work in
 *    between. Duplicable, so it comes back.
 *  * **`task_complete` — reversed, but only when this undo actually reopens a
 *    task that was closed.** `markTaskCompleted` logs it whenever a step closes
 *    its task, and nothing stops it running again when that step is re-completed
 *    (`awardBadge` is idempotent; `logReward` is not). Same farm as `step_done`,
 *    one level up — found in review round 3. The gate is real state (the task WAS
 *    `Done` and is now Active), never an inference.
 *  * **`session_finished` — NOT reversed, deliberately.** It pays for *having
 *    focused for a stretch of time*, not for the step being finished, and that
 *    time was really spent. This is the same argument that keeps the streak
 *    below, and it has to be the same or the two are incoherent. It is also not
 *    farmable: re-completing through the timer requires pressing Start, which
 *    calls `beginFocus` and opens a **new** `FocusSession`, so a second
 *    `session_finished` is paid for by a second real session.
 *
 *    Review round 2 flagged the missing reversal and round 3 showed the fix was
 *    the wrong remedy: it inferred "this completion came from a session" from
 *    whether *any* completed `FocusSession` existed for the step, and those rows
 *    are never cleared — so after one timer completion, every later undo claimed
 *    a session and deleted the newest `session_finished` in the workspace, which
 *    could belong to unrelated, legitimately finished work. The inference is gone
 *    rather than made cleverer, because there was nothing correct for it to infer
 *    from.
 *  * **Badges — not reversed.** Once-ever achievements; revoking one would make
 *    the collection lie about the past, and `awardBadge` is idempotent anyway.
 *
 * ── Why "the newest row of that type" is enough ─────────────────────────────
 *
 * Each reversal removes the most recent row of its type, not "the one this step
 * earned", because there is no such thing: `RewardEvent` carries type, points and
 * workspace and holds no step or task reference (see `prisma/schema.prisma`), so
 * every row of one type in a workspace is an identical `RewardPoints[type]`.
 * **Within a type, which row goes is unobservable** — the points total, the
 * dashboard and the day rollup all read the same afterwards, and nothing displays
 * per-step or per-task points. Attributing rewards to their source would need a
 * nullable column and a migration, which is not worth buying an identical
 * outcome.
 *
 * That argument holds **within** a type and **not across** types, which is
 * exactly where round 2's fix went wrong: deleting a `session_finished` to
 * compensate for a `step_done` is not a relabelling, it is taking points from
 * different work. Every gate here is therefore a fact about state, not a guess
 * about provenance.
 *
 * Returns what was actually removed, so callers can be tested on it and so
 * "nothing to reverse" is a normal answer rather than an error.
 */
export async function reverseStepCompletionRewards(
  workspaceId: string,
  opts: { includeTaskComplete: boolean },
): Promise<{ stepDone: boolean; taskComplete: boolean }> {
  const stepDone = await reverseLatestReward(workspaceId, RewardType.StepDone);
  const taskComplete = opts.includeTaskComplete
    ? await reverseLatestReward(workspaceId, RewardType.TaskComplete)
    : false;
  return { stepDone, taskComplete };
}

/** Remove the newest reward of one type in one workspace. See above for why "newest". */
async function reverseLatestReward(
  workspaceId: string,
  type: RewardTypeT,
): Promise<boolean> {
  const latest = await prisma.rewardEvent.findFirst({
    where: { workspaceId, type },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!latest) return false;
  // Safe to delete by id alone: the id came from a workspace-scoped read above,
  // so this cannot reach another workspace's row (the scoping invariant).
  await prisma.rewardEvent.delete({ where: { id: latest.id } });
  return true;
}

// ── streak ───────────────────────────────────────────────────────────────
export type StreakUpdate = {
  current: number;
  freshStart: boolean; // restarted after a reset
  continued: boolean; // extended an existing streak
};

/**
 * Record a qualifying engagement toward the working-day streak. Any qualifying
 * action counts (Decision 1): a capture, a breakdown-confirm, or a step/task
 * completion. Consecutive *working days* with ≥1 engagement; non-working days
 * are skipped (don't break it). Missing a working day resets to 1 and files the
 * ended streak into the Top-3 records. Advances at most once per working day —
 * the leading `SELECT … FOR UPDATE` serialises same-day callers.
 */
export async function touchStreakOnEngagement(
  workspaceId: string,
): Promise<StreakUpdate | null> {
  const settings = await getSettings(workspaceId);
  const workingDays = parseWorkingDays(settings.workingDays);
  const now = new Date();
  if (!workingDays.includes(isoWeekday(now))) return null; // non-working day: skip

  const today = ymd(now);

  // Most recent working day strictly before today (pure — no DB access).
  const prev = new Date(now);
  let prevWorkingDay: string | null = null;
  for (let i = 0; i < 14; i++) {
    prev.setDate(prev.getDate() - 1);
    if (workingDays.includes(isoWeekday(prev))) {
      prevWorkingDay = ymd(prev);
      break;
    }
  }

  // Ensure the Streak row exists (race-safe) before we lock it in the txn.
  await getStreak(workspaceId);

  // Read-decide-write in one interactive transaction. The leading
  // `SELECT … FOR UPDATE` serialises concurrent first-completions-of-the-day
  // for this workspace: a second caller blocks until the first commits, then
  // re-reads `lastActiveWorkday === today` and early-returns. So the streak
  // advances at most once and at most one StreakRecord is filed on a reset,
  // instead of the previous read→compute→write TOCTOU that could double both.
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Streak" WHERE "workspaceId" = ${workspaceId} FOR UPDATE`;
    const streak = await tx.streak.findUnique({ where: { workspaceId } });
    if (!streak) {
      // Ensured above; treat an unexpectedly-missing row as a safe no-op.
      return {
        current: 0,
        freshStart: false,
        continued: false,
        changed: false,
      };
    }

    if (streak.lastActiveWorkday === today) {
      return {
        current: streak.current,
        freshStart: false,
        continued: false,
        changed: false,
      };
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
        await tx.streakRecord.create({
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

    await tx.streak.update({
      where: { workspaceId },
      data: { current, lastActiveWorkday: today },
    });

    return { current, freshStart, continued: continues, changed: true };
  });

  // Streak badges — only when the streak actually moved (matches the prior
  // early-return for same-day repeats). awardBadge tolerates a concurrent
  // award without raising (#158).
  const { changed, ...update } = result;
  if (changed) {
    // Comeback — restarted after a gap (a prior streak had ended). No-shame.
    if (update.freshStart) await awardBadge(workspaceId, BadgeKey.Comeback);
    // Full work week — a 5-working-day streak.
    if (update.current >= 5) await awardBadge(workspaceId, BadgeKey.Streak5);
    const best = await prisma.streakRecord.aggregate({
      _max: { length: true },
      where: { workspaceId },
    });
    if (
      (best._max.length ?? 0) > 0 &&
      update.current > (best._max.length ?? 0)
    ) {
      await awardBadge(workspaceId, BadgeKey.BeatBestStreak);
    }
  }

  return update;
}

/**
 * @deprecated A step/task completion is one kind of qualifying engagement.
 * Retained as a thin alias so the completion call sites and existing tests keep
 * working; prefer {@link touchStreakOnEngagement} for new call sites.
 */
export function touchStreakOnCompletion(
  workspaceId: string,
): Promise<StreakUpdate | null> {
  return touchStreakOnEngagement(workspaceId);
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

export async function getDashboardData(
  workspaceId: string,
): Promise<DashboardData> {
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
      where: {
        workspaceId,
        type: RewardType.StepDone,
        createdAt: { gte: start },
      },
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
    topStreaks: topStreaks.map((r) => ({
      length: r.length,
      endedAt: r.endedAt,
    })),
    focusMinToday: todaySessions.reduce((n, s) => n + (s.durationMin ?? 0), 0),
    sessionsToday: todaySessions.length,
    stepsDoneToday,
    badges: badges.map((b) => b.key),
  };
}
