import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { requestOrigin } from "@/lib/origin";
import { GUEST_COOKIE } from "@/lib/auth/session";
import { proxy } from "./proxy";

// Item 6a (#21 P5 batch B): the guest session cookie must be marked `Secure`
// based on the DEPLOYED origin (PUBLIC_ORIGIN), not the pod-observed request
// protocol. Behind ingress-nginx TLS terminates at the ingress, so the pod sees
// http:// — the old `req.nextUrl.protocol === "https:"` check left the guest
// cookie non-Secure in production. We mirror the owner cookie: derive from
// requestOrigin (which pins PUBLIC_ORIGIN in prod).
vi.mock("@/lib/origin");

describe("proxy: guest session cookie Secure flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SESSION_SECRET =
      "test-secret-at-least-32-bytes-long-xxxxx";
  });
  afterEach(() => vi.restoreAllMocks());

  it("marks the guest cookie Secure when the deployed origin is https, even on an http pod request", async () => {
    vi.mocked(requestOrigin).mockReturnValue(
      "https://dlectroflow.dlectronique.dev",
    );
    // Pod sees http:// behind the ingress.
    const req = new NextRequest("http://pod.internal/");
    const res = await proxy(req);
    const cookie = res.cookies.get(GUEST_COOKIE);
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.secure).toBe(true);
    // regression: other hardening attributes preserved
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/");
  });

  it("leaves the guest cookie non-Secure for an http origin (local dev)", async () => {
    vi.mocked(requestOrigin).mockReturnValue("http://localhost:3000");
    const req = new NextRequest("http://localhost:3000/");
    const res = await proxy(req);
    const cookie = res.cookies.get(GUEST_COOKIE);
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.secure).toBe(false);
  });
});
