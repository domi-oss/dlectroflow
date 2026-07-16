import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { seedReviewApp } from "../../prisma/seed";

// A test-only workspace id so this never clobbers the real "review-demo"
// workspace and cleans up fully afterwards.
const WS = "test-review-demo-ws";

async function wipe() {
  await prisma.brainDumpItem.deleteMany({ where: { workspaceId: WS } });
  // Deleting the tasks cascades their steps (Step.taskId onDelete: Cascade).
  await prisma.task.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

describe("seedReviewApp (idempotent review-app seed)", () => {
  beforeAll(wipe);
  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it("creates demo content that spans the inbox buckets and is safe to re-run", async () => {
    await seedReviewApp(prisma, WS);

    const items1 = await prisma.brainDumpItem.count({ where: { workspaceId: WS } });
    const tasks1 = await prisma.task.count({ where: { workspaceId: WS } });
    const steps1 = await prisma.step.count({ where: { task: { workspaceId: WS } } });

    expect(items1).toBeGreaterThan(0);
    expect(tasks1).toBeGreaterThan(0);
    expect(steps1).toBeGreaterThan(0);

    // A demo workspace row exists and never expires (so the guest-TTL purge
    // can't sweep the seeded content out from under a reviewer).
    const ws = await prisma.workspace.findUnique({ where: { id: WS } });
    expect(ws?.expiresAt).toBeNull();

    // There is at least one un-triaged (needs-review) item AND at least one
    // multi-step task, so the row redesign has content to exercise.
    const inbox = await prisma.brainDumpItem.count({
      where: { workspaceId: WS, status: "inbox" },
    });
    expect(inbox).toBeGreaterThan(0);

    // Second run must not duplicate anything.
    await seedReviewApp(prisma, WS);
    const items2 = await prisma.brainDumpItem.count({ where: { workspaceId: WS } });
    const tasks2 = await prisma.task.count({ where: { workspaceId: WS } });
    const steps2 = await prisma.step.count({ where: { task: { workspaceId: WS } } });

    expect(items2).toBe(items1);
    expect(tasks2).toBe(tasks1);
    expect(steps2).toBe(steps1);
  });
});
