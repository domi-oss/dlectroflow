import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/origin", () => ({
  requestOrigin: () => "https://dlectroflow.test",
}));

import { GET } from "./route";

beforeEach(() => {
  vi.stubEnv("AUTH_PROVIDER", "gitlab");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "cid");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "secret");
});

/** Every Set-Cookie the route emitted, parsed into name → attribute map. */
function cookiesFrom(res: Response) {
  const out = new Map<string, Map<string, string>>();
  for (const raw of res.headers.getSetCookie()) {
    const [pair, ...attrs] = raw.split(";");
    const name = pair.split("=")[0].trim();
    const map = new Map<string, string>();
    map.set("__value", pair.slice(pair.indexOf("=") + 1));
    for (const a of attrs) {
      const [k, v = ""] = a.split("=");
      map.set(k.trim().toLowerCase(), v.trim());
    }
    out.set(name, map);
  }
  return out;
}

const start = () =>
  GET(new Request("https://dlectroflow.test/api/auth/gitlab/start"));

describe("gitlab oauth start", () => {
  it("redirects to the provider with PKCE and a state", async () => {
    const res = await start();
    const url = new URL(res.headers.get("location")!);

    expect(url.origin + url.pathname).toBe(
      "https://gitlab.com/oauth/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://dlectroflow.test/api/auth/gitlab/callback",
    );
  });

  it("sets the state cookie to the exact state it sent the provider", async () => {
    // If these two ever drift the callback rejects every sign-in as a mismatch.
    const res = await start();
    const sent = new URL(res.headers.get("location")!).searchParams.get(
      "state",
    );
    expect(cookiesFrom(res).get("gitlab_oauth_state")!.get("__value")).toBe(
      sent,
    );
  });

  it("mints a fresh state on every call", async () => {
    const a = cookiesFrom(await start()).get("gitlab_oauth_state")!;
    const b = cookiesFrom(await start()).get("gitlab_oauth_state")!;
    expect(a.get("__value")).not.toBe(b.get("__value"));
  });

  // This is authentication state. These four attributes are the reason the
  // verifier cannot be read by script, replayed from another site, or sent in
  // the clear — pinned so a future edit to the TTL below cannot quietly take
  // one of them with it.
  it.each(["gitlab_pkce_verifier", "gitlab_oauth_state"])(
    "hardens %s: httpOnly, secure, sameSite=lax, path=/",
    async (name) => {
      const c = cookiesFrom(await start()).get(name)!;
      expect(c.has("httponly")).toBe(true);
      expect(c.has("secure")).toBe(true);
      expect(c.get("samesite")?.toLowerCase()).toBe("lax");
      expect(c.get("path")).toBe("/");
    },
  );

  it("leaves the cookies non-Secure on an http origin, for local dev", async () => {
    vi.resetModules();
    vi.doMock("@/lib/origin", () => ({
      requestOrigin: () => "http://localhost:3000",
    }));
    const { GET: localGet } = await import("./route");
    const res = await localGet(
      new Request("http://localhost:3000/api/auth/gitlab/start"),
    );
    expect(cookiesFrom(res).get("gitlab_pkce_verifier")!.has("secure")).toBe(
      false,
    );
    vi.doUnmock("@/lib/origin");
    vi.resetModules();
  });

  // #174 — ten minutes was never a realistic budget for an interactive sign-in
  // with an MFA prompt and an app switch, and blowing it is unrecoverable. The
  // upper bound matters as much as the lower: these are pre-authentication
  // nonces, not a session, and should not outlive the attempt by hours.
  it.each(["gitlab_pkce_verifier", "gitlab_oauth_state"])(
    "gives %s a lifetime that fits an interrupted mobile sign-in",
    async (name) => {
      const maxAge = Number(
        cookiesFrom(await start())
          .get(name)!
          .get("max-age"),
      );
      expect(maxAge).toBeGreaterThanOrEqual(15 * 60);
      expect(maxAge).toBeLessThanOrEqual(60 * 60);
    },
  );

  it("gives both cookies the same lifetime", async () => {
    // A verifier that outlives its state (or vice versa) turns an expiry into a
    // state_mismatch, which the login page reports as an outright failure.
    const c = cookiesFrom(await start());
    expect(c.get("gitlab_pkce_verifier")!.get("max-age")).toBe(
      c.get("gitlab_oauth_state")!.get("max-age"),
    );
  });
});
