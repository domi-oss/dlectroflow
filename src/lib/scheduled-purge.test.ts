import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  purgeWorkspace,
  purgeExpiredGuests,
  purgeStaleGuestCounters,
  runScheduledPurge,
} from "../../prisma/scheduled-purge";

// A minimal fake Prisma surface for the purge entrypoint. Array-based
// $transaction resolves each queued delegate call, mirroring the real
// prisma.$transaction([...]) contract.
function makeDb() {
  return {
    $transaction: vi.fn((ops: readonly Promise<unknown>[]) => Promise.all(ops)),
    workspace: { findMany: vi.fn(), delete: vi.fn() },
    guestDailyActivity: { deleteMany: vi.fn() },
    guestAiUsage: { deleteMany: vi.fn() },
  };
}

// ── Regression guard for the !85 Critical ──────────────────────────────────
// The CronJob runs `npx tsx prisma/scheduled-purge.ts` inside the standalone
// production image, which contains ONLY prisma/ + the traced node_modules —
// no app source (src/) and no `@/` path-alias resolver. An import that reaches
// into src/ makes the entrypoint dead-on-arrival in prod. These tests fail if
// anyone reintroduces such an import.
describe("scheduled-purge entrypoint is self-contained", () => {
  const src = readFileSync(
    new URL("../../prisma/scheduled-purge.ts", import.meta.url),
    "utf8",
  );

  it("does not import app source (no @/ alias, no ../src) — absent from the standalone image", () => {
    expect(src).not.toMatch(/from\s+["']@\//);
    expect(src).not.toMatch(/from\s+["']\.\.[\\/](?:\.\.[\\/])*src/);
  });

  it("has @prisma/client as its only package import (present in traced node_modules)", () => {
    const specifiers = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    const packages = specifiers.filter(
      (s) => !s.startsWith(".") && !s.startsWith("node:"),
    );
    expect(packages).toEqual(["@prisma/client"]);
  });
});

describe("purgeWorkspace", () => {
  it("refuses to delete the owner workspace", async () => {
    const db = makeDb();
    await expect(purgeWorkspace(db, "owner")).rejects.toThrow(/owner/i);
    expect(db.workspace.delete).not.toHaveBeenCalled();
  });

  it("deletes a guest workspace (cascade removes scoped rows at the DB level)", async () => {
    const db = makeDb();
    await purgeWorkspace(db, "guest-123");
    expect(db.workspace.delete).toHaveBeenCalledWith({ where: { id: "guest-123" } });
    expect(db.workspace.delete).toHaveBeenCalledTimes(1);
  });
});

describe("purgeExpiredGuests", () => {
  it("finds guest workspaces past their TTL (bounded), deletes each, returns the count", async () => {
    const db = makeDb();
    db.workspace.findMany.mockResolvedValue([{ id: "g1" }, { id: "g2" }]);
    const n = await purgeExpiredGuests(db);
    expect(n).toBe(2);
    expect(db.workspace.delete).toHaveBeenCalledTimes(2);
    expect(db.workspace.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ kind: "guest" }),
        take: 25,
      }),
    );
  });

  it("is best-effort: a per-row delete failure is skipped, not fatal", async () => {
    const db = makeDb();
    db.workspace.findMany.mockResolvedValue([{ id: "g1" }, { id: "g2" }]);
    db.workspace.delete.mockRejectedValueOnce(new Error("row locked"));
    const n = await purgeExpiredGuests(db);
    expect(n).toBe(1);
  });
});

describe("purgeStaleGuestCounters", () => {
  it("deletes daily-activity + ai-usage older than 30 days (default) in one transaction", async () => {
    const db = makeDb();
    db.guestDailyActivity.deleteMany.mockResolvedValue({ count: 5 });
    db.guestAiUsage.deleteMany.mockResolvedValue({ count: 3 });
    const now = new Date("2026-07-18T00:00:00Z");

    const result = await purgeStaleGuestCounters(db, now);

    // cutoff = now - 30 days = 2026-06-18
    expect(db.guestDailyActivity.deleteMany).toHaveBeenCalledWith({
      where: { day: { lt: "2026-06-18" } },
    });
    expect(db.guestAiUsage.deleteMany).toHaveBeenCalledWith({
      where: { updatedAt: { lt: new Date("2026-06-18T00:00:00Z") } },
    });
    expect(db.$transaction).toHaveBeenCalled();
    expect(result).toEqual({ dailyActivity: 5, aiUsage: 3 });
  });
});

describe("runScheduledPurge", () => {
  it("drains expired guests across batches, then purges counters, aggregating counts", async () => {
    const db = makeDb();
    // A full batch, then an empty batch → the drain loop terminates.
    db.workspace.findMany
      .mockResolvedValueOnce([{ id: "g1" }, { id: "g2" }])
      .mockResolvedValueOnce([]);
    db.guestDailyActivity.deleteMany.mockResolvedValue({ count: 4 });
    db.guestAiUsage.deleteMany.mockResolvedValue({ count: 1 });

    const result = await runScheduledPurge(db);

    expect(result).toEqual({ guestsPurged: 2, dailyActivity: 4, aiUsage: 1 });
    expect(db.workspace.findMany).toHaveBeenCalledTimes(2);
  });
});
