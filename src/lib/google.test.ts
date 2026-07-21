import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decryptToken, encryptToken } from "@/lib/crypto/token-cipher";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    googleAuth: {
      upsert: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn(),
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
    expect(create.refreshToken).toMatch(/^v1:/);
    expect(decryptToken(create.refreshToken)).toBe("g-rt");
    expect(update.accessToken).toMatch(/^v1:/);
    expect(decryptToken(update.accessToken)).toBe("g-at");
    expect(update.refreshToken).toMatch(/^v1:/);
    expect(decryptToken(update.refreshToken)).toBe("g-rt");
  });
});

describe("invalid_grant handling", () => {
  function connectedRow() {
    return {
      id: "singleton",
      accessToken: encryptToken("stale-at"),
      refreshToken: encryptToken("dead-rt"),
      expiresAt: new Date(Date.now() - 1000), // forces refresh path
      needsReconnect: false,
    };
  }

  it("clears tokens and sets needsReconnect on invalid_grant", async () => {
    process.env.GOOGLE_CLIENT_ID = "google-cid";
    process.env.GOOGLE_CLIENT_SECRET = "google-csecret";
    prismaMock.googleAuth.upsert.mockResolvedValue(connectedRow());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant" }),
      }),
    );
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken()).toBeNull();
    expect(prismaMock.googleAuth.update).toHaveBeenCalledWith({
      where: { id: "singleton" },
      data: {
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        needsReconnect: true,
      },
    });
  });

  it("leaves stored tokens untouched on transient refresh errors", async () => {
    process.env.GOOGLE_CLIENT_ID = "google-cid";
    process.env.GOOGLE_CLIENT_SECRET = "google-csecret";
    prismaMock.googleAuth.upsert.mockResolvedValue(connectedRow());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: "temporarily_unavailable" }),
      }),
    );
    const { getValidAccessToken } = await import("./google");
    expect(await getValidAccessToken()).toBeNull();
    expect(prismaMock.googleAuth.update).not.toHaveBeenCalled();
  });
});

describe("status + reconnect healing", () => {
  it("getGoogleStatus surfaces needsReconnect", async () => {
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      needsReconnect: true,
    });
    const { getGoogleStatus } = await import("./google");
    expect(await getGoogleStatus()).toMatchObject({
      connected: false,
      needsReconnect: true,
    });
  });

  it("storeTokens resets needsReconnect", async () => {
    process.env.GOOGLE_CLIENT_ID = "google-cid";
    process.env.GOOGLE_CLIENT_SECRET = "google-csecret";
    prismaMock.googleAuth.upsert.mockResolvedValue({ id: "singleton" });
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
    const call = prismaMock.googleAuth.upsert.mock.calls.at(-1)![0];
    expect(call.update.needsReconnect).toBe(false);
    expect(call.create.needsReconnect).toBe(false);
  });
});

describe("disconnectGoogle", () => {
  it("revokes the refresh token then deletes the row", async () => {
    const { encryptToken } = await import("@/lib/crypto/token-cipher");
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: encryptToken("at"),
      refreshToken: encryptToken("rt"),
      expiresAt: null,
      needsReconnect: false,
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const { disconnectGoogle } = await import("./google");
    await disconnectGoogle();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ method: "POST" }),
    );
    expect(String(fetchMock.mock.calls[0][1].body)).toContain("token=rt");
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalled();
  });

  it("still deletes when revoke fails", async () => {
    const { encryptToken } = await import("@/lib/crypto/token-cipher");
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: encryptToken("at"),
      refreshToken: null,
      expiresAt: null,
      needsReconnect: false,
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net down")));
    const { disconnectGoogle } = await import("./google");
    await expect(disconnectGoogle()).resolves.toBeUndefined();
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalled();
  });

  it("is a no-op-safe delete when nothing is stored", async () => {
    prismaMock.googleAuth.upsert.mockResolvedValue({
      id: "singleton",
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      needsReconnect: false,
    });
    vi.stubGlobal("fetch", vi.fn());
    const { disconnectGoogle } = await import("./google");
    await disconnectGoogle();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(prismaMock.googleAuth.deleteMany).toHaveBeenCalled();
  });
});
