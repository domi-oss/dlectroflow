/**
 * Integration proof for the once-per-day rollup-email claim (#18).
 *
 * The action's duplicate-send guard is only as strong as the underlying claim
 * being ATOMIC. This exercises `claimRollupEmail` against the real Postgres so
 * we know that N concurrent claims on the same (workspace, day) row resolve to
 * exactly one winner — the property the check-then-act version lacked.
 *
 * Needs DATABASE_URL from .env (not auto-loaded by vitest):
 *   set -a; . ./.env; set +a; npm run test
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { claimRollupEmail, releaseRollupEmailClaim } from "@/lib/rollup";

// Test-only workspace id so this never touches the real "owner" rollup rows.
const WS = "test-rollup-claim-ws";
const DATE = "2026-01-01";

async function seedUnclaimedRollup() {
  // The workspace-cascade FK migration (#21) requires the parent Workspace row
  // to exist before any workspace-scoped row (DayRollup) can reference it — as
  // it always does in the app, where a workspace is created before its rollups.
  await prisma.workspace.upsert({
    where: { id: WS },
    create: { id: WS, kind: "guest" },
    update: {},
  });
  await prisma.dayRollup.deleteMany({ where: { workspaceId: WS } });
  await prisma.dayRollup.create({
    data: { workspaceId: WS, date: DATE, narrative: "x", emailedAt: null },
  });
}

describe("claimRollupEmail atomic once-per-day claim (#18)", () => {
  beforeEach(seedUnclaimedRollup);
  afterAll(async () => {
    // Deleting the workspace cascades its DayRollup rows via the #21 FK.
    await prisma.workspace.deleteMany({ where: { id: WS } });
    await prisma.$disconnect();
  });

  it("N concurrent claims on the same day resolve to exactly one winner", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimRollupEmail(WS, DATE)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);

    // The winning claim persisted the emailed marker.
    const row = await prisma.dayRollup.findUnique({
      where: { workspaceId_date: { workspaceId: WS, date: DATE } },
    });
    expect(row?.emailedAt).not.toBeNull();
  });

  it("a claim after the day is already claimed is rejected", async () => {
    expect(await claimRollupEmail(WS, DATE)).toBe(true);
    expect(await claimRollupEmail(WS, DATE)).toBe(false);
    expect(await claimRollupEmail(WS, DATE)).toBe(false);
  });

  it("releasing a claim (send failed) lets a retry re-claim the day", async () => {
    expect(await claimRollupEmail(WS, DATE)).toBe(true);
    await releaseRollupEmailClaim(WS, DATE);
    expect(await claimRollupEmail(WS, DATE)).toBe(true);
  });
});
