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

vi.mock("@/lib/origin", () => ({
  requestOrigin: () => "https://dlectroflow.test",
}));

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
