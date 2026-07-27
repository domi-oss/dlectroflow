/**
 * Unit tests for the #14 breakdown-coach context gather.
 *
 * The gather is the ONLY new egress path this feature adds: whatever it
 * returns is rendered into a prompt and shipped to whichever LLM the deploy is
 * configured with (#59 BYO-LLM — possibly a third-party endpoint). So these
 * tests are as much a security contract as a behaviour one:
 *   - every read is scoped to the REQUEST's workspace (never "owner" for a guest)
 *   - the path is read-only (no create/update/upsert — the route is a hot path
 *     and an upsert here would be a write on a read)
 *   - no free text, identifier, email, token or date is ever selected
 *   - any failure degrades to an empty context instead of failing the request
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    settings: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    streak: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    brainDumpItem: { findMany: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    step: { findMany: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const GUEST = "guest-abc";

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.settings.findUnique.mockResolvedValue(null);
  prismaMock.streak.findUnique.mockResolvedValue(null);
  prismaMock.brainDumpItem.findMany.mockResolvedValue([]);
  prismaMock.step.findMany.mockResolvedValue([]);
});

/** All the write-shaped mocks that must never be touched on this path. */
const WRITE_MOCKS = () => [
  prismaMock.settings.create,
  prismaMock.settings.update,
  prismaMock.settings.upsert,
  prismaMock.streak.create,
  prismaMock.streak.update,
  prismaMock.streak.upsert,
  prismaMock.brainDumpItem.update,
  prismaMock.brainDumpItem.upsert,
  prismaMock.step.update,
  prismaMock.step.upsert,
];

describe("gatherBreakdownContext — workspace scoping (IDOR)", () => {
  it("scopes every read to the workspace it was given", async () => {
    const { gatherBreakdownContext } = await import("./breakdown-context");
    await gatherBreakdownContext(GUEST);

    expect(prismaMock.settings.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: GUEST } }),
    );
    expect(prismaMock.streak.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: GUEST } }),
    );
    expect(prismaMock.brainDumpItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: GUEST }),
      }),
    );
    // Steps have no workspaceId of their own — they hang off Task, so the
    // scope must travel through the relation (same pattern as ejectStepToInbox).
    expect(prismaMock.step.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ task: { workspaceId: GUEST } }),
      }),
    );
  });

  it("never reads the owner's workspace on behalf of a guest", async () => {
    const { gatherBreakdownContext } = await import("./breakdown-context");
    await gatherBreakdownContext(GUEST);

    const everyCall = [
      ...prismaMock.settings.findUnique.mock.calls,
      ...prismaMock.streak.findUnique.mock.calls,
      ...prismaMock.brainDumpItem.findMany.mock.calls,
      ...prismaMock.step.findMany.mock.calls,
    ];
    expect(everyCall.length).toBe(4);
    for (const [args] of everyCall) {
      expect(JSON.stringify(args)).not.toContain('"owner"');
      expect(JSON.stringify(args)).toContain(GUEST);
    }
  });

  it("is read-only — never creates, updates or upserts anything", async () => {
    const { gatherBreakdownContext } = await import("./breakdown-context");
    await gatherBreakdownContext(GUEST);
    for (const m of WRITE_MOCKS()) expect(m).not.toHaveBeenCalled();
  });
});

describe("gatherBreakdownContext — what it selects (privacy)", () => {
  it("selects only numeric/enum/boolean columns — never any text column", async () => {
    const { gatherBreakdownContext } = await import("./breakdown-context");
    await gatherBreakdownContext(GUEST);

    const selects = [
      prismaMock.settings.findUnique.mock.calls[0][0].select,
      prismaMock.streak.findUnique.mock.calls[0][0].select,
      prismaMock.brainDumpItem.findMany.mock.calls[0][0].select,
      prismaMock.step.findMany.mock.calls[0][0].select,
    ];
    for (const sel of selects) {
      expect(sel, "every read must pin an explicit select").toBeTruthy();
      // `text` is the free-text column on BOTH BrainDumpItem and Step; not
      // selecting it is the structural guarantee that it can never leak.
      expect(JSON.stringify(sel)).not.toContain('"text"');
      expect(JSON.stringify(sel)).not.toContain("roundupEmail");
      expect(JSON.stringify(sel)).not.toContain("title");
    }
  });

  it("bounds the recent-step scan so prompt size cannot grow with history", async () => {
    const { gatherBreakdownContext, RECENT_STEP_ROW_LIMIT } =
      await import("./breakdown-context");
    await gatherBreakdownContext(GUEST);
    const args = prismaMock.step.findMany.mock.calls[0][0];
    expect(args.take).toBe(RECENT_STEP_ROW_LIMIT);
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });

  it("bounds the board scan too", async () => {
    const { gatherBreakdownContext, BOARD_SCAN_LIMIT } =
      await import("./breakdown-context");
    await gatherBreakdownContext(GUEST);
    expect(prismaMock.brainDumpItem.findMany.mock.calls[0][0].take).toBe(
      BOARD_SCAN_LIMIT,
    );
  });

  it("excludes the in-flight task's own steps when a task id is supplied", async () => {
    const { gatherBreakdownContext } = await import("./breakdown-context");
    await gatherBreakdownContext(GUEST, "task-current");
    expect(prismaMock.step.findMany.mock.calls[0][0].where).toEqual({
      task: { workspaceId: GUEST },
      taskId: { not: "task-current" },
    });
  });

  it("omits the taskId filter entirely when no task id is supplied", async () => {
    const { gatherBreakdownContext } = await import("./breakdown-context");
    await gatherBreakdownContext(GUEST);
    expect(prismaMock.step.findMany.mock.calls[0][0].where).toEqual({
      task: { workspaceId: GUEST },
    });
  });
});

describe("gatherBreakdownContext — defaults and coercion", () => {
  it("a brand-new workspace (no Settings, no Streak, no rows) yields an EMPTY context", async () => {
    const { gatherBreakdownContext } = await import("./breakdown-context");
    const { buildContextBlock } = await import("./breakdown");
    const ctx = await gatherBreakdownContext(GUEST);

    expect(ctx.voice).toBeNull();
    expect(ctx.streak).toBeNull();
    expect(ctx.buckets).toBeNull();
    expect(ctx.recentBreakdowns).toEqual([]);
    // The back-compat anchor: nothing known ⇒ the prompt is exactly today's.
    expect(buildContextBlock(ctx)).toBe("");
  });

  it("reads the voice setting, and drops a value outside the known enum", async () => {
    const { gatherBreakdownContext } = await import("./breakdown-context");

    prismaMock.settings.findUnique.mockResolvedValue({ voice: "playful" });
    expect((await gatherBreakdownContext(GUEST)).voice).toBe("playful");

    prismaMock.settings.findUnique.mockResolvedValue({ voice: "shouty" });
    expect((await gatherBreakdownContext(GUEST)).voice).toBeNull();
  });

  it("marks the streak active only when lastActiveWorkday is today", async () => {
    const { gatherBreakdownContext } = await import("./breakdown-context");

    prismaMock.streak.findUnique.mockResolvedValue({
      current: 4,
      lastActiveWorkday: ymd(new Date()),
    });
    expect((await gatherBreakdownContext(GUEST)).streak).toEqual({
      current: 4,
      activeToday: true,
    });

    prismaMock.streak.findUnique.mockResolvedValue({
      current: 4,
      lastActiveWorkday: "2020-01-01",
    });
    expect((await gatherBreakdownContext(GUEST)).streak).toEqual({
      current: 4,
      activeToday: false,
    });
  });

  it("treats a zero streak as no streak", async () => {
    const { gatherBreakdownContext } = await import("./breakdown-context");
    prismaMock.streak.findUnique.mockResolvedValue({
      current: 0,
      lastActiveWorkday: null,
    });
    expect((await gatherBreakdownContext(GUEST)).streak).toBeNull();
  });
});

describe("gatherBreakdownContext — bucket counts", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    status: "inbox",
    createdAt: new Date("2026-07-01T10:00:00Z"),
    freshenedAt: null,
    snoozedUntil: null,
    completedAt: null,
    breakdownRequestedAt: null,
    task: null,
    ...over,
  });

  it("counts the four live buckets exactly as the inbox does", async () => {
    const { gatherBreakdownContext } = await import("./breakdown-context");
    const future = new Date(Date.now() + 86_400_000);

    prismaMock.brainDumpItem.findMany.mockResolvedValue([
      item(), // needs review
      item(),
      item({ snoozedUntil: future }), // saved for later
      item({ status: "triaged", task: { status: "active", steps: [] } }), // single (0 steps)
      item({
        status: "triaged",
        task: { status: "active", steps: [{ done: false }] },
      }), // single (1 step)
      item({
        status: "triaged",
        task: {
          status: "active",
          steps: [{ done: false }, { done: true }],
        },
      }), // multi-step
      item({
        status: "triaged",
        breakdownRequestedAt: new Date(),
        task: { status: "active", steps: [] },
      }), // 0 steps + requested ⇒ multi-step
      item({
        status: "triaged",
        task: { status: "active", steps: [{ done: true }, { done: true }] },
      }), // fully done ⇒ no bucket
      item({ status: "triaged", task: { status: "done", steps: [] } }), // task done ⇒ no bucket
    ]);

    expect((await gatherBreakdownContext(GUEST)).buckets).toEqual({
      needsReview: 2,
      singleTask: 2,
      multiStep: 2,
      savedLater: 1,
    });
  });

  it("returns null buckets when nothing is live (no zero-noise in the prompt)", async () => {
    const { gatherBreakdownContext } = await import("./breakdown-context");
    prismaMock.brainDumpItem.findMany.mockResolvedValue([]);
    expect((await gatherBreakdownContext(GUEST)).buckets).toBeNull();
  });
});

describe("summarizeRecentBreakdowns", () => {
  const row = (taskId: string, estMinutes: number, iso: string) => ({
    taskId,
    estMinutes,
    createdAt: new Date(iso),
  });

  it("groups steps by task, newest task first, and caps at the limit", async () => {
    const { summarizeRecentBreakdowns, RECENT_BREAKDOWN_LIMIT } =
      await import("./breakdown-context");
    const out = summarizeRecentBreakdowns([
      row("t1", 10, "2026-07-05T00:00:00Z"),
      row("t1", 30, "2026-07-05T00:00:00Z"),
      row("t1", 20, "2026-07-05T00:00:00Z"),
      row("t2", 5, "2026-07-04T00:00:00Z"),
      row("t2", 15, "2026-07-04T00:00:00Z"),
      row("t3", 25, "2026-07-03T00:00:00Z"),
      row("t4", 45, "2026-07-02T00:00:00Z"),
    ]);

    expect(RECENT_BREAKDOWN_LIMIT).toBe(3);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      stepCount: 3,
      minMinutes: 10,
      medianMinutes: 20,
      maxMinutes: 30,
    });
    // t2 is the second-newest confirm, not the second-largest task.
    expect(out[1].stepCount).toBe(2);
    expect(out[2].stepCount).toBe(1);
  });

  it("averages the two middle values for an even step count", async () => {
    const { summarizeRecentBreakdowns } = await import("./breakdown-context");
    const [only] = summarizeRecentBreakdowns([
      row("t1", 5, "2026-07-05T00:00:00Z"),
      row("t1", 10, "2026-07-05T00:00:00Z"),
      row("t1", 20, "2026-07-05T00:00:00Z"),
      row("t1", 30, "2026-07-05T00:00:00Z"),
    ]);
    expect(only).toEqual({
      stepCount: 4,
      minMinutes: 5,
      medianMinutes: 15,
      maxMinutes: 30,
    });
  });

  it("ranks a task by its NEWEST step (confirmBreakdown rewrites every row)", async () => {
    const { summarizeRecentBreakdowns } = await import("./breakdown-context");
    const out = summarizeRecentBreakdowns([
      row("old-task", 10, "2026-01-01T00:00:00Z"),
      row("re-confirmed", 20, "2026-07-20T00:00:00Z"),
      row("re-confirmed", 25, "2026-01-02T00:00:00Z"),
    ]);
    expect(out[0].stepCount).toBe(2);
  });

  it("carries no step text through, even when the rows have some", async () => {
    const { summarizeRecentBreakdowns } = await import("./breakdown-context");
    const { buildContextBlock } = await import("./breakdown");
    // A deliberately synthetic sentinel rather than realistic-looking personal
    // data: GitLab redacts health/PII-shaped strings out of the diff it feeds
    // its reviewers, which made an earlier version of this fixture invisible in
    // review and got the test wrongly reported as unfallible (!158). The
    // sentinel is equally strong here and stays legible to a reviewer.
    const SENSITIVE = "ZZ-STEP-TEXT-MUST-NEVER-REACH-THE-PROMPT-ZZ";
    const out = summarizeRecentBreakdowns([
      { ...row("t1", 10, "2026-07-05T00:00:00Z"), text: SENSITIVE },
      { ...row("t1", 20, "2026-07-05T00:00:00Z"), text: SENSITIVE },
    ] as never);

    expect(JSON.stringify(out)).not.toContain(SENSITIVE);
    expect(
      buildContextBlock({ voice: "plain", recentBreakdowns: out }),
    ).not.toContain(SENSITIVE);

    // Stronger than a substring check: the summary must expose EXACTLY the
    // four shape fields, so ANY extra column carried through from a row — text
    // today, something else tomorrow — fails this, not just the one we named.
    for (const shape of out) {
      expect(Object.keys(shape).sort()).toEqual([
        "maxMinutes",
        "medianMinutes",
        "minMinutes",
        "stepCount",
      ]);
    }
  });

  it("ignores rows with an unusable estimate rather than rendering junk", async () => {
    const { summarizeRecentBreakdowns } = await import("./breakdown-context");
    const out = summarizeRecentBreakdowns([
      { taskId: "t1", estMinutes: Number.NaN, createdAt: new Date() },
      { taskId: "t1", estMinutes: 15, createdAt: new Date() },
    ]);
    expect(out).toEqual([
      { stepCount: 1, minMinutes: 15, medianMinutes: 15, maxMinutes: 15 },
    ]);
  });

  it("skips a non-positive estimate instead of folding it in as a zero", async () => {
    // Regression guard (!158 review). A negative or zero estMinutes used to be
    // clamped to 0 and KEPT, which silently distorted the shape the coach is
    // shown: it inflated stepCount, dragged minMinutes to 0 and shifted the
    // median — i.e. it told the coach this person likes 0-minute steps. NaN was
    // already skipped; these must behave the same way.
    const { summarizeRecentBreakdowns } = await import("./breakdown-context");
    const out = summarizeRecentBreakdowns([
      { taskId: "t1", estMinutes: -5, createdAt: new Date() },
      { taskId: "t1", estMinutes: 0, createdAt: new Date() },
      { taskId: "t1", estMinutes: 0.4, createdAt: new Date() },
      { taskId: "t1", estMinutes: 10, createdAt: new Date() },
      { taskId: "t1", estMinutes: 20, createdAt: new Date() },
    ]);
    expect(out).toEqual([
      { stepCount: 2, minMinutes: 10, medianMinutes: 15, maxMinutes: 20 },
    ]);
  });

  it("drops a task entirely when every one of its estimates is unusable", async () => {
    const { summarizeRecentBreakdowns } = await import("./breakdown-context");
    const out = summarizeRecentBreakdowns([
      { taskId: "all-bad", estMinutes: -1, createdAt: new Date() },
      { taskId: "all-bad", estMinutes: 0, createdAt: new Date() },
    ]);
    expect(out).toEqual([]);
  });

  it("never emits a zero minute figure, whatever the rows contain", async () => {
    const { summarizeRecentBreakdowns } = await import("./breakdown-context");
    const { buildContextBlock } = await import("./breakdown");
    const out = summarizeRecentBreakdowns([
      { taskId: "t1", estMinutes: -999, createdAt: new Date() },
      { taskId: "t1", estMinutes: 25, createdAt: new Date() },
    ]);
    for (const s of out) {
      expect(s.minMinutes).toBeGreaterThan(0);
      expect(s.medianMinutes).toBeGreaterThan(0);
      expect(s.maxMinutes).toBeGreaterThan(0);
      expect(s.stepCount).toBeGreaterThan(0);
    }
    expect(
      buildContextBlock({ voice: "plain", recentBreakdowns: out }),
    ).not.toMatch(/\b0 min|\(0–/);
  });
});

describe("gatherBreakdownContext — failure degrades to no context", () => {
  it("resolves to an empty context when a read throws (never rejects)", async () => {
    const { gatherBreakdownContext } = await import("./breakdown-context");
    prismaMock.streak.findUnique.mockRejectedValue(
      new Error("db is having a moment"),
    );

    await expect(gatherBreakdownContext(GUEST)).resolves.toEqual({});
  });

  it("resolves to an empty context when EVERY read throws", async () => {
    const { gatherBreakdownContext } = await import("./breakdown-context");
    const boom = () => Promise.reject(new Error("down"));
    prismaMock.settings.findUnique.mockImplementation(boom);
    prismaMock.streak.findUnique.mockImplementation(boom);
    prismaMock.brainDumpItem.findMany.mockImplementation(boom);
    prismaMock.step.findMany.mockImplementation(boom);

    await expect(gatherBreakdownContext(GUEST)).resolves.toEqual({});
  });
});
