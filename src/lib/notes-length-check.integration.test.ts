/**
 * #44 — behavioural proof that `Task_notes_check` and `Step_notes_check` are
 * enforced by Postgres, not only by `normalizeTaskNote`.
 *
 * `enum-constraint-sync.integration.test.ts` polices that both constraints are
 * APPLIED and pins the bound and the measuring function they declare. This file
 * proves they BITE: the writes below are raw SQL, deliberately, because the
 * application writers (`updateTaskNotes`, `updateStepNotes`) clamp before Prisma
 * ever sees the value — so a raw INSERT is the closest thing to "a third writer
 * that forgot", which is the case the constraints exist for. #78's
 * `Step_estMinutes_check` is the same argument for a lower bound; these are its
 * upper-bound twins.
 *
 * Why an upper bound is worth a constraint at all: these columns are threaded
 * into the Google Task `notes` field, which the Tasks API rejects above 8192
 * characters. An unbounded note therefore does not fail at write time where the
 * user could see it — it fails later, at schedule time, on a surface that has
 * no way to explain itself.
 *
 * BOTH grains are exercised by the same table-driven block rather than one
 * being assumed to follow from the other: they are two separate CHECK
 * constraints in the DDL, and "the other one must be the same" is exactly the
 * assumption that lets one of them ship missing.
 *
 * Needs the real Postgres (CI wires up a service DB and runs
 * `prisma migrate deploy` first; locally it uses your DATABASE_URL schema —
 * vitest does NOT read .env):
 *   set -a; . ./.env; set +a; npm run test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { WorkspaceKind } from "@/lib/constants";
import { TASK_NOTE_MAX_LENGTH } from "@/lib/task-notes";

// Dedicated client + a unique, never-reused test workspace id, wiped before and
// after — the isolation approach every integration test here uses, so
// $disconnect() cannot tear the connection out from under a sibling suite.
const prisma = new PrismaClient();
const WS = "test-44-notes-ws";

let hostTaskId: string;

async function wipe() {
  await prisma.step.deleteMany({ where: { task: { workspaceId: WS } } });
  await prisma.task.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

/**
 * Insert a row carrying `notes`, straight through SQL. Deliberately raw:
 * `prisma.task.create` would still go through the client, and every real writer
 * normalises before it gets there — a raw INSERT is the closest thing to "a
 * future writer that forgot", which is exactly what the constraint has to stop.
 *
 * Parameterised ($1..$n) rather than interpolated, so it cannot be read as a
 * SQL-injection pattern and matches how the other raw queries here are written.
 */
function insertTask(id: string, notes: string) {
  return prisma.$executeRawUnsafe(
    `INSERT INTO "Task" ("id", "title", "workspaceId", "notes")
     VALUES ($1, $2, $3, $4)`,
    id,
    "notes constraint fixture",
    WS,
    notes,
  );
}

function insertStep(id: string, notes: string) {
  return prisma.$executeRawUnsafe(
    `INSERT INTO "Step" ("id", "taskId", "text", "order", "total", "estMinutes", "notes")
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    id,
    hostTaskId,
    "raw insert",
    1,
    1,
    15,
    notes,
  );
}

const GRAINS = [
  { label: "Task.notes", constraint: "Task_notes_check", insert: insertTask },
  { label: "Step.notes", constraint: "Step_notes_check", insert: insertStep },
] as const;

describe(`notes columns are bounded at ${TASK_NOTE_MAX_LENGTH} characters by the database (#44)`, () => {
  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({
      data: { id: WS, kind: WorkspaceKind.Guest },
    });
    const host = await prisma.task.create({
      data: { title: "notes constraint host", workspaceId: WS },
    });
    hostTaskId = host.id;
  });

  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it.each(GRAINS)(
    "$label rejects a raw insert one character over the bound",
    async ({ constraint, insert }) => {
      await expect(
        insert(`over-${constraint}`, "x".repeat(TASK_NOTE_MAX_LENGTH + 1)),
        // `toThrow(string)` is a SUBSTRING match in vitest, so the constraint
        // name is checked without constructing a regex from a variable.
      ).rejects.toThrow(constraint);
    },
  );

  it.each(GRAINS)(
    "$label accepts the boundary value exactly at the bound",
    async ({ constraint, insert }) => {
      await expect(
        insert(`bound-${constraint}`, "y".repeat(TASK_NOTE_MAX_LENGTH)),
      ).resolves.toBe(1);
    },
  );

  it.each(GRAINS)(
    "$label counts CHARACTERS, not octets — an all-emoji note at the bound is legal",
    async ({ constraint, insert }) => {
      // `char_length()` and `octet_length()` differ by 4x on astral characters,
      // so the wrong one would reject a note a quarter the length of a Latin one
      // the constraint accepts. `normalizeTaskNote` clamps in code points for
      // the same reason; this is the half that proves the two agree.
      await expect(
        insert(`emoji-${constraint}`, "🧠".repeat(TASK_NOTE_MAX_LENGTH)),
      ).resolves.toBe(1);
    },
  );

  it("stores the boundary values back intact, not silently truncated", async () => {
    const task = await prisma.task.findUnique({
      where: { id: "bound-Task_notes_check" },
    });
    const step = await prisma.step.findUnique({
      where: { id: "bound-Step_notes_check" },
    });
    expect(task?.notes).toHaveLength(TASK_NOTE_MAX_LENGTH);
    expect(step?.notes).toHaveLength(TASK_NOTE_MAX_LENGTH);
  });

  it("rolls the whole statement back on a rejection, leaving no row", async () => {
    expect(
      await prisma.task.count({ where: { id: "over-Task_notes_check" } }),
    ).toBe(0);
    expect(
      await prisma.step.count({ where: { id: "over-Step_notes_check" } }),
    ).toBe(0);
  });

  it("allows NULL on both — an un-annotated task or step is the common case", async () => {
    const task = await prisma.task.create({
      data: { title: "no note", workspaceId: WS },
    });
    const step = await prisma.step.create({
      data: {
        taskId: task.id,
        text: "no note either",
        order: 1,
        total: 1,
        estMinutes: 10,
      },
    });
    expect(task.notes).toBeNull();
    expect(step.notes).toBeNull();
  });
});
