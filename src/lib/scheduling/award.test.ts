import { describe, it, expect, vi, beforeEach } from "vitest";

const { logRewardMock, awardBadgeMock } = vi.hoisted(() => ({
  logRewardMock: vi.fn(),
  awardBadgeMock: vi.fn(),
}));
vi.mock("@/lib/rewards", () => ({
  logReward: logRewardMock,
  awardBadge: awardBadgeMock,
}));

import { awardFirstSchedule } from "./award";
import { RewardType, BadgeKey } from "@/lib/constants";

beforeEach(() => {
  vi.clearAllMocks();
  logRewardMock.mockResolvedValue(undefined);
  awardBadgeMock.mockResolvedValue(undefined);
});

describe("awardFirstSchedule", () => {
  it("awards Scheduled + FirstSchedule exactly once when not already scheduled", async () => {
    await awardFirstSchedule("ws-1", false);
    expect(logRewardMock).toHaveBeenCalledTimes(1);
    expect(logRewardMock).toHaveBeenCalledWith("ws-1", RewardType.Scheduled);
    expect(awardBadgeMock).toHaveBeenCalledTimes(1);
    expect(awardBadgeMock).toHaveBeenCalledWith("ws-1", BadgeKey.FirstSchedule);
  });

  it("is idempotent: no-ops when the task was already scheduled (either method)", async () => {
    await awardFirstSchedule("ws-1", true);
    expect(logRewardMock).not.toHaveBeenCalled();
    expect(awardBadgeMock).not.toHaveBeenCalled();
  });

  it("best-effort: a logReward rejection does NOT skip awardBadge and does NOT throw", async () => {
    logRewardMock.mockRejectedValueOnce(new Error("reward store down"));
    await expect(awardFirstSchedule("ws-1", false)).resolves.toBeUndefined();
    // allSettled → the idempotent badge is still awarded despite the points failure.
    expect(awardBadgeMock).toHaveBeenCalledWith("ws-1", BadgeKey.FirstSchedule);
  });

  it("best-effort: an awardBadge rejection does NOT throw", async () => {
    awardBadgeMock.mockRejectedValueOnce(new Error("badge store down"));
    await expect(awardFirstSchedule("ws-1", false)).resolves.toBeUndefined();
    expect(logRewardMock).toHaveBeenCalledWith("ws-1", RewardType.Scheduled);
  });
});
