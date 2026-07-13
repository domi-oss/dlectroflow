import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    googleAuth: {
      upsert: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("google token encryption", () => {
  it("getValidAccessToken decrypts a stored (encrypted) access token", async () => {
    const { encryptToken } = await import("@/lib/crypto/token-cipher");
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: encryptToken("google-access-token"),
      refreshToken: null,
      expiresAt: null,
    });
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken()).toBe("google-access-token");
  });

  it("returns null when no token stored", async () => {
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
    });
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken()).toBeNull();
  });
});
