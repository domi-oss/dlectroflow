/**
 * #44 — behavioural proof that `Task_notes_check` is enforced by Postgres, not
 * only by `normalizeTaskNote`.
 *
 * `enum-constraint-sync.integration.test.ts` polices that the constraint is
 * APPLIED and pins the bound it declares. This file proves it BITES: the writes
 * below are raw SQL, deliberately, because the one application writer
 * (`updateTaskNotes`) clamps before Prisma ever sees the value — so a raw INSERT
 * is the closest thing to "a second writer that forgot", which is the case the
 * constraint exists for. #78's `Step_estMinutes_check` is the same argument for
 * a lower bound; this is its upper-bound twin.
 *
 * Why an upper bound is worth a constraint at all: this column is threaded into
 * the Google Task `notes` field, which the Tasks API rejects above 8192
 * characters. An unbounded note therefore does not fail at write time where the
 * user could see it — it fails later, at schedule time, on a surface that has
 * no way to explain itself.
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
const WS = "test-44-tasknotes-ws";

async function wipe() {
  await prisma.task.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

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

describe(`Task.notes <= ${TASK_NOTE_MAX_LENGTH} is enforced by the database (#44)`, () => {
  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({
      data: { id: WS, kind: WorkspaceKind.Guest },
    });
  });

  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it("rejects a raw insert one character over the bound", async () => {
    await expect(
      insertTask("test-44-over", "x".repeat(TASK_NOTE_MAX_LENGTH + 1)),
    ).rejects.toThrow(/Task_notes_check/);

    // And nothing was written — the whole statement rolled back.
    expect(await prisma.task.count({ where: { id: "test-44-over" } })).toBe(0);
  });

  it("accepts the boundary value exactly at the bound", async () => {
    const atBound = "y".repeat(TASK_NOTE_MAX_LENGTH);
    await expect(insertTask("test-44-boundary", atBound)).resolves.toBe(1);

    const row = await prisma.task.findUnique({
      where: { id: "test-44-boundary" },
    });
    expect(row?.notes).toBe(atBound);
  });

  it("counts CHARACTERS, not octets — an all-emoji note at the bound is legal", async () => {
    // `char_length()` and `octet_length()` differ by 4x on astral characters, so
    // the wrong one here would reject a note a quarter the length of a Latin one
    // the constraint accepts. `normalizeTaskNote` clamps in code points for the
    // same reason; this is the half that proves the two agree.
    const emoji = "🧠".repeat(TASK_NOTE_MAX_LENGTH);
    await expect(insertTask("test-44-emoji", emoji)).resolves.toBe(1);

    const row = await prisma.task.findUnique({
      where: { id: "test-44-emoji" },
    });
    expect(row?.notes).toBe(emoji);
  });

  it("allows NULL — a task nobody has annotated is the common case", async () => {
    const task = await prisma.task.create({
      data: { title: "no note", workspaceId: WS },
    });
    expect(task.notes).toBeNull();
  });
});
