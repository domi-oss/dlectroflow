import { prisma } from "@/lib/db";
import { getStreak } from "@/lib/db";
import { getAnthropic, BREAKDOWN_MODEL } from "@/lib/anthropic";
import { FocusOutcome, TaskStatus } from "@/lib/constants";
import { getTodaySpark } from "@/lib/spark";

// ── date helpers (server-local day, matching rewards.ts) ────────────────────
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

// ── the day's data ──────────────────────────────────────────────────────────
export type DayData = {
  date: string;
  stepsDone: number;
  focusMin: number;
  sessions: number;
  points: number;
  streakDay: number;
  completedStepTexts: string[]; // what got finished, for narrative colour
  carryOverTexts: string[]; // still-open steps to carry gently into tomorrow
};

export async function gatherDayData(): Promise<DayData> {
  const start = startOfToday();
  const [doneSessions, allTodaySessions, pointsAgg, streak, carryOver] =
    await Promise.all([
      prisma.focusSession.findMany({
        where: {
          outcome: FocusOutcome.Completed,
          endedAt: { gte: start },
        },
        include: { step: { include: { task: true } } },
        orderBy: { endedAt: "asc" },
      }),
      prisma.focusSession.findMany({
        where: { startedAt: { gte: start }, endedAt: { not: null } },
        select: { durationMin: true },
      }),
      prisma.rewardEvent.aggregate({
        _sum: { points: true },
        where: { createdAt: { gte: start } },
      }),
      getStreak(),
      prisma.step.findMany({
        where: { done: false, task: { status: TaskStatus.Active } },
        include: { task: true },
        orderBy: [{ taskId: "asc" }, { order: "asc" }],
        take: 12,
      }),
    ]);

  const completedStepTexts = doneSessions
    .map((s) => (s.step ? s.step.text : null))
    .filter((t): t is string => Boolean(t));

  // De-dupe carry-over to at most one step per open task, keep it short.
  const seenTasks = new Set<string>();
  const carryOverTexts: string[] = [];
  for (const step of carryOver) {
    if (seenTasks.has(step.taskId)) continue;
    seenTasks.add(step.taskId);
    carryOverTexts.push(step.text);
    if (carryOverTexts.length >= 3) break;
  }

  return {
    date: ymd(new Date()),
    stepsDone: completedStepTexts.length,
    focusMin: allTodaySessions.reduce((n, s) => n + (s.durationMin ?? 0), 0),
    sessions: allTodaySessions.length,
    points: pointsAgg._sum.points ?? 0,
    streakDay: streak.current,
    completedStepTexts,
    carryOverTexts,
  };
}

// ── narrative ────────────────────────────────────────────────────────────────
function fallbackNarrative(d: DayData): string {
  if (d.stepsDone === 0 && d.focusMin === 0) {
    return "Some days are for gathering, not finishing — and that's completely okay. Nothing here is a scoreboard against you. Whatever pulled at your attention today, you showed up to look at it, and tomorrow gets a fresh, clean start whenever you're ready.";
  }
  const wins: string[] = [];
  if (d.stepsDone > 0)
    wins.push(`you finished ${d.stepsDone} step${d.stepsDone === 1 ? "" : "s"}`);
  if (d.focusMin > 0)
    wins.push(
      `you held focus for ${d.focusMin} minute${d.focusMin === 1 ? "" : "s"} across ${d.sessions} session${d.sessions === 1 ? "" : "s"}`,
    );
  const winLine = wins.length
    ? `Here's what actually happened today: ${wins.join(", and ")}. That's real, and it counts.`
    : "You put time in today, and that counts.";
  const streakLine =
    d.streakDay > 0
      ? ` You're on a ${d.streakDay}-day streak — momentum is on your side.`
      : "";
  const carryLine = d.carryOverTexts.length
    ? ` A few things are still waiting — like "${d.carryOverTexts[0]}" — but they'll keep. No guilt; just tomorrow's starting points.`
    : " Nothing urgent is hanging over you. Rest easy.";
  return `${winLine}${streakLine}${carryLine}`;
}

async function generateNarrative(d: DayData): Promise<string> {
  try {
    const anthropic = getAnthropic();
    const resp = await anthropic.messages.create({
      model: BREAKDOWN_MODEL,
      max_tokens: 400,
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: `Write a warm, personal end-of-day recap for someone with ADHD. Rules:
- Lead with the WINS first, always. Be genuinely encouraging, never cheesy or corny.
- Guilt-free about anything unfinished — reframe carry-over as tomorrow's starting points, not failures.
- 2 short paragraphs max, ~90 words total. Second person ("you"). No emoji, no headings, no bullet points, no quotation marks around the whole thing.

Today's data:
- Steps completed: ${d.stepsDone}${d.completedStepTexts.length ? ` (${d.completedStepTexts.slice(0, 5).map((t) => `"${t}"`).join(", ")})` : ""}
- Focus time: ${d.focusMin} minutes over ${d.sessions} session(s)
- Points earned: ${d.points}
- Current working-day streak: ${d.streakDay}
- Still open (carry into tomorrow): ${d.carryOverTexts.length ? d.carryOverTexts.map((t) => `"${t}"`).join(", ") : "nothing pressing"}

If the day was quiet (little done), be especially kind — no pressure, tomorrow is a clean slate.`,
        },
      ],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    if (text) return text;
  } catch {
    // fall through to the local fallback
  }
  return fallbackNarrative(d);
}

// ── rollup persistence ───────────────────────────────────────────────────────
export type Rollup = {
  date: string;
  stepsDone: number;
  focusMin: number;
  sessions: number;
  points: number;
  streakDay: number;
  narrative: string;
  spark: string;
  emailedAt: Date | null;
};

/** Read today's stored rollup, if one has been generated. */
export async function getTodayRollup(): Promise<Rollup | null> {
  const date = ymd(new Date());
  const row = await prisma.dayRollup.findUnique({ where: { date } });
  if (!row || !row.narrative) return null;
  const spark = await getTodaySpark();
  return {
    date: row.date,
    stepsDone: row.stepsDone,
    focusMin: row.focusMin,
    sessions: row.sessions,
    points: row.pointsEarned,
    streakDay: row.streakDay,
    narrative: row.narrative,
    spark: spark.quote,
    emailedAt: row.emailedAt,
  };
}

/**
 * Build (or, when `force`, regenerate) today's round-up: snapshot the day's
 * stats, ask Claude for a warm recap, and persist it to DayRollup. Returns the
 * full rollup for immediate display.
 */
export async function generateTodayRollup(force = false): Promise<Rollup> {
  const data = await gatherDayData();
  const existing = await prisma.dayRollup.findUnique({
    where: { date: data.date },
  });

  const narrative =
    !force && existing?.narrative
      ? existing.narrative
      : await generateNarrative(data);

  const row = await prisma.dayRollup.upsert({
    where: { date: data.date },
    create: {
      date: data.date,
      focusMin: data.focusMin,
      sessions: data.sessions,
      stepsDone: data.stepsDone,
      pointsEarned: data.points,
      streakDay: data.streakDay,
      narrative,
    },
    update: {
      focusMin: data.focusMin,
      sessions: data.sessions,
      stepsDone: data.stepsDone,
      pointsEarned: data.points,
      streakDay: data.streakDay,
      narrative,
    },
  });

  const spark = await getTodaySpark();
  return {
    date: row.date,
    stepsDone: row.stepsDone,
    focusMin: row.focusMin,
    sessions: row.sessions,
    points: row.pointsEarned,
    streakDay: row.streakDay,
    narrative: row.narrative ?? narrative,
    spark: spark.quote,
    emailedAt: row.emailedAt,
  };
}

/** Mark today's rollup as emailed (once-per-day guard for the delivery job). */
export async function markRollupEmailed(date: string): Promise<void> {
  await prisma.dayRollup.update({
    where: { date },
    data: { emailedAt: new Date() },
  });
}
