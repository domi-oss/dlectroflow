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
//   1. Every read is scoped to the REQUEST's workspace — never anybody else's.
//      (The route resolves the owner's model tier separately, still gated on
//      `owner`; that call must not be confused with these. Pre-#35 the danger
//      was the OWNER_WORKSPACE_ID constant; now it is any other account's id.)
//   2. Every read pins an explicit `select`, and only ONE selected column is
//      free text: `Task.notes`, for the single task the caller says is being
//      broken down. Everything else is numeric / enum / boolean / date, and
//      `Step.text` and `BrainDumpItem.text` are never selected at all.
//
//      WHERE THE LINE IS, AND WHY IT IS THERE. This invariant used to admit no
//      free text whatever. The owner changed it deliberately on 2026-08-08
//      (#179, !281): the note is the context that makes a breakdown good — "for
//      the accountant, needs receipts" — and a coach that cannot see it plans
//      around a constraint the person had already written down. What did NOT
//      change is the reason the rule existed. The line now runs between:
//        • the CURRENT task's own note — one row, named by the request, supplied
//          on purpose as context for the very breakdown being asked for. It is
//          the same category as the task title the prompt has always carried;
//        • the text of OTHER and PAST items — `Step.text`, `BrainDumpItem.text`,
//          and the notes of every task in the history summary. Those are still
//          never selected, because feeding them back in is what would make
//          breakdown history a SELF-FEEDING injection channel: a note written
//          once would ride into every later breakdown, unread by anyone.
//      One task's note is context. Every task's note is a channel. Not fetching
//      the rest is still a far stronger guarantee than remembering not to render
//      it, so the history reads keep their text-free selects.
//
//      The note is untrusted text on its way into a prompt, so the rendering
//      half fences and labels it (`buildNoteBlock` in src/lib/breakdown.ts) and
//      neutralises the markers it would need to escape that fence. What remains
//      — a model persuaded by prose inside the fence — is the residual risk the
//      owner accepted, alongside the BYO-LLM egress of the note itself.
//   3. Read-only. No upsert (which is why this uses prisma.settings/streak
//      .findUnique directly rather than getSettings/getStreak from @/lib/db —
//      both of those CREATE a row, and the breakdown route is a hot path).

import { prisma } from "@/lib/db";
import { BrainDumpStatus } from "@/lib/constants";
import { bucketItems, type Item } from "@/components/inbox/bucket";
import { normalizeTaskNote } from "@/lib/task-notes";
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
    // An estimate is usable only if it is a real number of at least one whole
    // minute. Anything else — NaN, Infinity, zero, negative, sub-minute — is
    // SKIPPED, not coerced.
    //
    // Clamping a negative to 0 and keeping it (the original behaviour, caught
    // in !158 review) is worse than dropping the row: it inflates stepCount,
    // drags minMinutes to 0 and shifts the median, so the coach is told this
    // person likes 0-minute steps and sizes its next proposal accordingly.
    //
    // No writer can currently persist one — confirmBreakdown, updateStepEstimate,
    // requeueFocus and the single-task seed all clamp to >= 1 — but Step.estMinutes
    // has no CHECK constraint behind it (unlike this schema's pseudo-enum columns),
    // so that guarantee rests entirely on four scattered call sites staying correct.
    // This is the read-side backstop; see the note in the MR about the constraint.
    if (
      typeof r.estMinutes !== "number" ||
      !Number.isFinite(r.estMinutes) ||
      r.estMinutes < 1
    ) {
      continue;
    }
    const at = r.createdAt instanceof Date ? r.createdAt.getTime() : 0;
    const g = groups.get(r.taskId) ?? { newest: at, minutes: [] };
    g.newest = Math.max(g.newest, at);
    g.minutes.push(Math.trunc(r.estMinutes));
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
 * `currentTaskId` names the task being broken down, and does two jobs:
 *   • it excludes that task's own steps from the history summary, so the coach
 *     is never shown its own draft as evidence of how this person likes their
 *     breakdowns shaped;
 *   • since #179 it is also the key for the ONE free-text read — that task's
 *     `Task.notes`. Read invariant 2 at the top of this file first.
 *
 * `Task.notes` and NOT `BrainDumpItem.notes`, which is the column #179 added.
 * They hold the same value at triage — `brainDumpItemToTaskData` COPIES the
 * item's note across — but only the task column stays live afterwards, which is
 * exactly what `liveNote()` (src/lib/braindump-to-task.ts) exists to say: from
 * triage onwards every note surface reads `Task.notes` and the item's copy is a
 * historical leftover. A breakdown always has a Task (the page is
 * /tasks/[taskId], and `startBreakdown` creates one before navigating), so
 * reading the item column here would show the coach a note the person had since
 * edited — or one they had DELETED, since deleting through `NoteField` clears
 * the task column and leaves the item's triage-time copy behind.
 *
 * The id arrives in the request body, so it is untrusted: the `workspaceId`
 * term in that read is invariant 1 doing its job, and without it naming
 * somebody else's task id would quote their note into this prompt. A miss
 * resolves to `null`, which reads as "no note" — never as an error.
 */
export async function gatherBreakdownContext(
  workspaceId: string,
  currentTaskId?: string | null,
): Promise<BreakdownContext> {
  try {
    const [settings, streak, boardRows, stepRows, currentTask] =
      await Promise.all([
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
            task: {
              select: { status: true, steps: { select: { done: true } } },
            },
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
        // #179 — the ONE free-text read (invariant 2). `findFirst` and not
        // `findUnique`, because the where clause has to carry `workspaceId`
        // alongside the id: the id came from the request body, and a unique
        // lookup on it alone would be a straight IDOR into anybody's note. No
        // task named ⇒ no query at all, which keeps the pre-#179 request shape
        // exactly as cheap as it was.
        currentTaskId
          ? prisma.task.findFirst({
              where: { id: currentTaskId, workspaceId },
              select: { notes: true },
            })
          : Promise.resolve(null),
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

    // The SHARED normaliser (src/lib/task-notes.ts), not a second rule: "" and
    // whitespace-only fold to "no note" here by exactly the same definition the
    // write path uses, and the control-character sweep and the 2000-character
    // clamp are re-applied on the way out. Both are already true of every row
    // the app writes — the CHECK constraint sees to the length — so this costs
    // nothing on the real path and is the read-side backstop for a row that
    // predates the constraint, which would otherwise be the one value on this
    // whole boundary that nothing bounds. The prompt-side cap is separate and
    // much tighter (`MAX_NOTE_CONTEXT_CHARS`).
    const note = normalizeTaskNote(currentTask?.notes);

    return {
      voice,
      streak: streakCtx,
      note,
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
