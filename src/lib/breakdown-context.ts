// Server-only. The #14 breakdown-coach context gather: the live, per-workspace
// state the coach is told about, read straight from Postgres.
//
// Kept OUT of src/lib/breakdown.ts on purpose — that file promises to be
// import-safe from client components, and this one imports prisma. The pure
// rendering half (BreakdownContext, buildContextBlock) lives there; the reads
// and the coercion live here.
//
// Security posture (see #14's spec §3). Whatever this returns is rendered into
// a prompt and sent to whichever LLM the deploy is configured with — under
// BYO-LLM (#59) that can be a third-party endpoint the owner pointed us at. So
// this module is an egress boundary, and it holds three lines:
//   1. Every read is scoped to the REQUEST's workspace. Never OWNER_WORKSPACE_ID
//      (the route resolves the owner's model tier separately, still gated on
//      `owner` — that call must not be confused with these).
//   2. Every read pins an explicit `select` of numeric / enum / boolean / date
//      columns. Notably `Step.text` and `BrainDumpItem.text` are never selected:
//      not fetching them is a far stronger guarantee than remembering not to
//      render them, and it also means breakdown history can never become a
//      prompt-injection channel into future breakdowns.
//   3. Read-only. No upsert (which is why this uses prisma.settings/streak
//      .findUnique directly rather than getSettings/getStreak from @/lib/db —
//      both of those CREATE a row, and the breakdown route is a hot path).

import { prisma } from "@/lib/db";
import { BrainDumpStatus } from "@/lib/constants";
import { bucketItems, type Item } from "@/components/inbox/bucket";
import type { BreakdownContext, RecentBreakdownShape } from "@/lib/breakdown";

/** How many past breakdowns the coach is shown the SHAPE of. */
export const RECENT_BREAKDOWN_LIMIT = 3;

/**
 * Hard cap on the step rows scanned to find those breakdowns. Prompt cost must
 * not grow with how long someone has used the app: 200 rows is far more than
 * the ~3 tasks' worth we summarise, while staying a trivially small query.
 */
export const RECENT_STEP_ROW_LIMIT = 200;

/**
 * Hard cap on the live inbox rows scanned for the board counts. Beyond this
 * the counts under-report — acceptable, because they are background colour for
 * the coach, not a figure anyone is shown (the coach is forbidden from reciting
 * them back at all).
 */
export const BOARD_SCAN_LIMIT = 1_000;

/** Local-calendar YYYY-MM-DD — must match `ymd()` in rewards.ts, which is what
 *  writes `Streak.lastActiveWorkday`. */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** Minimal step row: ids for grouping, one integer, one date. No text. */
export type StepShapeRow = {
  taskId: string;
  estMinutes: number;
  createdAt: Date;
};

/** Minimal inbox row: enums, dates and step DONE flags. No text, no ids. */
type BoardRow = {
  status: string;
  createdAt: Date;
  freshenedAt: Date | null;
  snoozedUntil: Date | null;
  completedAt: Date | null;
  breakdownRequestedAt: Date | null;
  task: { status: string; steps: { done: boolean }[] } | null;
};

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Reduce raw step rows to the SHAPE of the most recent kept breakdowns:
 * how many steps, and how big they were. Pure.
 *
 * Ranking uses each task's NEWEST `Step.createdAt`, not the task's own
 * createdAt: `confirmBreakdown()` deletes and recreates every row, so step
 * timestamps track the latest confirm — which is exactly "how they like their
 * breakdowns shaped lately".
 */
export function summarizeRecentBreakdowns(
  rows: StepShapeRow[],
  limit: number = RECENT_BREAKDOWN_LIMIT,
): RecentBreakdownShape[] {
  const groups = new Map<string, { newest: number; minutes: number[] }>();
  for (const r of rows) {
    if (typeof r.taskId !== "string" || !r.taskId) continue;
    if (typeof r.estMinutes !== "number" || !Number.isFinite(r.estMinutes)) {
      continue;
    }
    const at = r.createdAt instanceof Date ? r.createdAt.getTime() : 0;
    const g = groups.get(r.taskId) ?? { newest: at, minutes: [] };
    g.newest = Math.max(g.newest, at);
    g.minutes.push(Math.max(0, Math.trunc(r.estMinutes)));
    groups.set(r.taskId, g);
  }

  return [...groups.values()]
    .filter((g) => g.minutes.length > 0)
    .sort((a, b) => b.newest - a.newest)
    .slice(0, limit)
    .map((g) => {
      const sorted = [...g.minutes].sort((a, b) => a - b);
      return {
        stepCount: sorted.length,
        minMinutes: sorted[0],
        medianMinutes: median(sorted),
        maxMinutes: sorted[sorted.length - 1],
      };
    });
}

/**
 * Map a minimal board row onto the `Item` shape `bucketItems()` consumes.
 *
 * Deliberately reusing the inbox's own bucketing function rather than
 * re-deriving the membership rules in SQL: the spec called out drift from
 * `src/components/inbox/bucket.ts` as the main risk here, and the only way to
 * make drift structurally impossible is to run the same code. The fields
 * bucketItems never reads (`id`, `text`, …) are filled with inert placeholders
 * — `text` in particular is NOT selected from the database at all.
 */
function toItem(r: BoardRow): Item {
  const steps = r.task?.steps ?? [];
  return {
    id: "",
    text: "",
    createdAt: r.createdAt,
    status: r.status,
    triagedAt: null,
    remindedAt: null,
    snoozedUntil: r.snoozedUntil,
    taskId: null,
    freshenedAt: r.freshenedAt,
    promptDismissedAt: null,
    breakdownRequestedAt: r.breakdownRequestedAt,
    stepsTotal: steps.length,
    stepsDone: steps.filter((s) => s.done).length,
    taskStatus: r.task?.status ?? null,
    completedAt: r.completedAt,
    scheduledAt: null,
    estMinutes: null,
    steps: [],
  };
}

function countBuckets(rows: BoardRow[]): BreakdownContext["buckets"] {
  const b = bucketItems(rows.map(toItem));
  const counts = {
    needsReview: b.needsReview.length,
    singleTask: b.singleTask.length,
    multiStep: b.multiStep.length,
    savedLater: b.savedLater.length,
  };
  const total = Object.values(counts).reduce((a, n) => a + n, 0);
  return total > 0 ? counts : null;
}

/**
 * Gather the live context for one breakdown request.
 *
 * NEVER rejects: the breakdown path was DB-light before this feature, and a
 * slow or unavailable Postgres must not turn a working breakdown into the
 * canned local fallback. Any failure resolves to `{}`, which renders as an
 * empty context and therefore a prompt byte-identical to the pre-#14 one.
 *
 * `currentTaskId` excludes the in-flight task's own steps from the history
 * summary. The breakdown request body carries no task id today (see the note
 * in the route), so it is unused there — it exists so a future caller that
 * does know the task cannot accidentally feed the coach its own draft.
 */
export async function gatherBreakdownContext(
  workspaceId: string,
  currentTaskId?: string | null,
): Promise<BreakdownContext> {
  try {
    const [settings, streak, boardRows, stepRows] = await Promise.all([
      prisma.settings.findUnique({
        where: { workspaceId },
        select: { voice: true },
      }),
      prisma.streak.findUnique({
        where: { workspaceId },
        select: { current: true, lastActiveWorkday: true },
      }),
      prisma.brainDumpItem.findMany({
        // Archived and completed items belong to none of the four buckets
        // bucketItems() puts them in, so filtering them here shrinks the scan
        // without changing a single count. The integration test proves it.
        where: {
          workspaceId,
          status: { not: BrainDumpStatus.Archived },
          completedAt: null,
        },
        select: {
          status: true,
          createdAt: true,
          freshenedAt: true,
          snoozedUntil: true,
          completedAt: true,
          breakdownRequestedAt: true,
          task: { select: { status: true, steps: { select: { done: true } } } },
        },
        take: BOARD_SCAN_LIMIT,
      }),
      prisma.step.findMany({
        where: {
          task: { workspaceId },
          ...(currentTaskId ? { taskId: { not: currentTaskId } } : {}),
        },
        select: { taskId: true, estMinutes: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: RECENT_STEP_ROW_LIMIT,
      }),
    ]);

    // Settings.voice is a plain String column with no CHECK constraint, so an
    // unknown value is treated as "no preference recorded" rather than passed
    // through into the prompt.
    const voice =
      settings?.voice === "plain" || settings?.voice === "playful"
        ? settings.voice
        : null;

    const current = streak?.current ?? 0;
    const streakCtx =
      Number.isFinite(current) && current > 0
        ? {
            current,
            // Only the derived boolean leaves the app — the raw date does not.
            activeToday: streak?.lastActiveWorkday === ymd(new Date()),
          }
        : null;

    return {
      voice,
      streak: streakCtx,
      buckets: countBuckets(boardRows as BoardRow[]),
      recentBreakdowns: summarizeRecentBreakdowns(stepRows as StepShapeRow[]),
    };
  } catch {
    // Deliberately silent and deliberately empty. The caller streams a real
    // breakdown with no context rather than failing or falling back; the LLM
    // failure counter on /api/livez is for LLM failures, not for this.
    return {};
  }
}
