/**
 * Real-Postgres proof for the #14 breakdown-coach context.
 *
 * Two things mocks cannot demonstrate and that would fail silently — the coach
 * would just be told slightly wrong things about someone — are proved here:
 *
 *   1. BUCKET PARITY. `gatherBreakdownContext` narrows the scan in SQL
 *      (`status != archived`, `completedAt IS NULL`) before handing rows to
 *      `bucketItems()`. That prefilter is only safe if it cannot change a
 *      single count, so this seeds every bucket edge — including the rows the
 *      prefilter removes — and asserts the gathered counts equal
 *      `bucketItems()` run over the UNFILTERED set.
 *
 *   2. WORKSPACE ISOLATION. Two populated workspaces, and neither one's counts,
 *      streak, voice or breakdown history bleed into the other's prompt.
 *
 *   3. THE NOTE (#179). The one free-text column the coach is allowed to read,
 *      proved end to end: the real column, through the real query, into the
 *      real prompt — and still nothing of `Step.text` or `BrainDumpItem.text`.
 *
 * It's an *.integration.test.ts — it needs the real Postgres (CI wires one up;
 * locally it uses your DATABASE_URL schema).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { BrainDumpStatus, TaskStatus } from "@/lib/constants";
import { bucketItems, type Item } from "@/components/inbox/bucket";
import { gatherBreakdownContext } from "./breakdown-context";
import { buildContextBlock, buildUserPrompt } from "./breakdown";

const WS = "test-ws-breakdown-ctx";
const OTHER = "test-ws-breakdown-ctx-other";

/** The note on the task the #179 tests break down, and its task id. */
const NOTED = "SEEDED-TASK-NOTE — hand these to the accountant";
let notedTaskId = "";

const HOUR = 3_600_000;

async function seedWorkspace(id: string) {
  await prisma.workspace.upsert({
    where: { id },
    create: { id, kind: "guest" },
    update: {},
  });
}

/**
 * Create one BrainDumpItem, optionally backed by a Task with N steps.
 * `doneSteps` of those steps are marked done.
 */
async function seedItem(opts: {
  workspaceId: string;
  status?: string;
  snoozedUntil?: Date | null;
  completedAt?: Date | null;
  breakdownRequestedAt?: Date | null;
  taskStatus?: string;
  steps?: number;
  doneSteps?: number;
  stepMinutes?: number[];
  stepCreatedAt?: Date;
}): Promise<void> {
  const {
    workspaceId,
    status = BrainDumpStatus.Inbox,
    snoozedUntil = null,
    completedAt = null,
    breakdownRequestedAt = null,
    taskStatus,
    steps = 0,
    doneSteps = 0,
    stepMinutes,
    stepCreatedAt,
  } = opts;

  let taskId: string | null = null;
  if (taskStatus) {
    const task = await prisma.task.create({
      data: { title: "seeded task", workspaceId, status: taskStatus },
    });
    taskId = task.id;
    for (let i = 0; i < steps; i++) {
      await prisma.step.create({
        data: {
          taskId: task.id,
          text: `SEEDED-STEP-TEXT-${i}`,
          order: i,
          total: steps,
          estMinutes: stepMinutes?.[i] ?? 10,
          done: i < doneSteps,
          ...(stepCreatedAt ? { createdAt: stepCreatedAt } : {}),
        },
      });
    }
  }

  await prisma.brainDumpItem.create({
    data: {
      text: "SEEDED-ITEM-TEXT",
      workspaceId,
      status,
      snoozedUntil,
      completedAt,
      breakdownRequestedAt,
      taskId,
    },
  });
}

/** Independent read of EVERY row, mapped to the inbox's `Item` shape. This is
 *  the reference `bucketItems()` is run over — deliberately unfiltered. */
async function allItems(workspaceId: string): Promise<Item[]> {
  const rows = await prisma.brainDumpItem.findMany({
    where: { workspaceId },
    include: { task: { include: { steps: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    createdAt: r.createdAt,
    status: r.status,
    triagedAt: r.triagedAt,
    remindedAt: r.remindedAt,
    snoozedUntil: r.snoozedUntil,
    taskId: r.taskId,
    freshenedAt: r.freshenedAt,
    promptDismissedAt: r.promptDismissedAt,
    breakdownRequestedAt: r.breakdownRequestedAt,
    stepsTotal: r.task?.steps.length ?? 0,
    stepsDone: r.task?.steps.filter((s) => s.done).length ?? 0,
    taskStatus: r.task?.status ?? null,
    completedAt: r.completedAt,
    scheduledAt: r.task?.scheduledAt ?? null,
    estMinutes: r.estMinutes,
    steps: [],
  }));
}

async function wipe(workspaceId: string) {
  await prisma.step.deleteMany({ where: { task: { workspaceId } } });
  await prisma.brainDumpItem.deleteMany({ where: { workspaceId } });
  await prisma.task.deleteMany({ where: { workspaceId } });
  await prisma.streak.deleteMany({ where: { workspaceId } });
  await prisma.settings.deleteMany({ where: { workspaceId } });
}

beforeAll(async () => {
  await seedWorkspace(WS);
  await seedWorkspace(OTHER);
  await wipe(WS);
  await wipe(OTHER);

  const past = new Date(Date.now() - 24 * HOUR);
  const future = new Date(Date.now() + 24 * HOUR);

  // ── every bucket edge, in the workspace under test ──────────────────────
  await seedItem({ workspaceId: WS }); // needsReview
  await seedItem({ workspaceId: WS, snoozedUntil: past }); // needsReview (snooze expired)
  await seedItem({ workspaceId: WS, snoozedUntil: future }); // savedLater
  await seedItem({ workspaceId: WS, completedAt: past }); // completed → no bucket
  await seedItem({ workspaceId: WS, status: BrainDumpStatus.Archived }); // archived → no bucket
  await seedItem({
    workspaceId: WS,
    status: BrainDumpStatus.Triaged,
    taskStatus: TaskStatus.Active,
    steps: 0,
  }); // singleTask (0 steps)
  await seedItem({
    workspaceId: WS,
    status: BrainDumpStatus.Triaged,
    taskStatus: TaskStatus.Active,
    steps: 1,
    stepMinutes: [15],
    stepCreatedAt: new Date(Date.now() - 3 * HOUR),
  }); // singleTask (1 step)
  await seedItem({
    workspaceId: WS,
    status: BrainDumpStatus.Triaged,
    taskStatus: TaskStatus.Active,
    steps: 4,
    doneSteps: 1,
    stepMinutes: [5, 10, 20, 30],
    stepCreatedAt: new Date(Date.now() - 1 * HOUR),
  }); // multiStep — and the NEWEST kept breakdown
  await seedItem({
    workspaceId: WS,
    status: BrainDumpStatus.Triaged,
    breakdownRequestedAt: past,
    taskStatus: TaskStatus.Active,
    steps: 0,
  }); // multiStep (awaiting breakdown)
  await seedItem({
    workspaceId: WS,
    status: BrainDumpStatus.Triaged,
    taskStatus: TaskStatus.Active,
    steps: 2,
    doneSteps: 2,
    stepMinutes: [25, 25],
    stepCreatedAt: new Date(Date.now() - 2 * HOUR),
  }); // every step done → fully done, no bucket (but IS breakdown history)
  await seedItem({
    workspaceId: WS,
    status: BrainDumpStatus.Triaged,
    taskStatus: TaskStatus.Done,
    steps: 0,
  }); // task done → no bucket
  await seedItem({
    workspaceId: WS,
    status: BrainDumpStatus.Triaged,
    completedAt: past,
    taskStatus: TaskStatus.Active,
    steps: 3,
    stepCreatedAt: new Date(Date.now() - 96 * HOUR),
  }); // completed → no bucket; oldest breakdown, so it falls off the last-3

  // #179 — a task carrying a note, with NO steps and NO item of its own, so it
  // is invisible to the bucket counts and to the breakdown history and cannot
  // move a single figure the tests above assert on.
  notedTaskId = (
    await prisma.task.create({
      data: {
        title: "SEEDED-NOTED-TASK-TITLE",
        workspaceId: WS,
        status: TaskStatus.Active,
        notes: NOTED,
      },
    })
  ).id;

  await prisma.settings.create({
    data: { id: WS, workspaceId: WS, voice: "playful" },
  });
  await prisma.streak.create({
    data: { id: WS, workspaceId: WS, current: 7, lastActiveWorkday: null },
  });

  // ── a second, differently-shaped workspace ──────────────────────────────
  await seedItem({ workspaceId: OTHER });
  await seedItem({ workspaceId: OTHER });
  await seedItem({ workspaceId: OTHER });
  await seedItem({
    workspaceId: OTHER,
    status: BrainDumpStatus.Triaged,
    taskStatus: TaskStatus.Active,
    steps: 9,
    stepMinutes: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  });
  await prisma.settings.create({
    data: { id: OTHER, workspaceId: OTHER, voice: "plain" },
  });
  await prisma.streak.create({
    data: { id: OTHER, workspaceId: OTHER, current: 99 },
  });
});

afterAll(async () => {
  await wipe(WS);
  await wipe(OTHER);
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, OTHER] } } });
  await prisma.$disconnect();
});

describe("gatherBreakdownContext — bucket parity with the inbox (#14)", () => {
  it("matches bucketItems() run over the UNFILTERED rows", async () => {
    const reference = bucketItems(await allItems(WS));
    const ctx = await gatherBreakdownContext(WS);

    expect(ctx.buckets).toEqual({
      needsReview: reference.needsReview.length,
      singleTask: reference.singleTask.length,
      multiStep: reference.multiStep.length,
      savedLater: reference.savedLater.length,
    });
    // Guard against a vacuous pass: the seed really does populate all four.
    expect(ctx.buckets).toEqual({
      needsReview: 2,
      singleTask: 2,
      multiStep: 2,
      savedLater: 1,
    });
  });

  it("counts nothing for a workspace with no rows at all", async () => {
    await seedWorkspace("test-ws-breakdown-ctx-empty");
    const ctx = await gatherBreakdownContext("test-ws-breakdown-ctx-empty");
    expect(ctx.buckets).toBeNull();
    expect(ctx.recentBreakdowns).toEqual([]);
    expect(ctx.streak).toBeNull();
    expect(ctx.voice).toBeNull();
    // The back-compat anchor, proved end to end against a real database.
    expect(buildContextBlock(ctx)).toBe("");
    await prisma.workspace.delete({
      where: { id: "test-ws-breakdown-ctx-empty" },
    });
  });
});

describe("gatherBreakdownContext — real reads (#14)", () => {
  it("reads voice and streak from this workspace's own rows", async () => {
    const ctx = await gatherBreakdownContext(WS);
    expect(ctx.voice).toBe("playful");
    expect(ctx.streak).toEqual({ current: 7, activeToday: false });
  });

  it("summarises the last three kept breakdowns, newest first, shapes only", async () => {
    const ctx = await gatherBreakdownContext(WS);
    expect(ctx.recentBreakdowns).toEqual([
      // 1h ago: 4 steps of 5/10/20/30
      { stepCount: 4, minMinutes: 5, medianMinutes: 15, maxMinutes: 30 },
      // 2h ago: 2 steps of 25
      { stepCount: 2, minMinutes: 25, medianMinutes: 25, maxMinutes: 25 },
      // 3h ago: 1 step of 15
      { stepCount: 1, minMinutes: 15, medianMinutes: 15, maxMinutes: 15 },
    ]);
    // The 96h-old 3-step breakdown exists but falls off the last-3 window.
    expect(ctx.recentBreakdowns).toHaveLength(3);
  });

  it("puts no step text, item text or identifier into the rendered block", async () => {
    const block = buildContextBlock(await gatherBreakdownContext(WS));
    expect(block).not.toContain("SEEDED-STEP-TEXT");
    expect(block).not.toContain("SEEDED-ITEM-TEXT");
    expect(block).not.toContain(WS);
    // No ISO dates or cuid-ish identifiers leaked into the prompt.
    expect(block).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(block).not.toMatch(/c[a-z0-9]{24}/);
  });

  it("excludes the in-flight task's own steps when asked", async () => {
    const newest = await prisma.step.findFirst({
      where: { task: { workspaceId: WS } },
      orderBy: { createdAt: "desc" },
      select: { taskId: true },
    });
    const ctx = await gatherBreakdownContext(WS, newest!.taskId);
    expect(ctx.recentBreakdowns?.[0]).toEqual({
      stepCount: 2,
      minMinutes: 25,
      medianMinutes: 25,
      maxMinutes: 25,
    });
  });
});

describe("gatherBreakdownContext — the current task's note (#179)", () => {
  it("reads the real column and quotes it into the real prompt, fenced", async () => {
    // Guard against a vacuous pass: the fixture really did write a task.
    expect(notedTaskId).not.toBe("");

    const ctx = await gatherBreakdownContext(WS, notedTaskId);
    expect(ctx.note).toBe(NOTED);

    const prompt = buildUserPrompt(
      {
        title: "SEEDED-NOTED-TASK-TITLE",
        currentProposal: null,
        feedback: { kind: "propose" },
      },
      ctx,
    );
    const lines = prompt.split("\n");
    const openAt = lines.indexOf("--- their note (verbatim) ---");
    expect(openAt).toBeGreaterThan(0);
    expect(lines[openAt + 1]).toBe(NOTED);
    expect(lines[openAt + 2]).toBe("--- end note ---");
    expect(lines.at(-1)).toMatch(/^Feedback: /);
  });

  it("still carries no step text, item text or task title, note or not", async () => {
    const ctx = await gatherBreakdownContext(WS, notedTaskId);
    const serialised = JSON.stringify(ctx);
    expect(serialised).toContain("SEEDED-TASK-NOTE");
    expect(serialised).not.toContain("SEEDED-STEP-TEXT");
    expect(serialised).not.toContain("SEEDED-ITEM-TEXT");
    expect(serialised).not.toContain("SEEDED-NOTED-TASK-TITLE");
    // The app-context block itself is unchanged: still numbers and one enum.
    expect(buildContextBlock(ctx)).not.toContain("SEEDED-TASK-NOTE");
  });

  it("reads no note when the caller names no task", async () => {
    expect((await gatherBreakdownContext(WS)).note).toBeNull();
  });

  it("reads no note for a task in another workspace", async () => {
    expect((await gatherBreakdownContext(OTHER, notedTaskId)).note).toBeNull();
  });
});

describe("gatherBreakdownContext — workspace isolation (#14)", () => {
  it("never mixes another workspace's board, voice, streak or history in", async () => {
    const mine = await gatherBreakdownContext(WS);
    const theirs = await gatherBreakdownContext(OTHER);

    expect(theirs.voice).toBe("plain");
    expect(theirs.streak).toEqual({ current: 99, activeToday: false });
    expect(theirs.buckets).toEqual({
      needsReview: 3,
      singleTask: 0,
      multiStep: 1,
      savedLater: 0,
    });
    expect(theirs.recentBreakdowns).toEqual([
      { stepCount: 9, minMinutes: 1, medianMinutes: 5, maxMinutes: 9 },
    ]);

    // And nothing of theirs shows up in mine.
    expect(mine.voice).toBe("playful");
    expect(mine.streak?.current).toBe(7);
    expect(buildContextBlock(mine)).not.toContain("9 steps");
    expect(buildContextBlock(mine)).not.toMatch(/99-day/);
  });
});
