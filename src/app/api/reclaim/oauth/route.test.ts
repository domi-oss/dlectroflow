import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requestOrigin } from "@/lib/origin";

vi.mock("@/lib/origin");
vi.mock("@/lib/reclaim");

describe("Reclaim OAuth Routes - SSRF Prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("requestOrigin usage in OAuth routes", () => {
    it("uses requestOrigin helper instead of direct URL parsing", () => {
      const mockReq = new Request("http://attacker.com/api/reclaim/oauth/start", {
        headers: {
          "x-forwarded-host": "attacker.com",
          "x-forwarded-proto": "http",
        },
      });

      vi.mocked(requestOrigin).mockReturnValue("https://dlectroflow.dlectronique.dev");

      const origin = requestOrigin(mockReq);

      expect(origin).toBe("https://dlectroflow.dlectronique.dev");
      expect(requestOrigin).toHaveBeenCalledWith(mockReq);
    });

    it("requestOrigin respects PUBLIC_ORIGIN environment variable", () => {
      vi.stubEnv("PUBLIC_ORIGIN", "https://dlectroflow.dlectronique.dev");
      vi.stubEnv("NODE_ENV", "production");

      const mockReq = new Request("http://localhost:3000/api/reclaim/oauth/start", {
        headers: {
          "x-forwarded-host": "attacker.com",
        },
      });

      vi.mocked(requestOrigin).mockReturnValue("https://dlectroflow.dlectronique.dev");

      const origin = requestOrigin(mockReq);

      expect(origin).toBe("https://dlectroflow.dlectronique.dev");
    });

    it("requestOrigin throws in production when PUBLIC_ORIGIN is missing", () => {
      vi.stubEnv("PUBLIC_ORIGIN", "");
      vi.stubEnv("NODE_ENV", "production");

      const mockReq = new Request("http://localhost:3000/api/reclaim/oauth/start");

      vi.mocked(requestOrigin).mockImplementation(() => {
        throw new Error(
          "PUBLIC_ORIGIN must be set in production (refusing to derive OAuth origin from request headers).",
        );
      });

      expect(() => requestOrigin(mockReq)).toThrow(
        "PUBLIC_ORIGIN must be set in production",
      );
    });

    it("requestOrigin allows header-based origin in development", () => {
      vi.stubEnv("PUBLIC_ORIGIN", "");
      vi.stubEnv("NODE_ENV", "development");

      const mockReq = new Request("http://localhost:3000/api/reclaim/oauth/start", {
        headers: {
          "x-forwarded-host": "localhost:3000",
          "x-forwarded-proto": "http",
        },
      });

      vi.mocked(requestOrigin).mockReturnValue("http://localhost:3000");

      const origin = requestOrigin(mockReq);

      expect(origin).toBe("http://localhost:3000");
    });
  });

  describe("SSRF attack prevention", () => {
    it("prevents attacker from registering client with malicious redirectUri", () => {
      const maliciousUri = "https://attacker.com/steal-tokens";

      vi.mocked(requestOrigin).mockReturnValue("https://dlectroflow.dlectronique.dev");

      const origin = requestOrigin(new Request("http://localhost/api/reclaim/oauth/start"));

      expect(origin).not.toBe("https://attacker.com");
      expect(origin).toBe("https://dlectroflow.dlectronique.dev");
    });

    it("prevents Host header spoofing in production", () => {
      vi.stubEnv("PUBLIC_ORIGIN", "https://dlectroflow.dlectronique.dev");
      vi.stubEnv("NODE_ENV", "production");

      const mockReq = new Request("http://localhost:3000/api/reclaim/oauth/start", {
        headers: {
          host: "attacker.com",
          "x-forwarded-host": "attacker.com",
          "x-forwarded-proto": "https",
        },
      });

      vi.mocked(requestOrigin).mockReturnValue("https://dlectroflow.dlectronique.dev");

      const origin = requestOrigin(mockReq);

      expect(origin).toBe("https://dlectroflow.dlectronique.dev");
      expect(origin).not.toContain("attacker.com");
    });

    it("prevents X-Forwarded-Host header spoofing in production", () => {
      vi.stubEnv("PUBLIC_ORIGIN", "https://dlectroflow.dlectronique.dev");
      vi.stubEnv("NODE_ENV", "production");

      const mockReq = new Request("http://localhost:3000/api/reclaim/oauth/start", {
        headers: {
          "x-forwarded-host": "attacker.com",
          "x-forwarded-proto": "https",
        },
      });

      vi.mocked(requestOrigin).mockReturnValue("https://dlectroflow.dlectronique.dev");

      const origin = requestOrigin(mockReq);

      expect(origin).toBe("https://dlectroflow.dlectronique.dev");
      expect(origin).not.toContain("attacker.com");
    });

    it("prevents X-Forwarded-Proto header spoofing in production", () => {
      vi.stubEnv("PUBLIC_ORIGIN", "https://dlectroflow.dlectronique.dev");
      vi.stubEnv("NODE_ENV", "production");

      const mockReq = new Request("http://localhost:3000/api/reclaim/oauth/start", {
        headers: {
          "x-forwarded-host": "dlectroflow.dlectronique.dev",
          "x-forwarded-proto": "http",
        },
      });

      vi.mocked(requestOrigin).mockReturnValue("https://dlectroflow.dlectronique.dev");

      const origin = requestOrigin(mockReq);

      expect(origin).toMatch(/^https:\/\//);
      expect(origin).not.toMatch(/^http:\/\//);
    });
  });
});
