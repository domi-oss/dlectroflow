import { describe, it, expect, vi, beforeEach } from "vitest";
import { decryptToken } from "@/lib/crypto/token-cipher";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    reclaimAuth: {
      upsert: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.reclaimAuth.upsert.mockResolvedValue({ id: "singleton" });
});

describe("reclaim token encryption", () => {
  it("getValidAccessToken decrypts a stored (encrypted) access token", async () => {
    const { encryptToken } = await import("@/lib/crypto/token-cipher");
    prismaMock.reclaimAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: encryptToken("live-access-token"),
      refreshToken: null,
      clientId: "cid",
      clientSecret: null,
      expiresAt: null,
    });
    const { getValidAccessToken } = await import("./reclaim");
    expect(await getValidAccessToken()).toBe("live-access-token");
  });

  it("getValidAccessToken returns null when no token stored", async () => {
    prismaMock.reclaimAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: null,
      refreshToken: null,
      clientId: "cid",
      clientSecret: null,
      expiresAt: null,
    });
    const { getValidAccessToken } = await import("./reclaim");
    expect(await getValidAccessToken()).toBeNull();
  });
});
