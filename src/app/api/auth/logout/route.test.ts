import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextResponse } from "next/server";
import { requestOrigin } from "@/lib/origin";
import { OWNER_COOKIE } from "@/lib/auth/session";
import * as logout from "./route";

// Item 7b (#21 P5 batch B): logout is a state change and must be CSRF-safe.
// The old handler cleared the owner cookie on a bare GET, so a link / prefetch /
// <img src> could force a sign-out. It is now POST-only.
vi.mock("@/lib/origin");

describe("owner logout route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requestOrigin).mockReturnValue(
      "https://dlectroflow.dlectronique.dev",
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("does NOT expose a GET handler (no cookie-clearing on GET)", () => {
    expect((logout as Record<string, unknown>).GET).toBeUndefined();
  });

  it("POST clears the owner cookie and redirects to /inbox", async () => {
    expect(typeof logout.POST).toBe("function");
    const res = (await logout.POST(
      new Request("https://dlectroflow.dlectronique.dev/api/auth/logout", {
        method: "POST",
      }),
    )) as NextResponse;

    // Redirect back into the app (303 → follow-up GET after the POST).
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://dlectroflow.dlectronique.dev/inbox",
    );

    // The owner cookie is expired/cleared.
    const cleared = res.cookies.get(OWNER_COOKIE);
    expect(cleared?.value).toBe("");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${OWNER_COOKIE}=`);
    expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  // Defense-in-depth (CWE-352): SameSite=lax does not block *same-site* POST, so a
  // page on the same eTLD+1 (e.g. a subdomain) could POST here to force a sign-out.
  // Reject when an Origin header is present but does not match our origin.
  it("rejects a cross-origin POST with 403 and does NOT clear the cookie", async () => {
    const res = (await logout.POST(
      new Request("https://dlectroflow.dlectronique.dev/api/auth/logout", {
        method: "POST",
        headers: { origin: "https://evil.example.com" },
      }),
    )) as NextResponse;

    expect(res.status).toBe(403);
    // No sign-out happened — no Set-Cookie on the rejected request.
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("allows a same-origin POST (matching Origin header) and clears the cookie", async () => {
    const res = (await logout.POST(
      new Request("https://dlectroflow.dlectronique.dev/api/auth/logout", {
        method: "POST",
        headers: { origin: "https://dlectroflow.dlectronique.dev" },
      }),
    )) as NextResponse;

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://dlectroflow.dlectronique.dev/inbox",
    );
    expect(res.cookies.get(OWNER_COOKIE)?.value).toBe("");
  });

  it("allows a POST with no Origin header (non-browser client)", async () => {
    const res = (await logout.POST(
      new Request("https://dlectroflow.dlectronique.dev/api/auth/logout", {
        method: "POST",
      }),
    )) as NextResponse;

    expect(res.status).toBe(303);
    expect(res.cookies.get(OWNER_COOKIE)?.value).toBe("");
  });
});
