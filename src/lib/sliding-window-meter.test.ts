import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  meterConsume,
  remainingInWindow,
  windowExpired,
  type SlidingWindowStore,
} from "./sliding-window-meter";

// #35 Phase B — the atomic sliding-window consume, extracted from
// guest-quota.ts so the per-user cap reuses the SAME mechanism rather than a
// second, subtly different one (which is the reason the design chose a
// single-row UserAiUsage in the first place). These tests drive the three-step
// sequence through a fake store; the real-Postgres atomicity proofs live in
// guest-quota.integration.test.ts and user-quota.integration.test.ts.

const QUOTA = 5;
const NOW = new Date("2026-07-28T12:00:00.000Z");
const THRESHOLD = new Date("2026-07-27T12:00:00.000Z");

class FakeDuplicate extends Error {}

function fakeStore(overrides: Partial<SlidingWindowStore> = {}): {
  store: SlidingWindowStore;
  mocks: {
    find: ReturnType<typeof vi.fn>;
    resetExpired: ReturnType<typeof vi.fn>;
    incrementUnderQuota: ReturnType<typeof vi.fn>;
    createFirstUse: ReturnType<typeof vi.fn>;
  };
} {
  const mocks = {
    find: vi.fn().mockResolvedValue(null),
    resetExpired: vi.fn().mockResolvedValue(0),
    incrementUnderQuota: vi.fn().mockResolvedValue(0),
    createFirstUse: vi.fn().mockResolvedValue(undefined),
  };
  const store: SlidingWindowStore = {
    ...mocks,
    isDuplicate: (e: unknown) => e instanceof FakeDuplicate,
    ...overrides,
  };
  return { store, mocks };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("windowExpired", () => {
  it("is true when the window started at or before the threshold", () => {
    expect(
      windowExpired({ count: 3, windowStartedAt: THRESHOLD }, THRESHOLD),
    ).toBe(true);
    expect(
      windowExpired(
        { count: 3, windowStartedAt: new Date(THRESHOLD.getTime() - 1) },
        THRESHOLD,
      ),
    ).toBe(true);
  });

  it("is false inside an active window, and for a subject with no row", () => {
    expect(
      windowExpired(
        { count: 3, windowStartedAt: new Date(THRESHOLD.getTime() + 1) },
        THRESHOLD,
      ),
    ).toBe(false);
    expect(windowExpired(null, THRESHOLD)).toBe(false);
  });
});

describe("meterConsume — step 1: an expired window resets to a fresh one", () => {
  it("consumes the reset unit and never touches the increment path", async () => {
    const { store, mocks } = fakeStore();
    mocks.resetExpired.mockResolvedValue(1);

    const res = await meterConsume(store, QUOTA, NOW, THRESHOLD);

    expect(res).toEqual({ allowed: true, remaining: QUOTA - 1 });
    expect(mocks.resetExpired).toHaveBeenCalledWith(NOW, THRESHOLD);
    expect(mocks.incrementUnderQuota).not.toHaveBeenCalled();
    expect(mocks.createFirstUse).not.toHaveBeenCalled();
  });
});

describe("meterConsume — step 2: guarded increment inside an active window", () => {
  it("allows the consume and reports the remaining allowance", async () => {
    const { store, mocks } = fakeStore();
    mocks.incrementUnderQuota.mockResolvedValue(1);
    mocks.find.mockResolvedValue({
      count: 2,
      windowStartedAt: new Date(THRESHOLD.getTime() + 1),
    });

    const res = await meterConsume(store, QUOTA, NOW, THRESHOLD);

    expect(res).toEqual({ allowed: true, remaining: QUOTA - 2 });
    expect(mocks.incrementUnderQuota).toHaveBeenCalledWith(QUOTA, THRESHOLD);
    expect(mocks.createFirstUse).not.toHaveBeenCalled();
  });
});

describe("meterConsume — step 3: first use", () => {
  it("creates the row only when it is genuinely absent", async () => {
    const { store, mocks } = fakeStore();

    const res = await meterConsume(store, QUOTA, NOW, THRESHOLD);

    expect(res).toEqual({ allowed: true, remaining: QUOTA - 1 });
    expect(mocks.createFirstUse).toHaveBeenCalledWith(NOW);
  });

  it("does NOT attempt a create when a row already exists (it would always collide)", async () => {
    // An exhausted active window: step 1 matched nothing (not expired) and
    // step 2 matched nothing (count >= quota). A create here would throw a
    // unique violation on EVERY blocked request.
    const { store, mocks } = fakeStore();
    mocks.find.mockResolvedValue({
      count: QUOTA,
      windowStartedAt: new Date(THRESHOLD.getTime() + 1),
    });

    const res = await meterConsume(store, QUOTA, NOW, THRESHOLD);

    expect(res).toEqual({ allowed: false, remaining: 0 });
    expect(mocks.createFirstUse).not.toHaveBeenCalled();
  });

  it("recovers from a lost create race by incrementing the winner's row", async () => {
    const { store, mocks } = fakeStore();
    mocks.createFirstUse.mockRejectedValue(new FakeDuplicate("dup"));
    // The retry increment succeeds against the row the winner created.
    mocks.incrementUnderQuota
      .mockResolvedValueOnce(0) // step 2, before the create attempt
      .mockResolvedValueOnce(1); // the retry after the lost race
    mocks.find
      .mockResolvedValueOnce(null) // step 3 existence check: genuinely absent
      .mockResolvedValue({
        count: 1,
        windowStartedAt: new Date(THRESHOLD.getTime() + 1),
      });

    const res = await meterConsume(store, QUOTA, NOW, THRESHOLD);

    expect(res).toEqual({ allowed: true, remaining: QUOTA - 1 });
    expect(mocks.incrementUnderQuota).toHaveBeenCalledTimes(2);
  });

  it("rethrows a create failure that is NOT a unique violation", async () => {
    const { store, mocks } = fakeStore();
    mocks.createFirstUse.mockRejectedValue(new Error("connection reset"));

    await expect(meterConsume(store, QUOTA, NOW, THRESHOLD)).rejects.toThrow(
      "connection reset",
    );
  });
});

describe("remainingInWindow", () => {
  it("returns the full quota when the subject has no row", async () => {
    const { store } = fakeStore();
    expect(await remainingInWindow(store, QUOTA, THRESHOLD)).toBe(QUOTA);
  });

  it("treats an expired window as unused", async () => {
    const { store, mocks } = fakeStore();
    mocks.find.mockResolvedValue({ count: QUOTA, windowStartedAt: THRESHOLD });
    expect(await remainingInWindow(store, QUOTA, THRESHOLD)).toBe(QUOTA);
  });

  it("never reports a negative allowance", async () => {
    const { store, mocks } = fakeStore();
    mocks.find.mockResolvedValue({
      count: QUOTA + 3,
      windowStartedAt: new Date(THRESHOLD.getTime() + 1),
    });
    expect(await remainingInWindow(store, QUOTA, THRESHOLD)).toBe(0);
  });
});
