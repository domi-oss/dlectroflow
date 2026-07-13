import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decryptToken } from "@/lib/crypto/token-cipher";

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

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("exchangeCode persists encrypted tokens in both upsert branches", async () => {
    process.env.GOOGLE_CLIENT_ID = "google-cid";
    process.env.GOOGLE_CLIENT_SECRET = "google-csecret";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: "g-at",
          refresh_token: "g-rt",
          expires_in: 3600,
        }),
      }),
    );
    const { exchangeCode } = await import("./google");
    await exchangeCode("code", "verifier", "https://app/cb");

    expect(prismaMock.googleAuth.upsert).toHaveBeenCalled();
    const { create, update } = prismaMock.googleAuth.upsert.mock.calls[0][0];
    expect(create.accessToken).toMatch(/^v1:/);
    expect(decryptToken(create.accessToken)).toBe("g-at");
    expect(update.accessToken).toMatch(/^v1:/);
    expect(decryptToken(update.accessToken)).toBe("g-at");
  });
});
