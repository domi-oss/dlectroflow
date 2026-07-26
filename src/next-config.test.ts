import { describe, it, expect } from "vitest";
// Import the default export from the root next.config.ts.
// Vitest resolves this relative to the project root via the tsconfig paths.
import nextConfig from "../next.config";

// next.config.ts exports a plain object — redirects() is an async function on it.
// We call it directly to unit-test the redirect rules without spinning up a server.

describe("next.config redirects()", () => {
  it("returns an array of redirect rules", async () => {
    const redirects = await nextConfig.redirects!();
    expect(Array.isArray(redirects)).toBe(true);
  });

  describe("/inbox → / redirect (#58)", () => {
    it("permanently redirects /inbox to /", async () => {
      const redirects = await nextConfig.redirects!();
      const rule = redirects.find((r) => r.source === "/inbox");
      expect(rule).toBeDefined();
      expect(rule!.destination).toBe("/");
      expect(rule!.permanent).toBe(true);
    });

    it("does not carry a host condition (applies on all domains)", async () => {
      const redirects = await nextConfig.redirects!();
      const rule = redirects.find((r) => r.source === "/inbox");
      expect(rule).toBeDefined();
      // No `has` condition — the /inbox redirect is domain-agnostic.
      expect((rule as { has?: unknown }).has).toBeUndefined();
    });
  });

  describe("legacy-domain 301 redirect (#54)", () => {
    it("permanently redirects the legacy host to dlectroflow.dev", async () => {
      const redirects = await nextConfig.redirects!();
      const rule = redirects.find(
        (r) =>
          Array.isArray((r as { has?: unknown[] }).has) &&
          (r as { has: Array<{ type: string; value: string }> }).has.some(
            (h) =>
              h.type === "host" && h.value === "dlectroflow.dlectronique.dev",
          ),
      );
      expect(rule).toBeDefined();
      expect(rule!.destination).toBe("https://dlectroflow.dev/:path*");
      expect(rule!.permanent).toBe(true);
    });

    it("uses /:path* as source to match every path", async () => {
      const redirects = await nextConfig.redirects!();
      const rule = redirects.find(
        (r) =>
          Array.isArray((r as { has?: unknown[] }).has) &&
          (r as { has: Array<{ type: string; value: string }> }).has.some(
            (h) =>
              h.type === "host" && h.value === "dlectroflow.dlectronique.dev",
          ),
      );
      expect(rule).toBeDefined();
      // /:path* captures the full path so deep links are preserved.
      expect(rule!.source).toBe("/:path*");
    });

    it("matches only the legacy host (has condition type=host)", async () => {
      const redirects = await nextConfig.redirects!();
      const rule = redirects.find(
        (r) =>
          Array.isArray((r as { has?: unknown[] }).has) &&
          (r as { has: Array<{ type: string; value: string }> }).has.some(
            (h) =>
              h.type === "host" && h.value === "dlectroflow.dlectronique.dev",
          ),
      );
      expect(rule).toBeDefined();
      const hasConditions = (
        rule as { has: Array<{ type: string; value: string }> }
      ).has;
      const hostCondition = hasConditions.find((h) => h.type === "host");
      expect(hostCondition).toBeDefined();
      expect(hostCondition!.value).toBe("dlectroflow.dlectronique.dev");
    });

    it("destination preserves path via :path* so deep links are not dropped", async () => {
      const redirects = await nextConfig.redirects!();
      const rule = redirects.find(
        (r) =>
          Array.isArray((r as { has?: unknown[] }).has) &&
          (r as { has: Array<{ type: string; value: string }> }).has.some(
            (h) =>
              h.type === "host" && h.value === "dlectroflow.dlectronique.dev",
          ),
      );
      expect(rule).toBeDefined();
      // The destination must contain /:path* so Next.js substitutes the
      // captured path segment — a bare https://dlectroflow.dev would drop it.
      expect(rule!.destination).toContain("/:path*");
    });
  });
});
