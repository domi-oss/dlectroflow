import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ensureClient, exchangeCode } from "./reclaim";
import { prisma } from "@/lib/db";

vi.mock("@/lib/db", () => ({
  prisma: {
    reclaimAuth: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
  },
}));

describe("Reclaim OAuth - SSRF Prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("ensureClient - redirectUri validation", () => {
    it("accepts valid HTTPS redirect URIs", async () => {
      const validUri = "https://dlectroflow.dlectronique.dev/api/reclaim/oauth/callback";
      vi.mocked(prisma.reclaimAuth.upsert).mockResolvedValueOnce({
        id: "singleton",
        clientId: null,
        clientSecret: null,
        redirectUri: null,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scope: null,
      });

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ client_id: "test-client", client_secret: "test-secret" }),
      });

      vi.mocked(prisma.reclaimAuth.update).mockResolvedValueOnce({
        id: "singleton",
        clientId: "test-client",
        clientSecret: "test-secret",
        redirectUri: validUri,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scope: null,
      });

      const result = await ensureClient(validUri);
      expect(result.clientId).toBe("test-client");
      expect(result.clientSecret).toBe("test-secret");
    });

    it("accepts valid localhost redirect URIs for development", async () => {
      const devUri = "http://localhost:3000/api/reclaim/oauth/callback";
      vi.mocked(prisma.reclaimAuth.upsert).mockResolvedValueOnce({
        id: "singleton",
        clientId: null,
        clientSecret: null,
        redirectUri: null,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scope: null,
      });

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ client_id: "test-client", client_secret: "test-secret" }),
      });

      vi.mocked(prisma.reclaimAuth.update).mockResolvedValueOnce({
        id: "singleton",
        clientId: "test-client",
        clientSecret: "test-secret",
        redirectUri: devUri,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scope: null,
      });

      const result = await ensureClient(devUri);
      expect(result.clientId).toBe("test-client");
    });

    it("registers client with exact redirectUri passed", async () => {
      const redirectUri = "https://example.com/api/reclaim/oauth/callback";
      vi.mocked(prisma.reclaimAuth.upsert).mockResolvedValueOnce({
        id: "singleton",
        clientId: null,
        clientSecret: null,
        redirectUri: null,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scope: null,
      });

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ client_id: "test-client" }),
      });

      vi.mocked(prisma.reclaimAuth.update).mockResolvedValueOnce({
        id: "singleton",
        clientId: "test-client",
        clientSecret: null,
        redirectUri,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scope: null,
      });

      await ensureClient(redirectUri);

      const fetchCall = vi.mocked(global.fetch).mock.calls[0];
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.redirect_uris).toEqual([redirectUri]);
    });

    it("reuses existing client when redirectUri matches", async () => {
      const redirectUri = "https://example.com/api/reclaim/oauth/callback";
      vi.mocked(prisma.reclaimAuth.upsert).mockResolvedValueOnce({
        id: "singleton",
        clientId: "existing-client",
        clientSecret: "existing-secret",
        redirectUri,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scope: null,
      });

      const result = await ensureClient(redirectUri);

      expect(result.clientId).toBe("existing-client");
      expect(result.clientSecret).toBe("existing-secret");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("re-registers when redirectUri changes", async () => {
      const oldUri = "https://old.example.com/api/reclaim/oauth/callback";
      const newUri = "https://new.example.com/api/reclaim/oauth/callback";

      vi.mocked(prisma.reclaimAuth.upsert).mockResolvedValueOnce({
        id: "singleton",
        clientId: "old-client",
        clientSecret: "old-secret",
        redirectUri: oldUri,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scope: null,
      });

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ client_id: "new-client", client_secret: "new-secret" }),
      });

      vi.mocked(prisma.reclaimAuth.update).mockResolvedValueOnce({
        id: "singleton",
        clientId: "new-client",
        clientSecret: "new-secret",
        redirectUri: newUri,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scope: null,
      });

      const result = await ensureClient(newUri);

      expect(result.clientId).toBe("new-client");
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("exchangeCode - redirectUri validation", () => {
    it("passes redirectUri to token endpoint", async () => {
      const redirectUri = "https://example.com/api/reclaim/oauth/callback";
      const code = "auth-code-123";
      const verifier = "pkce-verifier";

      vi.mocked(prisma.reclaimAuth.upsert).mockResolvedValueOnce({
        id: "singleton",
        clientId: "test-client",
        clientSecret: "test-secret",
        redirectUri,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scope: null,
      });

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "token-123" }),
      });

      vi.mocked(prisma.reclaimAuth.update).mockResolvedValueOnce({
        id: "singleton",
        clientId: "test-client",
        clientSecret: "test-secret",
        redirectUri,
        accessToken: "token-123",
        refreshToken: null,
        expiresAt: null,
        scope: null,
      });

      await exchangeCode(code, verifier, redirectUri);

      const fetchCall = vi.mocked(global.fetch).mock.calls[0];
      const body = new URLSearchParams(fetchCall[1]?.body as string);
      expect(body.get("redirect_uri")).toBe(redirectUri);
      expect(body.get("code")).toBe(code);
      expect(body.get("code_verifier")).toBe(verifier);
    });

    it("fails when token endpoint returns error", async () => {
      const redirectUri = "https://example.com/api/reclaim/oauth/callback";

      vi.mocked(prisma.reclaimAuth.upsert).mockResolvedValueOnce({
        id: "singleton",
        clientId: "test-client",
        clientSecret: "test-secret",
        redirectUri,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scope: null,
      });

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
      });

      await expect(
        exchangeCode("bad-code", "verifier", redirectUri),
      ).rejects.toThrow("Reclaim token exchange failed");
    });
  });
});
