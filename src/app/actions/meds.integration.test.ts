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

async function seedWorkspace(id: string, doseId: string, medsTracker = true) {
  await db.workspace.create({ data: { id, kind: "user" } });
  // ⚠️ A `Settings` row with the tracker ON, because that is what an opted-in
  // workspace looks like and every spec below except the refusals is about one.
  // Before the flag gate landed there was no settings row here at all, which is
  // exactly the state the gate now refuses — so the fixture had to say out loud
  // what it had been assuming.
  await db.settings.create({ data: { id, workspaceId: id, medsTracker } });
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

/**
 * #269 — the feature gate on the write path, and why it is not tidiness.
 *
 * ⚠️ `Settings.medsTracker` defaults to `false` and `#269`'s own reasoning for
 * that is legal, not product: *"a workspace that has not opted in genuinely has
 * no health field"*. `!372` publishes that on /privacy as the Art. 9(2)(a)
 * position — the switch IS the consent act. **A write path that does not check
 * the switch makes the published sentence false**, because a stale client, a
 * cached page or a direct POST could store special-category data for a workspace
 * that never consented.
 *
 * `Medication` and `MedicationDose` rows outlive the toggle (hide-not-delete), so
 * a valid dose id for an opted-OUT workspace is not an exotic input — it is the
 * ordinary state of any workspace that has ever turned the tracker off.
 */
describe("logMedsDose — the feature gate", () => {
  it("REFUSES a valid own-workspace dose when the tracker is off, and writes NOTHING", async () => {
    await db.settings.update({
      where: { workspaceId: WS },
      data: { medsTracker: false },
    });
    expect(
      await logMedsDose({
        medicationDoseId: "itest-269-dose",
        state: MedsDoseState.Taken,
        date: TODAY,
      }),
    ).toEqual({ ok: false, reason: "tracker-off" });
    // The row count, not just the return value: an action that reported a
    // refusal and wrote anyway would satisfy a return-value assertion while
    // storing the health record the refusal exists to prevent.
    expect(await db.medsDoseLog.count()).toBe(0);
  });

  it("REFUSES when the workspace has no Settings row at all", async () => {
    // Fail closed. `getSettings()` creates the row on first use, so a workspace
    // that has never opened Settings has none — and "no row" is the strongest
    // possible statement that nobody opted in. A relation filter on a nullable
    // to-one matches nothing, which is the behaviour wanted rather than a
    // coincidence, so it is pinned.
    await db.settings.delete({ where: { workspaceId: WS } });
    expect(
      await logMedsDose({
        medicationDoseId: "itest-269-dose",
        state: MedsDoseState.Taken,
        date: TODAY,
      }),
    ).toEqual({ ok: false, reason: "tracker-off" });
    expect(await db.medsDoseLog.count()).toBe(0);
  });

  it("does not DELETE anything when the tracker is off — it only refuses", async () => {
    // ⚠️ Turning the tracker off HIDES and deletes nothing; that is settled and
    // it is in the privacy copy. So the gate must be a refusal on the way in,
    // never a sweep. History written while opted in survives opting out.
    await logMedsDose({
      medicationDoseId: "itest-269-dose",
      state: MedsDoseState.Taken,
      date: TODAY,
    });
    expect(await db.medsDoseLog.count()).toBe(1);

    await db.settings.update({
      where: { workspaceId: WS },
      data: { medsTracker: false },
    });
    await logMedsDose({
      medicationDoseId: "itest-269-dose",
      state: MedsDoseState.Skipped,
      date: TODAY,
    });
    const rows = await db.medsDoseLog.findMany({ where: { workspaceId: WS } });
    expect(rows).toHaveLength(1);
    // Untouched, not merely un-deleted: the refused write must not have
    // overwritten the state either.
    expect(rows[0].state).toBe(MedsDoseState.Taken);
  });

  it("writes again once the tracker is switched back on", async () => {
    // The non-zero control. A gate that refused everything would pass all three
    // specs above while making the feature inert.
    await db.settings.update({
      where: { workspaceId: WS },
      data: { medsTracker: false },
    });
    await logMedsDose({
      medicationDoseId: "itest-269-dose",
      state: MedsDoseState.Taken,
      date: TODAY,
    });
    expect(await db.medsDoseLog.count()).toBe(0);

    await db.settings.update({
      where: { workspaceId: WS },
      data: { medsTracker: true },
    });
    expect(
      await logMedsDose({
        medicationDoseId: "itest-269-dose",
        state: MedsDoseState.Taken,
        date: TODAY,
      }),
    ).toMatchObject({ ok: true });
    expect(await db.medsDoseLog.count()).toBe(1);
  });

  it("answers `tracker-off` distinctly from `unknown-dose`", async () => {
    // The two refusals are told apart deliberately. A reader whose tracker is off
    // needs to be sent to Settings; a caller holding a foreign id must learn
    // nothing. Collapsing them would either leak or mislead.
    await db.settings.update({
      where: { workspaceId: WS },
      data: { medsTracker: false },
    });
    const off = await logMedsDose({
      medicationDoseId: "itest-269-dose",
      state: MedsDoseState.Taken,
      date: TODAY,
    });
    await db.settings.update({
      where: { workspaceId: WS },
      data: { medsTracker: true },
    });
    const foreign = await logMedsDose({
      medicationDoseId: "itest-269-dose-other",
      state: MedsDoseState.Taken,
      date: TODAY,
    });
    expect(off).toEqual({ ok: false, reason: "tracker-off" });
    expect(foreign).toEqual({ ok: false, reason: "unknown-dose" });
  });

  it("still refuses a FOREIGN dose whose own workspace has the tracker on", async () => {
    // The gate must not become the only check. `OTHER_WS` is opted in, so a
    // gate that asked "is the tracker on for the dose's owner" instead of "for
    // the caller" would let this through — the two questions look alike and only
    // one of them is scoping.
    expect(
      await logMedsDose({
        medicationDoseId: "itest-269-dose-other",
        state: MedsDoseState.Taken,
        date: TODAY,
      }),
    ).toEqual({ ok: false, reason: "unknown-dose" });
    expect(await db.medsDoseLog.count()).toBe(0);
  });
});

describe("logMedsDose — the date the client supplies", () => {
  it("refuses a date that is not YYYY-MM-DD", async () => {
    // The round-trip validator's whole surface, including the shapes a
    // `/^\d{4}-\d{2}-\d{2}$/` pattern would also have refused and the two it
    // would NOT have: an expanded-year form, and a 32nd of a month that
    // `Date.UTC` rolls over silently.
    for (const bad of [
      "",
      "2026-8-1",
      "2026-08-1",
      "01/01/2026",
      "yesterday",
      "+002026-08-17",
      "2026-02-31",
      "2026-13-01",
      "275760-09-14",
    ]) {
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
    // ⚠️ The offsets come from the SERVER'S UTC DATE, not the local one, because
    // that is what the bound is defined against. Building them with `setDate` on
    // a local `Date` was a latent flake: measured at 00:18 local in BST the UTC
    // date is still yesterday, so "local tomorrow" is TWO days from the server's
    // and is correctly refused. It had passed every earlier run only because
    // those ran while the two dates agreed — the same shape as `#271`.
    const utcNow = new Date();
    const utcMidnight = Date.UTC(
      utcNow.getUTCFullYear(),
      utcNow.getUTCMonth(),
      utcNow.getUTCDate(),
    );
    for (const offset of [-1, 1]) {
      const date = new Date(utcMidnight + offset * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const result = await logMedsDose({
        medicationDoseId: "itest-269-dose",
        state: MedsDoseState.Taken,
        date,
      });
      expect(result, date).toEqual({ ok: true, state: MedsDoseState.Taken });
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

    /**
     * ⚠️ **Everything from here to the commit runs inside `try/finally`, and
     * that matters more than it looks.**
     *
     * The overlap assertion below is the CONTROL — it exists because a
     * concurrency test can pass without ever having raced. So its failure path
     * is the path that runs on the day something is genuinely wrong, and on the
     * first version that path threw before `release()`, leaving the holder's
     * transaction parked open inside its `$transaction` callback and its
     * dedicated client never disconnected. On a Postgres shared between
     * worktrees, a leaked open transaction holding a row lock makes unrelated
     * later suites HANG instead of failing fast.
     *
     * A control whose failure mode is worse than the defect it detects gets
     * deleted by whoever is debugging at the time, which would cost the whole
     * property. So it fails cleanly: one readable assertion, no residue.
     *
     * `second` is awaited in the `finally` too. It is a floating promise
     * otherwise, and on the failure path it is a rejection nobody handles —
     * blocked on a lock that is about to be released out from under it.
     */
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        release();
      }
    };
    let second: Promise<unknown> | undefined;

    try {
      // Wait for the holder to have actually inserted, so the lock exists.
      for (let i = 0; i < 200 && holderPid === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(
        holderPid,
        "the holding transaction never reported a backend pid",
      ).toBeGreaterThan(0);

      second = logMedsDose({
        medicationDoseId: "itest-269-dose",
        state: MedsDoseState.Skipped,
        date: TODAY,
      });

      // ⚠️ THE ASSERTION THAT MAKES THIS TEST MEAN ANYTHING. Without it the spec
      // passes for a run in which the two writes never met. `pg_blocking_pids`
      // names the holder's OWN backend rather than counting waiters, because
      // this Postgres is shared between worktrees and a database-wide count of
      // blocked sessions can be satisfied by somebody else's suite entirely.
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

      releaseOnce();
      await held;
      await expect(second).resolves.toMatchObject({
        ok: true,
        state: MedsDoseState.Skipped,
      });
    } finally {
      // Idempotent, so the happy path's own `release()` above is not undone and
      // the failure path still unparks the transaction.
      releaseOnce();
      // Settled, not just released: leaving these pending would hand the next
      // suite a connection still finishing someone else's work. `catch` on both
      // because on the failure path they may legitimately reject, and a cleanup
      // that throws would replace the real assertion message with its own.
      await held.catch(() => undefined);
      await second?.catch(() => undefined);
      await holder.$disconnect();
    }

    // One row, and it carries the LATER press. The loser adopted rather than
    // duplicating, which is what the unique index buys.
    const rows = await db.medsDoseLog.findMany({ where: { workspaceId: WS } });
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe(MedsDoseState.Skipped);
  }, 40_000);
});

/**
 * #269 — the date bound, driven at the boundary with an injected clock.
 *
 * ⚠️ Duo round 5 of `!364`. `logMedsDose` called `new Date()` inline, so the one
 * check that decides whether a submitted date is plausible was the only
 * untestable date logic in a feature whose whole derived-state model turns on
 * the local-vs-UTC day boundary. Every sibling already takes an injectable
 * clock; this closes the gap in the place it was most needed.
 *
 * These are the cases that were previously unreachable: they require the
 * server's clock to sit at a specific instant, and before this they could only
 * have been written by moving the machine's.
 */
/**
 * ⚠️ The eight clock-boundary cases that used to live here have MOVED DOWN to
 * `src/lib/meds.test.ts`, against the pure `isPlausibleLocalDate`.
 *
 * They were written here by injecting a `now` into the action — which a later
 * round found was a caller-controlled RPC parameter, letting a caller supply
 * both the date and the clock it is judged against. The action takes no clock
 * now, so these cases cannot be expressed at this level, and they should never
 * have been: the predicate is pure and the boundary is its property, not the
 * endpoint's. Nothing was lost, and the input surface shrank.
 *
 * What stays here is what the ACTION is responsible for: refusing a malformed or
 * far-off date at all, which needs no control over the clock.
 */

/**
 * #269 — the action's input surface, as a caller sees it.
 *
 * ⚠️ `"use server"` exports are POST endpoints. Next's own docs for this version:
 * *"the route is reachable to anyone who can send the same POST. Treat every
 * action as an untrusted entry point."* TypeScript stops the app's own UI from
 * passing an extra argument; it stops nothing at the wire. So the property worth
 * asserting is not "the parameter is gone from the type" but **"sending it has no
 * effect"**.
 */
describe("logMedsDose ignores anything a caller adds to the payload", () => {
  /** A caller's payload, past the compile-time shape. */
  const asWire = (payload: Record<string, unknown>) =>
    logMedsDose(payload as Parameters<typeof logMedsDose>[0]);

  it("cannot use a supplied clock to make a far-off date plausible", async () => {
    // The exploit the previous round's `now?: Date` opened: supply BOTH the date
    // and the clock it is judged against, and every date is one day from
    // "today". Measured against the fixed action — the clock is ignored and the
    // date is judged against the server's own.
    const longAgo = "2020-01-01";
    expect(
      await asWire({
        medicationDoseId: "itest-269-dose",
        state: MedsDoseState.Taken,
        date: longAgo,
        now: new Date("2020-01-01T12:00:00.000Z"),
      }),
    ).toEqual({ ok: false, reason: "bad-date" });
    // The row count, not just the answer: this is the assertion that would have
    // caught a fabricated health record.
    expect(await db.medsDoseLog.count()).toBe(0);
  });

  it("cannot shift the window forward either", async () => {
    const future = "2030-06-15";
    expect(
      await asWire({
        medicationDoseId: "itest-269-dose",
        state: MedsDoseState.Taken,
        date: future,
        now: new Date("2030-06-15T12:00:00.000Z"),
      }),
    ).toEqual({ ok: false, reason: "bad-date" });
    expect(await db.medsDoseLog.count()).toBe(0);
  });

  it("still accepts a genuine payload that happens to carry the extra key", async () => {
    // The non-zero control. A fix that refused any payload with an unexpected
    // key would pass both specs above while breaking every real caller on the
    // day someone adds a field.
    expect(
      await asWire({
        medicationDoseId: "itest-269-dose",
        state: MedsDoseState.Taken,
        date: TODAY,
        now: new Date("2020-01-01T12:00:00.000Z"),
      }),
    ).toMatchObject({ ok: true });
    expect(await db.medsDoseLog.count()).toBe(1);
  });

  it("cannot supply its own workspace", async () => {
    // The workspace comes from the session, never the payload — so a foreign id
    // in the wire payload is inert rather than honoured.
    expect(
      await asWire({
        medicationDoseId: "itest-269-dose-other",
        state: MedsDoseState.Taken,
        date: TODAY,
        workspaceId: OTHER_WS,
      }),
    ).toEqual({ ok: false, reason: "unknown-dose" });
    expect(await db.medsDoseLog.count()).toBe(0);
  });
});
