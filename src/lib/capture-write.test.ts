/**
 * #175 — the ONE capture write, shared by the server action and the route.
 *
 * The spec's reason for extracting this is worth restating, because it is the
 * whole point of the module: the foreground capture bar and the offline queue's
 * flush both go through `POST /api/braindump`, so there is **one write path and
 * one set of semantics to test**. `createBrainDumpItem` stays for its non-queued
 * callers (the breakdown ejector) and shares this core rather than carrying a
 * second copy of the note split, the empty guard and the streak touch.
 *
 * The inline-note parser is exercised exhaustively in
 * `braindump-note-syntax.test.ts` and the action's wiring to it in
 * `src/app/actions/capture-item.test.ts`; what is asserted here is the part only
 * this module decides — the three outcomes, and which of them earns a streak.
 *
 * Prisma is mocked. That the unique index actually BITES is a database fact and
 * is proved against real Postgres in
 * `braindump-client-key-unique.integration.test.ts` and
 * `src/app/api/braindump/route.integration.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { prismaMock, touchStreakOnEngagementMock } = vi.hoisted(() => ({
  prismaMock: {
    brainDumpItem: {
      createManyAndReturn: vi.fn(),
    },
  },
  touchStreakOnEngagementMock: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/rewards", () => ({
  touchStreakOnEngagement: touchStreakOnEngagementMock,
}));

import { writeCapture } from "./capture-write";
import { EngagementKind } from "@/lib/constants";

/** The row the winner of an `ON CONFLICT DO NOTHING` gets back. */
const wrote = () =>
  prismaMock.brainDumpItem.createManyAndReturn.mockResolvedValue([
    { id: "item-1" },
  ]);

/** What the LOSER gets back: no exception, and no row (see `src/lib/db.ts`). */
const skipped = () =>
  prismaMock.brainDumpItem.createManyAndReturn.mockResolvedValue([]);

/** The `data` the one write was called with. */
const writtenData = () =>
  prismaMock.brainDumpItem.createManyAndReturn.mock.calls[0][0].data as Record<
    string,
    unknown
  >;

beforeEach(() => {
  vi.clearAllMocks();
  wrote();
});

describe("writeCapture", () => {
  it("writes the capture and reports it created", async () => {
    expect(await writeCapture({ workspaceId: "ws-1", text: "buy milk" })).toBe(
      "created",
    );
    expect(writtenData()).toEqual({
      text: "buy milk",
      notes: null,
      workspaceId: "ws-1",
      clientKey: null,
    });
  });

  it("splits a trailing brace group into the note column (#179)", async () => {
    await writeCapture({
      workspaceId: "ws-1",
      text: "water the plants {can under sink}",
    });
    expect(writtenData()).toMatchObject({
      text: "water the plants",
      notes: "can under sink",
    });
  });

  it("normalises the note rather than letting the CHECK constraint refuse it", async () => {
    await writeCapture({
      workspaceId: "ws-1",
      text: "ring the dentist {09:00\r\n\x00sharp}",
    });
    expect(writtenData()).toMatchObject({ notes: "09:00\nsharp" });
  });

  it("carries the clientKey through to the column the index covers", async () => {
    await writeCapture({
      workspaceId: "ws-1",
      text: "buy milk",
      clientKey: "key-1",
    });
    expect(writtenData()).toMatchObject({
      clientKey: "key-1",
      workspaceId: "ws-1",
    });
  });

  it("scopes the write to the workspace it was given", async () => {
    // The scoping invariant, at the only place this module writes. The harness in
    // `src/lib/__tests__/scoping.harness.test.ts` enforces it structurally; this
    // asserts the value that actually travels.
    await writeCapture({ workspaceId: "ws-2", text: "buy milk" });
    expect(writtenData().workspaceId).toBe("ws-2");
  });

  it("tolerates a duplicate by not creating one, and never raises", async () => {
    // `INSERT … ON CONFLICT DO NOTHING`, the shape `src/lib/db.ts` argues for at
    // length: catching a P2002 would still print `prisma:error` before any catch
    // runs (#156, #158), so a replayed capture would report an incident.
    skipped();
    expect(
      await writeCapture({
        workspaceId: "ws-1",
        text: "buy milk",
        clientKey: "key-1",
      }),
    ).toBe("duplicate");
    expect(prismaMock.brainDumpItem.createManyAndReturn).toHaveBeenCalledTimes(
      1,
    );
  });

  it("asks Postgres to skip the duplicate rather than deciding in JS", async () => {
    await writeCapture({
      workspaceId: "ws-1",
      text: "buy milk",
      clientKey: "key-1",
    });
    const args = prismaMock.brainDumpItem.createManyAndReturn.mock.calls[0][0];
    expect(args.skipDuplicates).toBe(true);
  });

  it("no-ops on empty or whitespace-only text, before any write", async () => {
    expect(await writeCapture({ workspaceId: "ws-1", text: "   \n\t " })).toBe(
      "empty",
    );
    expect(prismaMock.brainDumpItem.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("reads the PARSED text for the empty guard, not the raw string", async () => {
    // `{just a note}` is refused by the parser and stored literally, so this
    // cannot create a row whose only content is hidden behind a note — and it is
    // NOT empty.
    expect(
      await writeCapture({ workspaceId: "ws-1", text: "{just a note}" }),
    ).toBe("created");
    expect(writtenData()).toMatchObject({
      text: "{just a note}",
      notes: null,
    });
  });

  it("counts a capture as one engagement, attributed to the row it wrote", async () => {
    await writeCapture({ workspaceId: "ws-1", text: "buy milk" });
    // #233 — `itemId` is the whole mechanism, not a detail: it is what lets the
    // engagement ledger withdraw this streak credit if the capture is later
    // deleted. Asserting only the workspace would pass for a credit written with
    // no attribution, which is silently permanent and un-revocable.
    expect(touchStreakOnEngagementMock).toHaveBeenCalledExactlyOnceWith(
      "ws-1",
      {
        kind: EngagementKind.Capture,
        itemId: "item-1",
      },
    );
  });

  it("does NOT advance the streak for a capture that was not written", async () => {
    // A duplicate is a capture the user already made — the engagement was banked
    // when the first copy landed. Advancing again would pay a retry for work the
    // streak has already counted.
    skipped();
    await writeCapture({
      workspaceId: "ws-1",
      text: "buy milk",
      clientKey: "key-1",
    });
    expect(touchStreakOnEngagementMock).not.toHaveBeenCalled();
  });

  it("does NOT advance the streak for an empty capture", async () => {
    await writeCapture({ workspaceId: "ws-1", text: "  " });
    expect(touchStreakOnEngagementMock).not.toHaveBeenCalled();
  });
});

/**
 * Duo review round 4 on `!334`: the streak touch is a SECOND statement, and it can
 * fail on its own once the insert has committed. Making the write idempotent is
 * what gave that its teeth — a retry now takes the `duplicate` arm above and never
 * reaches the streak, so nothing downstream can recover the credit.
 *
 * The reasoning, and the two alternatives that were rejected, are in
 * `capture-write.ts` under "The streak touch is BEST-EFFORT". What is pinned here
 * is the behaviour: a committed row is reported as committed, the failure is
 * greppable, and the swallow covers the streak touch and nothing else.
 */
describe("writeCapture — a streak touch that fails AFTER the row landed", () => {
  // `Once`, never a sticky `mockRejectedValue`: the outer `beforeEach` calls
  // `vi.clearAllMocks()`, which clears recorded calls but NOT implementations, so
  // a sticky rejection would leak into every test declared after this block.
  const BOOM = "streak store went away";
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorLog.mockRestore());

  // THE interaction, stated as bluntly as it can be, and the same sentence
  // `shopping.test.ts` pins for `settleShopping`: the row is in the database, so
  // the caller is told the row is in the database.
  it("still reports the capture created, because the row is committed", async () => {
    touchStreakOnEngagementMock.mockRejectedValueOnce(new Error(BOOM));
    await expect(
      writeCapture({
        workspaceId: "ws-1",
        text: "buy milk",
        clientKey: "key-1",
      }),
    ).resolves.toBe("created");
    // Also proves the queued rejection was CONSUMED. An unconsumed `Once` shifts
    // every later test in this file by one, which presents as unrelated failures.
    expect(touchStreakOnEngagementMock).toHaveBeenCalledExactlyOnceWith(
      "ws-1",
      {
        kind: EngagementKind.Capture,
        itemId: "item-1",
      },
    );
  });

  it("does not write the row a second time trying to recover the credit", async () => {
    touchStreakOnEngagementMock.mockRejectedValueOnce(new Error(BOOM));
    await writeCapture({
      workspaceId: "ws-1",
      text: "buy milk",
      clientKey: "key-1",
    });
    expect(prismaMock.brainDumpItem.createManyAndReturn).toHaveBeenCalledTimes(
      1,
    );
  });

  it("says so in the log, with a greppable tag and the workspace", async () => {
    touchStreakOnEngagementMock.mockRejectedValueOnce(new Error(BOOM));
    await writeCapture({
      workspaceId: "ws-1",
      text: "buy milk",
      clientKey: "key-1",
    });
    expect(errorLog).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(errorLog.mock.calls[0][0])) as {
      tag: string;
      workspaceId: string;
      message: string;
    };
    expect(line.tag).toBe("capture_streak_touch_failed");
    expect(line.workspaceId).toBe("ws-1");
    expect(line.message).toContain(BOOM);
  });

  // ── When the LOGGER itself cannot do its job (Duo review round 10) ────────
  //
  // The docblock promises "swallowed is not invisible … the failure gets one
  // greppable line", and the logger's own `catch` was empty — so the one case this
  // function exists to make visible was a case it could silently fail to report.
  //
  // ⚠️ **The rejection value has to be one that genuinely breaks the logger, and
  // the value the finding suggested does not.** A circular object cannot make this
  // `JSON.stringify` throw, because nothing circular ever reaches it: `message` is
  // resolved to a STRING first, and the object handed to `stringify` holds four
  // strings. A test written with a circular value passes against the silent catch
  // and proves nothing — see the CONTROL below, which pins that so the next reader
  // does not "improve" these cases into that one.
  //
  // These two do reach it, on two different lines:
  //  * a null-prototype object has no `toString` and no `valueOf`, so `String()`
  //    raises `TypeError: Cannot convert object to primitive value`;
  //  * a throwing `message` getter raises during the property read, before
  //    `String()` is even reached.
  it.each([
    ["a null-prototype rejection, where String() throws", Object.create(null)],
    [
      "a hostile message getter, which throws during the read",
      {
        get message() {
          throw new TypeError("hostile getter");
        },
      },
    ],
  ])("still emits the tag for %s", async (_why, rejection) => {
    touchStreakOnEngagementMock.mockRejectedValueOnce(rejection);

    await expect(
      writeCapture({ workspaceId: "ws-1", text: "buy milk" }),
    ).resolves.toBe("created");

    // Not the JSON line — a plain tag and workspace, which is the point: the
    // fallback must not do the thing that just failed.
    expect(errorLog).toHaveBeenCalledWith(
      "capture_streak_touch_failed",
      "ws-1",
    );
  });

  // The end of the line, and a guard on the fix rather than on the original bug:
  // the fallback calls `console.error` again, so if `console.error` is what threw
  // in the first place it will throw again. That must not escape, or the logger
  // takes down the very request it exists to protect.
  it("never throws, even when console.error itself throws", async () => {
    errorLog.mockImplementation(() => {
      throw new Error("stderr is gone");
    });
    touchStreakOnEngagementMock.mockRejectedValueOnce(new Error(BOOM));

    await expect(
      writeCapture({ workspaceId: "ws-1", text: "buy milk" }),
    ).resolves.toBe("created");
  });

  // CONTROL. Pins the claim above rather than leaving it as prose: a circular
  // rejection value takes the STRUCTURED path, so it is not evidence about the
  // fallback and must not be used as a fixture for it.
  it("CONTROL: a circular rejection still takes the structured path", async () => {
    const circular: Record<string, unknown> = { message: BOOM };
    circular.self = circular;
    touchStreakOnEngagementMock.mockRejectedValueOnce(circular);

    await writeCapture({ workspaceId: "ws-1", text: "buy milk" });

    expect(errorLog).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(errorLog.mock.calls[0][0])) as {
      tag: string;
      message: string;
    };
    expect(line.tag).toBe("capture_streak_touch_failed");
    expect(line.message).toBe(BOOM);
  });

  // The other direction, and the reason the `try` wraps ONE statement: the
  // swallow covers the streak touch, not the write. An insert that failed has
  // saved nothing, so the caller must hear about it — that is what keeps the
  // capture queued and the words recoverable.
  it("an insert that fails still rejects — those words are NOT saved", async () => {
    prismaMock.brainDumpItem.createManyAndReturn.mockRejectedValueOnce(
      new Error("connection refused"),
    );
    await expect(
      writeCapture({ workspaceId: "ws-1", text: "buy milk" }),
    ).rejects.toThrow("connection refused");
    expect(touchStreakOnEngagementMock).not.toHaveBeenCalled();
  });
});
