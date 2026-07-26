/**
 * #27 — true pause/resume. Action tests for the new pauseFocus/resumeFocus
 * pair, plus beginFocus's resume-aware cleanup of stale open sessions (the
 * "double session" bug: re-entering a step used to call beginFocus again and
 * leave the original session open forever).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { prismaMock, currentWorkspaceIdMock } = vi.hoisted(() => {
  const prismaMock = {
    step: { findFirst: vi.fn() },
    focusSession: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  return {
    prismaMock,
    currentWorkspaceIdMock: vi.fn().mockResolvedValue("owner"),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/workspace", () => ({
  currentWorkspaceId: currentWorkspaceIdMock,
  isOwnerRequest: vi.fn().mockResolvedValue(true),
  MissingWorkspaceError: class extends Error {},
}));
vi.mock("@/lib/rewards", () => ({
  awardBadge: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  currentWorkspaceIdMock.mockResolvedValue("owner");
  prismaMock.focusSession.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.focusSession.create.mockResolvedValue({ id: "sess-new" });
  prismaMock.step.findFirst.mockResolvedValue({ id: "s1", taskId: "t1" });
});

describe("beginFocus — retires stale open sessions before creating a fresh one", () => {
  it("closes any existing open session for the step (outcome gaveup) before creating a new one", async () => {
    const { beginFocus } = await import("./focus");
    const id = await beginFocus("s1", 25);
    expect(prismaMock.focusSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stepId: "s1", workspaceId: "owner", endedAt: null },
        data: expect.objectContaining({ outcome: "gaveup" }),
      }),
    );
    // The retire call happens BEFORE create, so a fresh Start never leaves two
    // open rows for the same step.
    const retireOrder =
      prismaMock.focusSession.updateMany.mock.invocationCallOrder[0];
    const createOrder =
      prismaMock.focusSession.create.mock.invocationCallOrder[0];
    expect(retireOrder).toBeLessThan(createOrder);
    expect(id).toBe("sess-new");
  });

  it("still creates a session when there was nothing stale to retire", async () => {
    const { beginFocus } = await import("./focus");
    const id = await beginFocus("s1", 25);
    expect(id).toBe("sess-new");
    expect(prismaMock.focusSession.create).toHaveBeenCalledTimes(1);
  });
});

describe("pauseFocus", () => {
  it("stamps pausedAt and bakes the current adjusted total into plannedMin", async () => {
    prismaMock.focusSession.findFirst.mockResolvedValueOnce({
      id: "sess-1",
      workspaceId: "owner",
      pausedAt: null,
    });
    prismaMock.focusSession.update.mockResolvedValueOnce({});
    const { pauseFocus } = await import("./focus");
    const res = await pauseFocus("sess-1", { totalSec: 1800 }); // 30m adjusted total
    expect(res).toEqual({ ok: true });
    expect(prismaMock.focusSession.update).toHaveBeenCalledWith({
      where: { id: "sess-1" },
      data: {
        pausedAt: expect.any(Date),
        plannedMin: 30,
      },
    });
  });

  it("is idempotent: pausing an already-paused session is a no-op success", async () => {
    prismaMock.focusSession.findFirst.mockResolvedValueOnce({
      id: "sess-1",
      workspaceId: "owner",
      pausedAt: new Date(),
    });
    const { pauseFocus } = await import("./focus");
    const res = await pauseFocus("sess-1", { totalSec: 1800 });
    expect(res).toEqual({ ok: true });
    expect(prismaMock.focusSession.update).not.toHaveBeenCalled();
  });

  it("fails closed when the session doesn't belong to the caller's workspace", async () => {
    prismaMock.focusSession.findFirst.mockResolvedValueOnce(null);
    const { pauseFocus } = await import("./focus");
    const res = await pauseFocus("not-mine", { totalSec: 1800 });
    expect(res).toEqual({ ok: false });
    expect(prismaMock.focusSession.update).not.toHaveBeenCalled();
  });
});

describe("resumeFocus — reuses the existing session (the double-session-bug fix)", () => {
  // Duo review: `vi.setSystemTime` mocks `Date`/`new Date()` even without
  // fake timers active (per this Vitest version's own typings), so the test
  // below was correct — but relying on that undocumented-to-readers nuance
  // is fragile, and a bare `vi.useRealTimers()` at the end of the test body
  // would leak the mocked clock into later tests if an assertion above it
  // ever threw. Make the fake-timer lifecycle explicit and unconditional.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears pausedAt, accumulates the pause duration, and returns the frozen remaining time", async () => {
    const startedAt = new Date("2026-07-26T10:00:00Z");
    const pausedAt = new Date("2026-07-26T10:10:00Z"); // paused after 10 minutes
    prismaMock.focusSession.findFirst.mockResolvedValueOnce({
      id: "sess-1",
      workspaceId: "owner",
      plannedMin: 25,
      startedAt,
      pausedAt,
      accumulatedPausedMs: 0,
    });
    prismaMock.focusSession.update.mockResolvedValueOnce({});
    vi.setSystemTime(new Date("2026-07-26T12:10:00Z")); // paused for 2 hours

    const { resumeFocus } = await import("./focus");
    const res = await resumeFocus("sess-1");

    // No new session created — the SAME id is reused (the bug this closes).
    expect(prismaMock.focusSession.create).not.toHaveBeenCalled();
    expect(prismaMock.focusSession.update).toHaveBeenCalledWith({
      where: { id: "sess-1" },
      data: { pausedAt: null, accumulatedPausedMs: 2 * 60 * 60 * 1000 },
    });
    expect(res.ok).toBe(true);
    expect(res.remainingSec).toBe(15 * 60); // 25m planned − 10m active = 15m left
    expect(res.totalSec).toBe(25 * 60);
    expect(res.plannedMin).toBe(25);
  });

  it("fails closed on a session that isn't actually paused (nothing to resume)", async () => {
    prismaMock.focusSession.findFirst.mockResolvedValueOnce({
      id: "sess-1",
      workspaceId: "owner",
      plannedMin: 25,
      startedAt: new Date(),
      pausedAt: null,
      accumulatedPausedMs: 0,
    });
    const { resumeFocus } = await import("./focus");
    const res = await resumeFocus("sess-1");
    expect(res.ok).toBe(false);
    expect(prismaMock.focusSession.update).not.toHaveBeenCalled();
  });

  it("fails closed when the session doesn't belong to the caller's workspace", async () => {
    prismaMock.focusSession.findFirst.mockResolvedValueOnce(null);
    const { resumeFocus } = await import("./focus");
    const res = await resumeFocus("not-mine");
    expect(res.ok).toBe(false);
  });
});
