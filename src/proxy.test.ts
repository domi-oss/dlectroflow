import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { requestOrigin } from "@/lib/origin";
import {
  GUEST_COOKIE,
  OWNER_COOKIE,
  GUEST_WS_HEADER,
  signGuestSession,
  signUserSession,
} from "@/lib/auth/session";
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
    vi.mocked(requestOrigin).mockReturnValue("https://dlectroflow.dev");
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

// #35 Phase A — AUTHENTICATED_PREFIXES enforcement.
//
// A helper that classifies paths correctly while the middleware ignores it is
// exactly the bug this category exists to prevent, so these drive the real
// middleware rather than the classifier.
const SECRET = "test-secret-at-least-32-bytes-long-xxxxx";
const AUTHED_PATH = "/api/account/export";

describe("proxy: authenticated-only paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SESSION_SECRET = SECRET;
    vi.mocked(requestOrigin).mockReturnValue("https://dlectroflow.dev");
  });
  afterEach(() => vi.restoreAllMocks());

  function reqWith(path: string, cookie?: { name: string; value: string }) {
    const req = new NextRequest(`https://dlectroflow.dev${path}`);
    if (cookie) req.cookies.set(cookie.name, cookie.value);
    return req;
  }

  it("rejects an anonymous request on an authenticated-only path", async () => {
    const res = await proxy(reqWith(AUTHED_PATH));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://dlectroflow.dev/login");
  });

  it("rejects a VALID guest session on an authenticated-only path", async () => {
    // The whole point: a guest session is a real, signed session. It must not
    // be enough here, or Phase C's per-user Google OAuth opens to guests.
    const guest = await signGuestSession("g-1", SECRET, 3600);
    const res = await proxy(
      reqWith(AUTHED_PATH, { name: GUEST_COOKIE, value: guest }),
    );
    expect(res.headers.get("location")).toBe("https://dlectroflow.dev/login");
  });

  it("admits a user session on the same path", async () => {
    const user = await signUserSession(
      { kind: "user", userId: "u1", wsId: "ws-1" },
      SECRET,
    );
    const res = await proxy(
      reqWith(AUTHED_PATH, { name: OWNER_COOKIE, value: user }),
    );
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("does not gate ordinary app paths", async () => {
    const res = await proxy(reqWith("/"));
    expect(res.headers.get("location")).toBeNull();
  });

  // #119 — the guest leg of the OWNER_ONLY_PREFIXES gate. The role half now
  // lives in the handlers (isOwnerRequest), and this asserts the middleware half
  // it is paired with still turns a guest away before any handler runs.
  it("keeps stopping a guest session at the Google OAuth routes", async () => {
    const guest = await signGuestSession("g-1", SECRET, 3600);
    for (const path of [
      "/api/google/oauth/start",
      "/api/google/oauth/callback",
    ]) {
      const res = await proxy(
        reqWith(path, { name: GUEST_COOKIE, value: guest }),
      );
      expect(res.headers.get("location")).toBe("https://dlectroflow.dev/login");
    }
  });
});

describe("proxy: a signed-in user is never also minted a guest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SESSION_SECRET = SECRET;
    vi.mocked(requestOrigin).mockReturnValue("https://dlectroflow.dev");
  });
  afterEach(() => vi.restoreAllMocks());

  it("sets no guest cookie and forwards no guest workspace header", async () => {
    // Otherwise a signed-in account picks up a guest workspace header
    // alongside their own session, and whichever the resolver reads first wins.
    const user = await signUserSession(
      { kind: "user", userId: "u1", wsId: "ws-1" },
      SECRET,
    );
    const req = new NextRequest("https://dlectroflow.dev/");
    req.cookies.set(OWNER_COOKIE, user);

    const res = await proxy(req);

    expect(res.cookies.get(GUEST_COOKIE)).toBeUndefined();
    expect(res.headers.get(GUEST_WS_HEADER)).toBeNull();
  });

  it("still mints a guest sandbox for an anonymous visitor", async () => {
    const res = await proxy(new NextRequest("https://dlectroflow.dev/"));
    expect(res.cookies.get(GUEST_COOKIE)?.value).toBeTruthy();
  });
});
