/**
 * #269 — real-Postgres proof for the dose-logging write.
 *
 * Three properties, and none of them can be shown with a mock:
 *
 *  1. **A dose id belonging to another workspace cannot be logged**, even when
 *     the caller supplies a valid one. `MedsDoseLog.workspaceId` is
 *     denormalised so the today-strip can read by date without joining, and the
 *     unique index does NOT close the hole that opens: nothing in
 *     `(workspaceId, date, medicationDoseId)` stops workspace A's id being paired
 *     with workspace B's dose, because the foreign key proves the dose exists,
 *     not that it belongs here. The write path's own filter is the whole defence
 *     and this is what proves it is armed.
 *  2. **A double-tap writes one row.** ⚠️ Proved with an ARRANGED overlap rather
 *     than `Promise.all`, and the overlap itself is asserted. A warm connection
 *     pool serialises two concurrent calls often enough that a green from
 *     `Promise.all` is not evidence — measured on
 *     `braindump-task-writers.integration.test.ts` (#225), where the same shape
 *     passed against one unfixed writer and failed against another in the same
 *     run. So the first write is parked INSIDE its transaction, the second is
 *     required to block on it via `pg_blocking_pids`, and only then is the first
 *     committed.
 *  3. **An overwrite is an overwrite, not a second row.** `skipped` → `taken` on
 *     the strip is the documented correction path for a dose the nav shortcut
 *     cannot walk back, so it has to land on the same row.
 *
 * Isolation mirrors `keep-as-task.integration.test.ts`: a dedicated
 * `PrismaClient` for setup and assertions so this file's queries cannot disturb
 * the singleton the action uses, and never-reused workspace ids wiped at both
 * ends.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { PrismaClient } from "@prisma/client";
import { MedsDoseState } from "@/lib/constants";

const WS = vi.hoisted(() => "itest-269-meds");
/** A second workspace, so the IDOR spec proves the write's own scope. */
const OTHER_WS = vi.hoisted(() => "itest-269-meds-other");

vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: vi.fn().mockResolvedValue(WS),
  currentUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { logMedsDose } = await import("@/app/actions/meds");

const db = new PrismaClient();

/** Today in the caller's local time, which is what the client sends. */
function localYmd(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

const TODAY = localYmd();

async function seedWorkspace(id: string, doseId: string) {
  await db.workspace.create({ data: { id, kind: "user" } });
  await db.medication.create({
    data: {
      id: `${id}-med`,
      workspaceId: id,
      name: "Ritalin",
      order: 1,
      doses: {
        create: {
          id: doseId,
          label: "after breakfast",
          quantity: 2,
          order: 1,
        },
      },
    },
  });
}

async function wipe() {
  // The Workspace cascade takes Medication, MedicationDose and MedsDoseLog.
  await db.workspace.deleteMany({ where: { id: { in: [WS, OTHER_WS] } } });
}

beforeAll(wipe);
afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

beforeEach(async () => {
  await wipe();
  await seedWorkspace(WS, "itest-269-dose");
  await seedWorkspace(OTHER_WS, "itest-269-dose-other");
});

describe("logMedsDose — workspace scoping", () => {
  it("writes the row for a dose the resolved workspace owns", async () => {
    const result = await logMedsDose({
      medicationDoseId: "itest-269-dose",
      state: MedsDoseState.Taken,
      date: TODAY,
    });
    expect(result).toEqual({ ok: true, state: MedsDoseState.Taken });

    const rows = await db.medsDoseLog.findMany({ where: { workspaceId: WS } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: TODAY,
      medicationDoseId: "itest-269-dose",
      state: MedsDoseState.Taken,
      workspaceId: WS,
    });
  });

  it("REFUSES a valid dose id belonging to another workspace", async () => {
    const result = await logMedsDose({
      medicationDoseId: "itest-269-dose-other",
      state: MedsDoseState.Taken,
      date: TODAY,
    });
    expect(result).toEqual({ ok: false, reason: "unknown-dose" });

    // Neither workspace gained a row: not the caller's (the foreign id was
    // refused) and not the owner's (nothing writes across a boundary).
    expect(await db.medsDoseLog.count()).toBe(0);
  });

  it("refuses a dose id that does not exist at all", async () => {
    expect(
      await logMedsDose({
        medicationDoseId: "no-such-dose",
        state: MedsDoseState.Taken,
        date: TODAY,
      }),
    ).toEqual({ ok: false, reason: "unknown-dose" });
    expect(await db.medsDoseLog.count()).toBe(0);
  });
});

describe("logMedsDose — the date the client supplies", () => {
  it("refuses a date that is not YYYY-MM-DD", async () => {
    for (const bad of ["", "2026-8-1", "01/01/2026", "yesterday"]) {
      expect(
        await logMedsDose({
          medicationDoseId: "itest-269-dose",
          state: MedsDoseState.Taken,
          date: bad,
        }),
      ).toEqual({ ok: false, reason: "bad-date" });
    }
    expect(await db.medsDoseLog.count()).toBe(0);
  });

  it("refuses a date more than one day from the server's own", async () => {
    // The client sends its LOCAL day because the server cannot know the
    // reader's timezone — but that must not become a backfill API. Real offsets
    // span UTC-12..UTC+14, so a genuine local date is at most one day either
    // side of the server's UTC date; anything further is a fabricated history.
    const far = new Date();
    far.setDate(far.getDate() - 30);
    expect(
      await logMedsDose({
        medicationDoseId: "itest-269-dose",
        state: MedsDoseState.Taken,
        date: localYmd(far),
      }),
    ).toEqual({ ok: false, reason: "bad-date" });
    expect(await db.medsDoseLog.count()).toBe(0);
  });

  it("accepts the neighbouring days, which a real timezone can produce", async () => {
    // The non-zero control for the bound above: too tight a window would refuse
    // the reader in Auckland at 09:00 or the one in Honolulu at 22:00.
    for (const offset of [-1, 1]) {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      const result = await logMedsDose({
        medicationDoseId: "itest-269-dose",
        state: MedsDoseState.Taken,
        date: localYmd(d),
      });
      expect(result).toEqual({ ok: true, state: MedsDoseState.Taken });
    }
    expect(await db.medsDoseLog.count()).toBe(2);
  });

  it("refuses a state outside the value set before the CHECK has to", async () => {
    expect(
      await logMedsDose({
        medicationDoseId: "itest-269-dose",
        // `missed` is the one an implementer reaches for, and it is DERIVED.
        state:
          "missed" as unknown as (typeof MedsDoseState)[keyof typeof MedsDoseState],
        date: TODAY,
      }),
    ).toEqual({ ok: false, reason: "bad-state" });
    expect(await db.medsDoseLog.count()).toBe(0);
  });
});

describe("logMedsDose — idempotency and correction", () => {
  it("overwrites skipped with taken on the SAME row", async () => {
    await logMedsDose({
      medicationDoseId: "itest-269-dose",
      state: MedsDoseState.Skipped,
      date: TODAY,
    });
    const first = await db.medsDoseLog.findFirstOrThrow({
      where: { workspaceId: WS },
    });

    await logMedsDose({
      medicationDoseId: "itest-269-dose",
      state: MedsDoseState.Taken,
      date: TODAY,
    });
    const rows = await db.medsDoseLog.findMany({ where: { workspaceId: WS } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].state).toBe(MedsDoseState.Taken);
    // `markedAt` moves, because the correction is when the reader actually said
    // this — and v2's history is about what they told it, not when the first
    // guess was made.
    expect(rows[0].markedAt.getTime()).toBeGreaterThanOrEqual(
      first.markedAt.getTime(),
    );
  });

  it("writes ONE row for two writes that genuinely overlap", async () => {
    // ── The forced overlap ─────────────────────────────────────────────────
    //
    // A `Promise.all` here would prove nothing: a warm pool serialises the pair
    // often enough that a green is not evidence. So the first insert is parked
    // INSIDE an uncommitted transaction — at which point Postgres holds a
    // speculative-insertion lock on the unique index — and the second call is
    // required to BLOCK on it before the first is allowed to commit.
    const holder = new PrismaClient();
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });

    let holderPid = 0;
    const held = holder.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<{ pid: number }[]>`
          SELECT pg_backend_pid()::int AS pid`;
        holderPid = row.pid;
        await tx.medsDoseLog.create({
          data: {
            workspaceId: WS,
            date: TODAY,
            medicationDoseId: "itest-269-dose",
            state: MedsDoseState.Taken,
          },
        });
        // Parked INSIDE the transaction, not at its boundary: releasing after
        // the callback returns would let the commit land first and there would
        // be no lock left for the second write to contend with.
        await parked;
      },
      { timeout: 20_000, maxWait: 10_000 },
    );

    // Wait for the holder to have actually inserted, so the lock exists.
    for (let i = 0; i < 200 && holderPid === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(
      holderPid,
      "the holding transaction never reported a backend pid",
    ).toBeGreaterThan(0);

    const second = logMedsDose({
      medicationDoseId: "itest-269-dose",
      state: MedsDoseState.Skipped,
      date: TODAY,
    });

    // ⚠️ THE ASSERTION THAT MAKES THIS TEST MEAN ANYTHING. Without it the spec
    // passes for a run in which the two writes never met. `pg_blocking_pids`
    // names the holder's OWN backend rather than counting waiters, because this
    // Postgres is shared between worktrees and a database-wide count of blocked
    // sessions can be satisfied by somebody else's suite entirely.
    let overlapped = false;
    for (let i = 0; i < 200 && !overlapped; i += 1) {
      const [row] = await db.$queryRaw<{ blocked: bigint }[]>`
        SELECT count(*)::bigint AS blocked
        FROM pg_stat_activity
        WHERE pid <> ${holderPid}
          AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
      overlapped = Number(row.blocked) > 0;
      if (!overlapped) await new Promise((r) => setTimeout(r, 25));
    }
    expect(
      overlapped,
      "the second write never blocked on the first, so the two never raced " +
        "and this spec proves nothing about a double-tap",
    ).toBe(true);

    release();
    await held;
    await expect(second).resolves.toEqual({
      ok: true,
      state: MedsDoseState.Skipped,
    });
    await holder.$disconnect();

    // One row, and it carries the LATER press. The loser adopted rather than
    // duplicating, which is what the unique index buys.
    const rows = await db.medsDoseLog.findMany({ where: { workspaceId: WS } });
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe(MedsDoseState.Skipped);
  }, 40_000);
});
