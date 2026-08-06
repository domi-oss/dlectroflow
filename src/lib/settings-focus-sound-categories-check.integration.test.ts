/**
 * #180 — behavioural proof that the DB refuses a focus-sound category it cannot
 * mean, and that a brand-new row opens with sound on.
 *
 * `Settings.focusSoundCategories` is a `text[]` whose every element must be one
 * of `FocusSoundCategory` in src/lib/constants.ts, enforced by a CONTAINMENT
 * check (`<@`). It replaces #70's single nullable `focusSoundCategory`, and it
 * keeps that column's guarantee rather than trading it away for a JSON blob:
 * `updateFocusTimerSettings` allowlist-validates before writing, but the
 * invariant holds today only because that one writer stays correct, and the
 * value's job is to NARROW a playlist — a slug nothing matches is the difference
 * between "chillhop" and a silent focus session.
 *
 * `enum-constraint-sync.integration.test.ts` polices that the constraint is
 * APPLIED and mirrors the constant exactly. This file proves it BITES: the
 * writes below bypass the Prisma client's types with raw SQL, which is the only
 * way an out-of-set value can reach Postgres at all. A constraint added
 * `NOT VALID`, or dropped by a later migration and re-added to satisfy the sync
 * test, would pass there and fail here.
 *
 * Needs the real Postgres (CI wires up a service DB and runs
 * `prisma migrate deploy` first; locally it uses your DATABASE_URL schema —
 * vitest does NOT read .env):
 *   set -a; . ./.env; set +a; npm run test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { WorkspaceKind, FocusSound, FocusSoundCategory } from "@/lib/constants";

// Dedicated client + a unique, never-reused workspace id, wiped before and after
// — the same isolation approach as task-schedule-intent-check.integration
// .test.ts, so $disconnect() here cannot tear the connection out from under
// sibling integration tests.
const prisma = new PrismaClient();
const WS = "test-180-focus-sound-categories-ws";

async function wipe() {
  await prisma.settings.deleteMany({ where: { workspaceId: WS } });
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

/**
 * Write the column straight through SQL. Deliberately raw: Prisma types the
 * field `string[]`, so nothing generated stops `["ambient"]` — only the
 * constraint does, and "a future writer that used the slug #70's first version
 * invented" is exactly the case it has to stop.
 */
function setCategories(values: string[]) {
  return prisma.$executeRawUnsafe(
    `UPDATE "Settings" SET "focusSoundCategories" = $1::text[] WHERE "workspaceId" = $2`,
    values,
    WS,
  );
}

describe("Settings.focusSoundCategories CHECK constraint is enforced by the database (#180)", () => {
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

  // #180 — a new account hears music without going looking for it. The three
  // defaults are one decision, so they are asserted together: sound on, the
  // ambient lo-fi playlist (21 tracks against chillhop's 8, so it repeats least,
  // and the least intrusive of the ten for someone who did not ask for music),
  // shuffled.
  it("a new row defaults to sound on, the ambient lo-fi playlist, shuffled", async () => {
    const row = await prisma.settings.findUnique({
      where: { workspaceId: WS },
    });
    expect(row?.focusSound).toBe(FocusSound.On);
    expect(row?.focusSoundCategories).toEqual([FocusSoundCategory.AmbientLofi]);
    expect(row?.focusShuffle).toBe(true);
  });

  it.each(Object.values(FocusSoundCategory))(
    "accepts ['%s'] on its own",
    async (slug) => {
      await expect(setCategories([slug])).resolves.toBe(1);
      const row = await prisma.settings.findUnique({
        where: { workspaceId: WS },
      });
      expect(row?.focusSoundCategories).toEqual([slug]);
    },
  );

  it("accepts every category at once — the multi-select this column exists for", async () => {
    const all = Object.values(FocusSoundCategory) as string[];
    await expect(setCategories(all)).resolves.toBe(1);
    const row = await prisma.settings.findUnique({
      where: { workspaceId: WS },
    });
    expect(row?.focusSoundCategories).toEqual(all);
  });

  // Empty is the whole catalogue, and it is the ONLY "nothing narrowed" state:
  // #70's NULL is gone, so there is exactly one way to express it and exactly
  // one way to get silence (the switch).
  it("accepts the empty array — the whole catalogue, and the only unnarrowed state", async () => {
    await expect(setCategories([FocusSoundCategory.Chillhop])).resolves.toBe(1);
    await expect(setCategories([])).resolves.toBe(1);
    const row = await prisma.settings.findUnique({
      where: { workspaceId: WS },
    });
    expect(row?.focusSoundCategories).toEqual([]);
  });

  // The column is NOT NULL for a reason the containment operator makes
  // non-obvious: `NULL <@ ARRAY[…]` evaluates to NULL, and a CHECK passes on
  // NULL. Without NOT NULL a raw write could park an unvalidated NULL in a
  // column Prisma types as `string[]`, and every reader would get a runtime
  // shape its types said was impossible.
  it("rejects a NULL column value — containment cannot validate a NULL", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Settings" SET "focusSoundCategories" = NULL WHERE "workspaceId" = $1`,
        WS,
      ),
      // Matched on the SQLSTATE rather than the prose: Prisma reports a
      // not-null violation as `Code: 23502` plus a "Failing row contains …"
      // dump, and never repeats Postgres's own "null value in column" wording.
    ).rejects.toThrow(/\b23502\b/);
  });

  // The first three are the slugs #70's own description carried before it was
  // corrected against the code, so they are the realistic wrong values rather
  // than invented ones. `lofi_chillhop` is the paired mistake in the other
  // direction: a TRACK id written into the CATEGORY column — and after #180 a
  // track id has no persistable home at all, which makes it likelier, not less.
  it.each([
    ["ambient"],
    ["asian"],
    ["seasonal"],
    ["lofi_chillhop"],
    ["category:chillhop"],
    [""],
    ["CHILLHOP"],
    // One good slug alongside one bad one: containment is per-element, so a
    // partially-valid array must be rejected whole rather than quietly stored.
    ["chillhop", "ambient"],
  ])("rejects %j", async (...bad) => {
    await expect(setCategories(bad)).rejects.toThrow(
      /violates check constraint/i,
    );
  });

  // A NULL *element* is a different failure from a NULL column and Postgres
  // happens to reject it too (`<@` is per-element equality, and the comparison
  // against a NULL member yields false, not NULL). Pinned because relying on it
  // is what let the constraint stay in its simple form.
  it("rejects a NULL element inside an otherwise valid array", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Settings" SET "focusSoundCategories" = ARRAY['chillhop', NULL]::text[] WHERE "workspaceId" = $1`,
        WS,
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  // #180 narrowed Settings_focusSound_check from the eleven-value #43 track set
  // to two. A stored track id is the value the migration converted away from, so
  // it is the one that must now bounce.
  it("Settings.focusSound accepts only off | on", async () => {
    for (const value of Object.values(FocusSound)) {
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "Settings" SET "focusSound" = $1 WHERE "workspaceId" = $2`,
          value,
          WS,
        ),
      ).resolves.toBe(1);
    }
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Settings" SET "focusSound" = 'lofi_chillhop' WHERE "workspaceId" = $1`,
        WS,
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  // #70's column is gone, not merely unused. Leaving it would give a future
  // writer a second, unconstrained place to record the same preference.
  it("the #70 focusSoundCategory column no longer exists", async () => {
    // Scoped to the connected schema, not the whole database: a shared local
    // Postgres carries one schema per parallel worktree, and an unscoped count
    // reports another branch's columns as this branch's drift.
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*) AS count
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'Settings'
          AND column_name = 'focusSoundCategory'`,
    );
    expect(Number(rows[0].count)).toBe(0);
  });
});
