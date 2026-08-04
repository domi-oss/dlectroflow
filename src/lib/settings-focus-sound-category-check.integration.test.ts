/**
 * #70 — behavioural proof that the DB refuses a focus-sound category it cannot
 * mean.
 *
 * `Settings.focusSoundCategory` is a pseudo-enum mirroring `FocusSoundCategory`
 * in src/lib/constants.ts. `updateFocusTimerSettings` allowlist-validates before
 * writing, so the invariant holds today — but it holds only because that one
 * writer stays correct, and the value's job is to NARROW a playlist: a slug
 * nothing matches is the difference between "chillhop" and a silent focus
 * session, which is the failure the read side (`resolveFocusPlaylist`) has to
 * work around rather than a cosmetic one.
 *
 * `enum-constraint-sync.integration.test.ts` polices that the constraint is
 * APPLIED and mirrors the constant exactly. This file proves it BITES: the writes
 * below bypass the Prisma client's types with raw SQL, which is the only way an
 * out-of-set value can reach Postgres at all. A constraint added `NOT VALID`, or
 * dropped by a later migration and re-added to satisfy the sync test, would pass
 * there and fail here.
 *
 * Needs the real Postgres (CI wires up a service DB and runs
 * `prisma migrate deploy` first; locally it uses your DATABASE_URL schema —
 * vitest does NOT read .env):
 *   set -a; . ./.env; set +a; npm run test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { WorkspaceKind, FocusSoundCategory } from "@/lib/constants";

// Dedicated client + a unique, never-reused workspace id, wiped before and after
// — the same isolation approach as task-schedule-intent-check.integration
// .test.ts, so $disconnect() here cannot tear the connection out from under
// sibling integration tests.
const prisma = new PrismaClient();
const WS = "test-70-focus-sound-category-ws";

async function wipe() {
  await prisma.settings.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

/**
 * Write the column straight through SQL. Deliberately raw: `focusSoundCategory`
 * is typed `string | null` by Prisma, so no generated type stops `"ambient"` —
 * only the constraint does, and "a future writer that used the slug #70's first
 * version invented" is exactly the case it has to stop.
 */
function setCategory(value: string | null) {
  return prisma.$executeRawUnsafe(
    `UPDATE "Settings" SET "focusSoundCategory" = $1 WHERE "workspaceId" = $2`,
    value,
    WS,
  );
}

describe("Settings.focusSoundCategory CHECK constraint is enforced by the database (#70)", () => {
  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({
      data: { id: WS, kind: WorkspaceKind.Guest },
    });
    await prisma.settings.create({ data: { id: WS, workspaceId: WS } });
  });

  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it("defaults to NULL — the whole list, which is what every existing row means", async () => {
    const row = await prisma.settings.findUnique({
      where: { workspaceId: WS },
    });
    expect(row?.focusSoundCategory).toBeNull();
  });

  it.each(Object.values(FocusSoundCategory))("accepts '%s'", async (slug) => {
    await expect(setCategory(slug)).resolves.toBe(1);
    const row = await prisma.settings.findUnique({
      where: { workspaceId: WS },
    });
    expect(row?.focusSoundCategory).toBe(slug);
  });

  it("accepts NULL again — clearing the selection must stay possible", async () => {
    await expect(setCategory(FocusSoundCategory.Chillhop)).resolves.toBe(1);
    await expect(setCategory(null)).resolves.toBe(1);
    const row = await prisma.settings.findUnique({
      where: { workspaceId: WS },
    });
    expect(row?.focusSoundCategory).toBeNull();
  });

  // The first three are the slugs #70's own description carried before it was
  // corrected against the code, so they are the realistic wrong values rather
  // than invented ones. `lofi_chillhop` is the paired mistake in the other
  // direction: a TRACK id written into the CATEGORY column.
  it.each([
    "ambient",
    "asian",
    "seasonal",
    "lofi_chillhop",
    "category:chillhop",
    "",
    "CHILLHOP",
  ])("rejects '%s'", async (bad) => {
    await expect(setCategory(bad)).rejects.toThrow(
      /violates check constraint/i,
    );
  });
});
