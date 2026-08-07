import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { requestOrigin, canonicalOriginRedirect } from "@/lib/origin";
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
// `requestOrigin` and `canonicalOriginRedirect` are stubbed; `inboundHost` is
// deliberately NOT. A bare `vi.mock("@/lib/origin")` auto-mocks every export,
// which would leave the host-precedence test below asserting that a mock
// returned what it was told to — the exact hollow-green this suite is supposed
// to prevent. It is the real implementation that has to pick x-forwarded-host
// over Host, because getting that wrong is #174.
vi.mock("@/lib/origin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/origin")>();
  return {
    ...actual,
    requestOrigin: vi.fn(),
    canonicalOriginRedirect: vi.fn(),
  };
});

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

  // #119 — the guest leg of the Google OAuth gate. #118 moved these routes from
  // OWNER_ONLY_PREFIXES into AUTHENTICATED_PREFIXES, which is the whole risk of
  // opening them up: the guest leg has to keep biting from the OTHER category.
  // The role half now lives in the handlers (currentUser).
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

  it("still redirects an ANONYMOUS request away from the Google OAuth start (#118)", async () => {
    // No cookie at all — the other half of "moving out of owner-only must not
    // make this guest-reachable".
    const res = await proxy(reqWith("/api/google/oauth/start"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://dlectroflow.dev/login");
  });

  it("lets a signed-in member through to the Google OAuth start (#118)", async () => {
    // A member's session is a USER session; the middleware cannot tell a member
    // from an owner (no Prisma client on the Edge runtime) and no longer needs
    // to — the handler decides, and after #118 the answer is "any account".
    const user = await signUserSession(
      { kind: "user", userId: "u-member", wsId: "ws-member" },
      SECRET,
    );
    const res = await proxy(
      reqWith("/api/google/oauth/start", {
        name: OWNER_COOKIE,
        value: user,
      }),
    );
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });
});

// #123 — the published legal pages must be reachable by a stranger.
//
// This drives the real middleware rather than isPublicPath() on purpose: the
// failure mode being guarded is "the classifier says public and the middleware
// redirects anyway". Google's OAuth verification reviewer arrives with NO
// cookies, follows no sign-in, and is not a guest yet — if either page answers
// with a redirect to /login, consent-screen verification fails and nothing in
// the app appears broken.
describe("proxy: the legal pages are reachable with no cookies at all (#123)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SESSION_SECRET = SECRET;
    vi.mocked(requestOrigin).mockReturnValue("https://dlectroflow.dev");
  });
  afterEach(() => vi.restoreAllMocks());

  for (const path of ["/privacy", "/terms"]) {
    it(`serves ${path} to a request carrying no session and no guest cookie`, async () => {
      const req = new NextRequest(`https://dlectroflow.dev${path}`);
      expect(req.cookies.getAll()).toEqual([]);

      const res = await proxy(req);

      expect(res.headers.get("location")).toBeNull();
      expect(res.status).toBe(200);
    });

    it(`mints no guest sandbox for ${path}`, async () => {
      // A public path returns before the guest-minting branch. Worth asserting:
      // a reader of the privacy policy should not have a workspace created for
      // them by reading it, and the policy says the guest cookie is set when you
      // use the app.
      const res = await proxy(
        new NextRequest(`https://dlectroflow.dev${path}`),
      );
      expect(res.cookies.get(GUEST_COOKIE)).toBeUndefined();
      expect(res.headers.get(GUEST_WS_HEADER)).toBeNull();
    });
  }
});

// #154 — the calendar subscription feed must be reachable by a calendar client.
//
// Same shape as the legal-pages test above and for the same reason: this drives
// the real middleware rather than isPublicPath(), because the failure being
// guarded is "the classifier says public and the middleware redirects anyway".
// A calendar app has no cookie, cannot follow a sign-in, and reports a redirect
// as a feed that simply stopped updating — silently, in everybody's calendar.
describe("proxy: the calendar feed is reachable with no cookies at all (#154)", () => {
  const FEED = `/api/ics/feed/${"T".repeat(43)}`;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SESSION_SECRET = SECRET;
    vi.mocked(requestOrigin).mockReturnValue("https://dlectroflow.dev");
  });
  afterEach(() => vi.restoreAllMocks());

  it("serves the feed to a request carrying no session and no guest cookie", async () => {
    const req = new NextRequest(`https://dlectroflow.dev${FEED}`);
    expect(req.cookies.getAll()).toEqual([]);

    const res = await proxy(req);

    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("mints no guest sandbox for a feed poll", async () => {
    // A calendar client polls every few minutes forever. Minting a guest
    // workspace each time would create rows for a subscriber who is not using
    // the app at all, and the route resolves its workspace from the token.
    const res = await proxy(new NextRequest(`https://dlectroflow.dev${FEED}`));
    expect(res.cookies.get(GUEST_COOKIE)).toBeUndefined();
    expect(res.headers.get(GUEST_WS_HEADER)).toBeNull();
  });

  it("still gates the per-task ICS download, which is session-scoped", async () => {
    // The public prefix is `/api/ics/feed`, not `/api/ics`. A task id is
    // guessable in a way a 256-bit token is not.
    const res = await proxy(
      new NextRequest("https://dlectroflow.dev/api/ics/some-task-id"),
    );
    expect(res.cookies.get(GUEST_COOKIE)).toBeDefined();
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

// #174 — the canonical-origin redirect runs FIRST, ahead of every session
// decision. A sign-in begun on an off-canonical hostname sets its PKCE verifier
// and state cookies there and can never complete, because the provider returns
// the browser to the PUBLIC_ORIGIN host, where host-only cookies are not sent.
describe("proxy: canonical-origin redirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SESSION_SECRET = SECRET;
    vi.mocked(requestOrigin).mockReturnValue("https://canonical.example");
  });
  afterEach(() => vi.restoreAllMocks());

  it("307s an off-canonical request to the target the helper computed", async () => {
    vi.mocked(canonicalOriginRedirect).mockReturnValue(
      "https://canonical.example/login?error=x",
    );

    const res = await proxy(new NextRequest("https://legacy.example/login"));

    // 307, not 308: a permanent redirect between two hostnames the deployment
    // can re-point is cached by the browser, and flipping the canonical host
    // afterwards leaves a cache-only loop no reload can clear.
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://canonical.example/login?error=x",
    );
  });

  it("is passed the inbound Host header, the pathname and the query", async () => {
    vi.mocked(canonicalOriginRedirect).mockReturnValue(null);

    await proxy(
      new NextRequest("https://legacy.example/api/auth/gitlab/start?next=%2Fa"),
    );

    expect(canonicalOriginRedirect).toHaveBeenCalledWith({
      host: "legacy.example",
      pathname: "/api/auth/gitlab/start",
      search: "?next=%2Fa",
    });
  });

  it("prefers x-forwarded-host, and takes only its first entry", async () => {
    // Mirrors requestOrigin(): behind the ingress the pod's own Host header is
    // useless, and a forwarded chain arrives comma-separated.
    vi.mocked(canonicalOriginRedirect).mockReturnValue(null);

    await proxy(
      new NextRequest("https://pod.internal/x", {
        headers: { "x-forwarded-host": "legacy.example, proxy.internal" },
      }),
    );

    expect(canonicalOriginRedirect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "legacy.example" }),
    );
  });

  it("mints no guest cookie on the way out — it would land on the wrong host", async () => {
    vi.mocked(canonicalOriginRedirect).mockReturnValue(
      "https://canonical.example/",
    );

    const res = await proxy(new NextRequest("https://legacy.example/"));

    expect(res.cookies.get(GUEST_COOKIE)).toBeUndefined();
  });

  it("redirects before the /login bounce, so an off-canonical guest is not sent to a login page it cannot use", async () => {
    vi.mocked(canonicalOriginRedirect).mockReturnValue(
      "https://canonical.example/api/account/export",
    );

    const res = await proxy(
      new NextRequest("https://legacy.example/api/account/export"),
    );

    expect(res.headers.get("location")).toBe(
      "https://canonical.example/api/account/export",
    );
  });

  it("leaves a canonical request completely alone", async () => {
    vi.mocked(canonicalOriginRedirect).mockReturnValue(null);

    const res = await proxy(new NextRequest("https://canonical.example/"));

    expect(res.status).toBe(200);
    expect(res.cookies.get(GUEST_COOKIE)?.value).toBeTruthy();
  });
});
