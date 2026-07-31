/**
 * #80 — behavioural proof that `BrainDumpItem_estMinutes_check` really is
 * enforced by Postgres, not just by the application's clamp.
 *
 * This column is the deliberate mirror-image of `Step.estMinutes` (#78): it is
 * NULLABLE and null carries meaning — "no estimate given, use the display
 * default" (`item.estMinutes ?? 5`, see library-row-meta.tsx and
 * focus/page.tsx). So the constraint is `IS NULL OR >= 1`, not the plain
 * `>= 1` Step gets, and the asymmetry is the point rather than an oversight.
 *
 * One writer exists today — `setItemEstimate`, which clamps to [1, 600] and
 * drops non-finite input — so the invariant holds. It holds only because that
 * one call site stays correct, and a second writer added later (a CSV import, a
 * bulk edit, an AI-suggested estimate) inherits no protection. The constraint
 * is what makes the guarantee structural.
 *
 * Division of labour, same as #78's pair of files:
 *   - enum-constraint-sync.integration.test.ts (RANGE_REGISTRY) polices that
 *     the constraint is APPLIED, pins its bound, and requires the IS NULL
 *     allowance to be present.
 *   - this file proves it BITES. The inserts below deliberately bypass every
 *     application clamp (raw SQL, not the Prisma client's typed create) so the
 *     only thing that can reject them is the database.
 *
 * Needs the real Postgres (CI wires up a service DB and runs
 * `prisma migrate deploy` first; locally it uses your DATABASE_URL schema —
 * vitest does NOT read .env):
 *   set -a; . ./.env; set +a; npm run test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { WorkspaceKind, BrainDumpStatus } from "@/lib/constants";

// Dedicated client + a unique, never-reused test workspace id, wiped before and
// after — same isolation approach as step-est-minutes-check /
// delete-braindump-item.integration.test.ts, so $disconnect() here can't tear
// the connection out from under sibling integration tests.
const prisma = new PrismaClient();
const WS = "test-80-estminutes-ws";

async function wipe() {
  await prisma.brainDumpItem.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

/**
 * Insert a BrainDumpItem straight through SQL. Deliberately raw:
 * `prisma.brainDumpItem.create` would still go through the client, and the one
 * real writer clamps before it gets there — a raw INSERT is the closest thing
 * to "a future writer that forgot", which is exactly what the constraint has to
 * stop.
 *
 * `estMinutes` is passed as `number | null` so the null case exercises the same
 * statement shape as the numeric ones. Parameterised ($1..$5) rather than
 * interpolated, so it can't be read as a SQL-injection pattern and matches how
 * the other raw queries in the tree are written.
 */
function insertItem(id: string, estMinutes: number | null) {
  return prisma.$executeRawUnsafe(
    `INSERT INTO "BrainDumpItem" ("id", "workspaceId", "text", "status", "estMinutes")
     VALUES ($1, $2, $3, $4, $5)`,
    id,
    WS,
    "raw insert",
    BrainDumpStatus.Inbox,
    estMinutes,
  );
}

describe("BrainDumpItem.estMinutes IS NULL OR >= 1 is enforced by the database (#80)", () => {
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

  // Zero and negative are exactly as wrong here as they were on Step (#78): a
  // zero-minute estimate renders as "≈0 min" and reads to the user as a
  // finished-instantly task, and a negative one sorts and sums as if it gave
  // time back. Both must be rejected by the DB with a check_violation (23514)
  // naming the constraint — not silently coerced.
  it.each([
    { label: "zero (estMinutes = 0)", value: 0 },
    { label: "negative (estMinutes = -5)", value: -5 },
  ])("rejects a raw insert with a $label estimate", async ({ value }) => {
    await expect(insertItem(`test-80-${value}`, value)).rejects.toThrow(
      /BrainDumpItem_estMinutes_check/,
    );

    // And nothing was written — the whole statement rolled back.
    const survivors = await prisma.brainDumpItem.count({
      where: { workspaceId: WS, estMinutes: { lt: 1 } },
    });
    expect(survivors).toBe(0);
  });

  it("accepts the boundary value estMinutes = 1", async () => {
    await expect(insertItem("test-80-boundary", 1)).resolves.toBe(1);

    const row = await prisma.brainDumpItem.findUnique({
      where: { id: "test-80-boundary" },
    });
    expect(row?.estMinutes).toBe(1);
  });

  // The half of this constraint that Step's does NOT have, and the reason #80
  // was a decision rather than a copy-paste. A plain `>= 1` would have made
  // every item without an estimate unwritable, breaking `createItem` — which
  // omits the column entirely — on its first insert.
  it("still accepts a NULL estimate (null means 'no estimate given')", async () => {
    await expect(insertItem("test-80-null", null)).resolves.toBe(1);

    const row = await prisma.brainDumpItem.findUnique({
      where: { id: "test-80-null" },
    });
    expect(row?.estMinutes).toBeNull();
  });

  // The path a real user takes: `createItem` never sets estMinutes, so the
  // column defaults to NULL. If the constraint were wrong, the app's most
  // common write would 500 — this asserts the typed client path survives it,
  // not just a hand-built INSERT.
  it("still accepts a client-side create that omits estMinutes", async () => {
    const created = await prisma.brainDumpItem.create({
      data: { id: "test-80-omitted", text: "typed create", workspaceId: WS },
    });
    expect(created.estMinutes).toBeNull();
  });
});
