import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("ensureClient persists an encrypted clientSecret on the registration path", async () => {
    prismaMock.reclaimAuth.upsert.mockResolvedValue({
      id: "singleton",
      clientId: null,
      clientSecret: null,
      redirectUri: null,
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ client_id: "cid", client_secret: "plaintext-secret" }),
      }),
    );
    const { ensureClient } = await import("./reclaim");
    await ensureClient("https://app/cb");

    expect(prismaMock.reclaimAuth.update).toHaveBeenCalled();
    const storedSecret = prismaMock.reclaimAuth.update.mock.calls[0][0].data.clientSecret;
    expect(storedSecret).toMatch(/^v1:/);
    expect(storedSecret).not.toBe("plaintext-secret");
    expect(decryptToken(storedSecret)).toBe("plaintext-secret");
  });

  it("exchangeCode persists encrypted access + refresh tokens", async () => {
    prismaMock.reclaimAuth.upsert.mockResolvedValue({
      id: "singleton",
      clientId: "cid",
      clientSecret: null,
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: "at-plain",
          refresh_token: "rt-plain",
          expires_in: 3600,
        }),
      }),
    );
    const { exchangeCode } = await import("./reclaim");
    await exchangeCode("code", "verifier", "https://app/cb");

    expect(prismaMock.reclaimAuth.update).toHaveBeenCalled();
    const data = prismaMock.reclaimAuth.update.mock.calls[0][0].data;
    expect(data.accessToken).toMatch(/^v1:/);
    expect(decryptToken(data.accessToken)).toBe("at-plain");
    expect(data.refreshToken).toMatch(/^v1:/);
    expect(decryptToken(data.refreshToken)).toBe("rt-plain");
  });
});
