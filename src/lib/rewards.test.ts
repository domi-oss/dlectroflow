import { describe, it, expect, vi, beforeEach } from "vitest";

// Unit test for the P2002-safe once-only badge award (issue #21 P5.2).
// prisma.badge is mocked; isUniqueViolation is provided by the @/lib/db mock
// (mirrors the real predicate: PrismaClientKnownRequestError with code P2002).
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    badge: { findUnique: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: prismaMock,
  getSettings: vi.fn(),
  getStreak: vi.fn(),
  isUniqueViolation: (e: unknown) =>
    !!e && typeof e === "object" && (e as { code?: string }).code === "P2002",
}));

import { awardBadge } from "./rewards";
import { BadgeKey } from "./constants";

class FakeP2002 extends Error {
  code = "P2002";
}
class FakeOtherError extends Error {
  code = "P1001";
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("awardBadge — P2002-safe, once-only", () => {
  it("happy path: no existing badge → creates and returns true", async () => {
    prismaMock.badge.findUnique.mockResolvedValue(null);
    prismaMock.badge.create.mockResolvedValue({});
    const r = await awardBadge("ws", BadgeKey.Streak5);
    expect(r).toBe(true);
    expect(prismaMock.badge.create).toHaveBeenCalledTimes(1);
  });

  it("pre-existing badge → returns false without calling create", async () => {
    prismaMock.badge.findUnique.mockResolvedValue({ id: "b1" });
    const r = await awardBadge("ws", BadgeKey.Streak5);
    expect(r).toBe(false);
    expect(prismaMock.badge.create).not.toHaveBeenCalled();
  });

  it("concurrent award race: create throws P2002 → returns false (never throws)", async () => {
    prismaMock.badge.findUnique.mockResolvedValue(null);
    prismaMock.badge.create.mockRejectedValue(
      new FakeP2002("Unique constraint failed"),
    );
    await expect(awardBadge("ws", BadgeKey.Streak5)).resolves.toBe(false);
  });

  it("non-P2002 create error → rethrows", async () => {
    prismaMock.badge.findUnique.mockResolvedValue(null);
    prismaMock.badge.create.mockRejectedValue(
      new FakeOtherError("connection lost"),
    );
    await expect(awardBadge("ws", BadgeKey.Streak5)).rejects.toMatchObject({
      code: "P1001",
    });
  });
});
