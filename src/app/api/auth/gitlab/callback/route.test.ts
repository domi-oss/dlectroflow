import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  cookiesMock,
  exchangeCodeMock,
  fetchProfileMock,
  provisionMock,
  signUserSessionMock,
} = vi.hoisted(() => ({
  cookiesMock: vi.fn(),
  exchangeCodeMock: vi.fn(),
  fetchProfileMock: vi.fn(),
  provisionMock: vi.fn(),
  signUserSessionMock: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: cookiesMock }));

vi.mock("@/lib/auth/providers", () => ({
  getAuthProvider: () => ({
    exchangeCode: exchangeCodeMock,
    fetchProfile: fetchProfileMock,
  }),
}));

vi.mock("@/lib/auth/provisioning", () => ({
  provisionFromProfile: provisionMock,
}));

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...actual, signUserSession: signUserSessionMock };
});

// Only `requestOrigin` is stubbed. `inboundHost` keeps its real implementation
// on purpose — the host-precedence tests below exist to exercise it, and a mock
// would assert the mock.
vi.mock("@/lib/origin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/origin")>();
  return { ...actual, requestOrigin: () => "https://dlectroflow.test" };
});

import { GET } from "./route";
import { OWNER_COOKIE, USER_SESSION_TTL_SECONDS } from "@/lib/auth/session";

// A cookie jar carrying a matching OAuth state + PKCE verifier, i.e. everything
// the callback needs before it gets as far as the authorization decision.
function validJar() {
  return {
    get: (name: string) =>
      name === "gitlab_oauth_state"
        ? { value: "st" }
        : name === "gitlab_pkce_verifier"
          ? { value: "ver" }
          : undefined,
  };
}

const CALLBACK_URL =
  "https://dlectroflow.test/api/auth/gitlab/callback?code=c&state=st";

beforeEach(() => {
  vi.clearAllMocks();
  cookiesMock.mockResolvedValue(validJar());
  exchangeCodeMock.mockResolvedValue("access-token");
  fetchProfileMock.mockResolvedValue({
    subject: "42",
    username: "domi",
    email: "d@example.com",
  });
  signUserSessionMock.mockResolvedValue("signed.jwt.value");
  vi.stubEnv("AUTH_SESSION_SECRET", "x".repeat(32));
  vi.stubEnv("AUTH_PROVIDER", "gitlab");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("gitlab oauth callback — authorization", () => {
  it("signs a user session for a provisioned account and sets the cookie", async () => {
    provisionMock.mockResolvedValue({
      ok: true,
      userId: "u1",
      workspaceId: "ws1",
      role: "owner",
    });

    const res = await GET(new Request(CALLBACK_URL));

    expect(signUserSessionMock).toHaveBeenCalledWith(
      { kind: "user", userId: "u1", wsId: "ws1" },
      "x".repeat(32),
    );
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${OWNER_COOKIE}=signed.jwt.value`);
    expect(cookie).toContain(`Max-Age=${USER_SESSION_TTL_SECONDS}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(res.headers.get("location")).toBe("https://dlectroflow.test/");
  });

  it("passes the configured provider and the fetched profile to provisioning", async () => {
    provisionMock.mockResolvedValue({
      ok: true,
      userId: "u1",
      workspaceId: "ws1",
      role: "member",
    });

    await GET(new Request(CALLBACK_URL));

    expect(provisionMock).toHaveBeenCalledWith("gitlab", {
      subject: "42",
      username: "domi",
      email: "d@example.com",
    });
  });

  // The allowlist must not be enumerable. If "you were revoked" and "you were
  // never invited" produced different responses, anyone could probe whether an
  // identity is known to this instance.
  it("returns an identical error for not-invited and revoked", async () => {
    provisionMock.mockResolvedValueOnce({
      ok: false,
      reason: "not_invited",
    });
    const notInvited = await GET(new Request(CALLBACK_URL));

    provisionMock.mockResolvedValueOnce({ ok: false, reason: "revoked" });
    const revoked = await GET(new Request(CALLBACK_URL));

    expect(notInvited.status).toBe(revoked.status);
    expect(notInvited.headers.get("location")).toBe(
      revoked.headers.get("location"),
    );
    expect(notInvited.headers.get("location")).toBe(
      "https://dlectroflow.test/login?error=not_authorized",
    );
  });

  it("sets no session cookie on a denied sign-in", async () => {
    provisionMock.mockResolvedValue({ ok: false, reason: "not_invited" });

    const res = await GET(new Request(CALLBACK_URL));

    expect(res.headers.get("set-cookie") ?? "").not.toContain(
      `${OWNER_COOKIE}=signed`,
    );
    expect(signUserSessionMock).not.toHaveBeenCalled();
  });

  it("never reaches provisioning when the OAuth state does not match", async () => {
    const res = await GET(
      new Request(
        "https://dlectroflow.test/api/auth/gitlab/callback?code=c&state=wrong",
      ),
    );

    expect(provisionMock).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe(
      "https://dlectroflow.test/login?error=state_mismatch",
    );
  });

  it("fails closed when the provider profile fetch throws", async () => {
    fetchProfileMock.mockRejectedValue(new Error("GitLab user fetch failed"));

    const res = await GET(new Request(CALLBACK_URL));

    expect(provisionMock).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("/login?error=");
  });
});

// #174 — the callback cannot tell an expired attempt from one begun in a
// different browser: both leave the state and PKCE cookies simply absent. It
// CAN tell either of those from a malformed return, and that distinction is
// what turns "Sign-in failed. Please try again." into something the reader can
// act on. The reasons below feed the login page's copy, so they are part of the
// contract, not an internal detail.
describe("gitlab oauth callback — telling a lost attempt from a broken one", () => {
  const emptyJar = { get: () => undefined };

  it("reports an absent verifier and state as expired, not as missing params", async () => {
    cookiesMock.mockResolvedValue(emptyJar);

    const res = await GET(new Request(CALLBACK_URL));

    expect(res.headers.get("location")).toBe(
      "https://dlectroflow.test/login?error=expired",
    );
  });

  it("reports an absent verifier alone as expired", async () => {
    cookiesMock.mockResolvedValue({
      get: (name: string) =>
        name === "gitlab_oauth_state" ? { value: "st" } : undefined,
    });

    const res = await GET(new Request(CALLBACK_URL));

    expect(res.headers.get("location")).toBe(
      "https://dlectroflow.test/login?error=expired",
    );
  });

  it("keeps missing_oauth_params for a return with no code or state in the URL", async () => {
    // A malformed return is not an expiry — the browser still holds the cookies.
    for (const url of [
      "https://dlectroflow.test/api/auth/gitlab/callback",
      "https://dlectroflow.test/api/auth/gitlab/callback?code=c",
      "https://dlectroflow.test/api/auth/gitlab/callback?state=st",
    ]) {
      const res = await GET(new Request(url));
      expect(res.headers.get("location")).toBe(
        "https://dlectroflow.test/login?error=missing_oauth_params",
      );
    }
  });

  it("still fails closed, and never reaches provisioning, when the cookies are gone", async () => {
    // The reason string got friendlier; the gate did not move.
    cookiesMock.mockResolvedValue(emptyJar);

    await GET(new Request(CALLBACK_URL));

    expect(exchangeCodeMock).not.toHaveBeenCalled();
    expect(provisionMock).not.toHaveBeenCalled();
    expect(signUserSessionMock).not.toHaveBeenCalled();
  });

  it("still calls a mismatched state a mismatch, not an expiry", async () => {
    const res = await GET(
      new Request(
        "https://dlectroflow.test/api/auth/gitlab/callback?code=c&state=wrong",
      ),
    );

    expect(res.headers.get("location")).toBe(
      "https://dlectroflow.test/login?error=state_mismatch",
    );
  });
});

// #174 — the whole reason this bug took an ingress access log to diagnose is
// that the callback failed silently. These assert the log line exists and
// carries the two fields that would have answered it: the reason, and the host
// the request actually arrived on.
describe("gitlab oauth callback — failure telemetry (#174)", () => {
  const emptyJar = { get: () => undefined };

  const warned = () =>
    vi
      .mocked(console.warn)
      .mock.calls.map((c) => JSON.parse(c[0] as string))
      .filter((l) => l.tag === "auth_failure");

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("emits one auth_failure line naming the reason", async () => {
    cookiesMock.mockResolvedValue(emptyJar);

    await GET(new Request(CALLBACK_URL));

    expect(warned()).toHaveLength(1);
    expect(warned()[0]).toMatchObject({ reason: "expired" });
  });

  // The field that IS the bug. `origin` is derived and would report the
  // canonical hostname on every request, including the ones whose whole problem
  // is that they arrived somewhere else — so the Host header is read directly.
  it("records the host the request actually arrived on, not the canonical one", async () => {
    cookiesMock.mockResolvedValue(emptyJar);

    await GET(
      new Request(CALLBACK_URL, { headers: { host: "dlectroflow.dev" } }),
    );

    expect(warned()[0]).toMatchObject({ host: "dlectroflow.dev" });
  });

  // Caught in review on !280. TLS terminates at ingress-nginx, so the raw Host
  // the pod sees is not the hostname the browser used — and this field exists
  // for no other purpose than to name that hostname. Reading bare `Host` would
  // have made the one diagnostic #174 adds report the wrong answer in precisely
  // the deployment that caused #174.
  it("prefers x-forwarded-host, because the pod sits behind ingress", async () => {
    cookiesMock.mockResolvedValue(emptyJar);

    await GET(
      new Request(CALLBACK_URL, {
        headers: {
          host: "dlectroflow.svc.cluster.local",
          "x-forwarded-host": "dlectroflow.dev",
        },
      }),
    );

    expect(warned()[0]).toMatchObject({ host: "dlectroflow.dev" });
  });

  // Each proxy in a chain appends; the client-facing hostname is the first.
  it("takes the first entry when the forwarded header carries a chain", async () => {
    cookiesMock.mockResolvedValue(emptyJar);

    await GET(
      new Request(CALLBACK_URL, {
        headers: { "x-forwarded-host": "dlectroflow.dev, internal.lb" },
      }),
    );

    expect(warned()[0]).toMatchObject({ host: "dlectroflow.dev" });
  });

  // Distinguishes "the cookies were never set" from "they were set and one did
  // not match" without needing a second log line or a second reason string.
  it("says which of the two cookies survived", async () => {
    await GET(
      new Request(
        "https://dlectroflow.test/api/auth/gitlab/callback?code=c&state=wrong",
      ),
    );

    expect(warned()[0]).toMatchObject({
      reason: "state_mismatch",
      hadState: true,
      hadVerifier: true,
    });
  });

  it("stays quiet on a successful sign-in", async () => {
    provisionMock.mockResolvedValue({ ok: true, userId: "u1" });

    await GET(new Request(CALLBACK_URL));

    expect(warned()).toEqual([]);
  });
});
