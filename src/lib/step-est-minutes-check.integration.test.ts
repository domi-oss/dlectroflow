/**
 * #78 — behavioural proof that `Step_estMinutes_check` really is enforced by
 * Postgres, not just by the application's clamps.
 *
 * `Step.estMinutes` is expected to always be >= 1. Four writers clamp it today
 * (`confirmBreakdown`, `updateStepEstimate`, `requeueFocus`, and the
 * single-task seed in `ensureFocusStep`), so the invariant holds — but it held
 * only because those four call sites stay correct, and a fifth writer added
 * later inherits no protection. A sub-1 estimate is a wrong-answer bug, not a
 * cosmetic one: !158 showed one bad row among good ones distorting the
 * step-size summary the breakdown coach is given.
 *
 * `enum-constraint-sync.integration.test.ts` polices that the constraint is
 * APPLIED and pins the right bound. This file proves it BITES: the inserts
 * below deliberately bypass every application clamp (raw SQL, not the Prisma
 * client's typed create) so the only thing that can reject them is the
 * database.
 *
 * Needs the real Postgres (CI wires up a service DB and runs
 * `prisma migrate deploy` first; locally it uses your DATABASE_URL schema —
 * vitest does NOT read .env):
 *   set -a; . ./.env; set +a; npm run test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { WorkspaceKind } from "@/lib/constants";

// Dedicated client + a unique, never-reused test workspace id, wiped before
// and after — same isolation approach as seed-review /
// delete-braindump-item.integration.test.ts, so $disconnect() here can't tear
// the connection out from under sibling integration tests.
const prisma = new PrismaClient();
const WS = "test-78-estminutes-ws";

let taskId: string;

async function wipe() {
  await prisma.step.deleteMany({ where: { task: { workspaceId: WS } } });
  await prisma.task.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

/**
 * Insert a Step straight through SQL. Deliberately raw: `prisma.step.create`
 * would still go through the client, and every real writer clamps before it
 * gets there — a raw INSERT is the closest thing to "a future writer that
 * forgot", which is exactly what the constraint has to stop.
 *
 * Parameterised ($1..$6) rather than interpolated, so it can't be read as a
 * SQL-injection pattern and matches how the other raw queries in the tree are
 * written.
 */
function insertStep(id: string, estMinutes: number) {
  return prisma.$executeRawUnsafe(
    `INSERT INTO "Step" ("id", "taskId", "text", "order", "total", "estMinutes")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    id,
    taskId,
    "raw insert",
    1,
    1,
    estMinutes,
  );
}

describe("Step.estMinutes >= 1 is enforced by the database (#78)", () => {
  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({
      data: { id: WS, kind: WorkspaceKind.Guest },
    });
    const task = await prisma.task.create({
      data: { title: "estMinutes constraint fixture", workspaceId: WS },
    });
    taskId = task.id;
  });

  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  // 0 is the value that actually reached production shape in !158's report
  // (a falsy estimate surviving `s.estMinutes || 15` is impossible, but a
  // direct write of 0 was not), and -5 is the negative case from the same
  // report. Both must be rejected by the DB, with a check_violation (23514)
  // naming the constraint — not silently coerced.
  it.each([
    { label: "zero (estMinutes = 0)", value: 0 },
    { label: "negative (estMinutes = -5)", value: -5 },
  ])("rejects a raw insert with a $label estimate", async ({ value }) => {
    await expect(insertStep(`test-78-${value}`, value)).rejects.toThrow(
      /Step_estMinutes_check/,
    );

    // And nothing was written — the whole statement rolled back.
    const survivors = await prisma.step.count({
      where: { task: { workspaceId: WS }, estMinutes: { lt: 1 } },
    });
    expect(survivors).toBe(0);
  });

  it("accepts the boundary value estMinutes = 1", async () => {
    await expect(insertStep("test-78-boundary", 1)).resolves.toBe(1);

    const row = await prisma.step.findUnique({
      where: { id: "test-78-boundary" },
    });
    expect(row?.estMinutes).toBe(1);
  });
});
