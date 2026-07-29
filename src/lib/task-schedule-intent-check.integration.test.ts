/**
 * #106 — behavioural proof that the DB refuses a schedule intent it cannot mean.
 *
 * `Task.schedulePriority` and `Task.scheduleHours` are pseudo-enums mirroring
 * `SchedulePriority` / `ScheduleHours` in src/lib/scheduling/types.ts. The
 * application only ever writes values from those objects, so the invariant holds
 * today — but it holds only because `pushStepsToGoogleTasks` stays correct, and a
 * fifth writer added later inherits no protection. These values leave the app
 * again as Reclaim title parameters (`(priority:P2)`, `(type work)`), so a bad
 * row is a wrong-answer bug in someone's calendar, not a cosmetic one.
 *
 * `enum-constraint-sync.integration.test.ts` polices that the constraints are
 * APPLIED and mirror the constants exactly. This file proves they BITE: the
 * writes below deliberately bypass the Prisma client's types (raw SQL), which is
 * the only way an out-of-set value can reach Postgres at all.
 *
 * Needs the real Postgres (CI wires up a service DB and runs
 * `prisma migrate deploy` first; locally it uses your DATABASE_URL schema —
 * vitest does NOT read .env):
 *   set -a; . ./.env; set +a; npm run test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { WorkspaceKind } from "@/lib/constants";
import { SchedulePriority, ScheduleHours } from "@/lib/scheduling/types";

// Dedicated client + a unique, never-reused test workspace id, wiped before and
// after — the same isolation approach as step-est-minutes-check.integration
// .test.ts, so $disconnect() here can't tear the connection out from under
// sibling integration tests.
const prisma = new PrismaClient();
const WS = "test-106-schedule-intent-ws";

async function wipe() {
  await prisma.task.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

/**
 * Write one intent column straight through SQL. Deliberately raw: Prisma's
 * generated types make `schedulePriority: "urgent"` a compile error, so a raw
 * UPDATE is the closest thing to "a future writer that forgot" — which is
 * exactly what the constraint has to stop.
 */
function setColumn(taskId: string, column: string, value: string) {
  return prisma.$executeRawUnsafe(
    `UPDATE "Task" SET "${column}" = $1 WHERE "id" = $2`,
    value,
    taskId,
  );
}

describe("Task schedule-intent CHECK constraints are enforced by the database (#106)", () => {
  let taskId: string;

  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({
      data: { id: WS, kind: WorkspaceKind.Guest },
    });
    const task = await prisma.task.create({
      data: { title: "schedule intent constraint fixture", workspaceId: WS },
    });
    taskId = task.id;
  });

  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it("accepts every priority SchedulePriority declares", async () => {
    for (const priority of Object.values(SchedulePriority)) {
      await expect(
        setColumn(taskId, "schedulePriority", priority),
      ).resolves.toBe(1);
    }
    const row = await prisma.task.findUnique({ where: { id: taskId } });
    expect(row?.schedulePriority).toBe(SchedulePriority.Low);
  });

  it("accepts every category ScheduleHours declares", async () => {
    for (const hours of Object.values(ScheduleHours)) {
      await expect(setColumn(taskId, "scheduleHours", hours)).resolves.toBe(1);
    }
    const row = await prisma.task.findUnique({ where: { id: taskId } });
    expect(row?.scheduleHours).toBe(ScheduleHours.Personal);
  });

  // "urgent" is the plausible wrong value: it is what a human would type, and
  // Reclaim has no such priority — it would encode as a malformed parameter.
  it("rejects a priority that is not one of the four", async () => {
    await expect(
      setColumn(taskId, "schedulePriority", "urgent"),
    ).rejects.toThrow(/Task_schedulePriority_check/);
  });

  // "evenings" is the owner's own word for the personal profile's hours, so it
  // is the value a future writer is most likely to reach for by mistake.
  it("rejects hours that are neither work nor personal", async () => {
    await expect(
      setColumn(taskId, "scheduleHours", "evenings"),
    ).rejects.toThrow(/Task_scheduleHours_check/);
  });

  it("allows NULL — a task nobody has scheduled through the menu has no intent", async () => {
    const created = await prisma.task.create({
      data: { title: "no intent yet", workspaceId: WS },
    });
    expect(created.scheduleDueAt).toBeNull();
    expect(created.schedulePriority).toBeNull();
    expect(created.scheduleHours).toBeNull();

    // And NULL is reachable again: clearing an intent must not be blocked.
    await prisma.$executeRawUnsafe(
      `UPDATE "Task" SET "schedulePriority" = NULL, "scheduleHours" = NULL WHERE "id" = $1`,
      taskId,
    );
    const cleared = await prisma.task.findUnique({ where: { id: taskId } });
    expect(cleared?.schedulePriority).toBeNull();
    expect(cleared?.scheduleHours).toBeNull();
  });
});
