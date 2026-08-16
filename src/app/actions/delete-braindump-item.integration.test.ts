/**
 * Real-DB integration test for deleteBrainDumpItem — #64 (focus↔library data
 * integrity). Runs against actual Postgres (CI's dedicated service DB for
 * *.integration.test.ts files; see .gitlab-ci.yml) so the DB-level cascade
 * (Step_taskId_fkey / BreakdownTurn_taskId_fkey ON DELETE CASCADE, per
 * 20260718180000_workspace_cascade_fks) is exercised for real, not just
 * asserted against a mock.
 *
 * Only @/lib/workspace and next/cache are mocked (no request/cookie context
 * available outside Next.js) — @/lib/db's prisma client is the real one.
 *
 * Mirrors src/lib/seed-review.integration.test.ts's isolation approach: a
 * dedicated PrismaClient + a unique, never-reused test workspace id, wiped
 * before and after.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

const WS = vi.hoisted(() => "test-64-orphan-ws");

vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: vi.fn().mockResolvedValue(WS),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rewards", () => ({
  // #233 — "this item credited no day", so the streak revocation below is
  // handed an empty set and is a no-op. A file asking about the ledger sets
  // these up; every other file asserts the untouched-streak path.
  engagementDaysOfItem: vi.fn().mockResolvedValue([]),
  engagementDaysNowEmpty: vi.fn().mockResolvedValue([]),
  revokeUnqualifiedStreakBadges: vi.fn().mockResolvedValue([]),
  maybeAwardInboxZero: vi.fn().mockResolvedValue(undefined),
  // #251 — stubbed, not exercised. This file's question is the #64 cascade, and
  // the reversal's own arithmetic, floor guard and concurrency are proved against
  // the same real Postgres in delete-completed-item.integration.test.ts. Leaving
  // it live here would mean every fixture had to account for its reward rows to
  // assert something about Task orphaning.
  reverseItemCompletionRewards: vi
    .fn()
    .mockResolvedValue({ stepDone: 0, taskComplete: false }),
  revokeUnqualifiedBadges: vi.fn().mockResolvedValue([]),
}));

// Dedicated client (not the shared @/lib/db singleton used by the action
// under test) so this test's own setup/teardown queries and $disconnect()
// can't interfere with it — same rationale as seed-review.integration.test.ts.
const prisma = new PrismaClient();

async function wipe() {
  await prisma.breakdownTurn.deleteMany({
    where: { task: { workspaceId: WS } },
  });
  await prisma.step.deleteMany({ where: { task: { workspaceId: WS } } });
  await prisma.focusSession.deleteMany({ where: { workspaceId: WS } });
  await prisma.brainDumpItem.deleteMany({ where: { workspaceId: WS } });
  await prisma.task.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

describe("deleteBrainDumpItem (real Postgres) — no orphaned Task survives (#64)", () => {
  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: WS, kind: "owner" } });
  });

  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it("deleting the last BrainDumpItem referencing a broken-down Task removes the Task + its Steps + BreakdownTurns", async () => {
    const task = await prisma.task.create({
      data: { title: "Ship the thing", workspaceId: WS },
    });
    await prisma.step.createMany({
      data: [
        {
          taskId: task.id,
          text: "step 1",
          order: 1,
          total: 2,
          estMinutes: 10,
        },
        {
          taskId: task.id,
          text: "step 2",
          order: 2,
          total: 2,
          estMinutes: 10,
        },
      ],
    });
    await prisma.breakdownTurn.create({
      data: { taskId: task.id, role: "user", message: "break this down" },
    });
    const item = await prisma.brainDumpItem.create({
      data: {
        text: "Ship the thing",
        workspaceId: WS,
        taskId: task.id,
        status: "triaged",
      },
    });

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    const [survivingTask, survivingSteps, survivingTurns, survivingItem] =
      await Promise.all([
        prisma.task.findUnique({ where: { id: task.id } }),
        prisma.step.count({ where: { taskId: task.id } }),
        prisma.breakdownTurn.count({ where: { taskId: task.id } }),
        prisma.brainDumpItem.findUnique({ where: { id: item.id } }),
      ]);

    expect(survivingItem).toBeNull();
    expect(survivingTask).toBeNull(); // the whole point of #64: no orphaned Task
    expect(survivingSteps).toBe(0);
    expect(survivingTurns).toBe(0);
  });

  it("deleting a single-task item (no linked Task) is a plain row delete — no Task side effects", async () => {
    const item = await prisma.brainDumpItem.create({
      data: { text: "quick todo", workspaceId: WS, status: "inbox" },
    });
    const tasksBefore = await prisma.task.count({ where: { workspaceId: WS } });

    const { deleteBrainDumpItem } = await import("./braindump");
    await deleteBrainDumpItem(item.id);

    const survivingItem = await prisma.brainDumpItem.findUnique({
      where: { id: item.id },
    });
    const tasksAfter = await prisma.task.count({ where: { workspaceId: WS } });

    expect(survivingItem).toBeNull();
    expect(tasksAfter).toBe(tasksBefore);
  });
});
