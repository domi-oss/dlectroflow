import { describe, it, expect, afterEach } from "vitest";
import { publicOrigin, canonicalOriginRedirect, inboundHost } from "./origin";

describe("publicOrigin", () => {
  const savedOrigin = process.env.PUBLIC_ORIGIN;
  const savedNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.PUBLIC_ORIGIN = savedOrigin;
    // NODE_ENV is read-only-ish under some setups; reassign defensively.
    (process.env as Record<string, string | undefined>).NODE_ENV = savedNodeEnv;
  });

  it("returns PUBLIC_ORIGIN when set", () => {
    process.env.PUBLIC_ORIGIN = "https://dlectroflow.dev";
    expect(publicOrigin()).toBe("https://dlectroflow.dev");
  });

  it("strips trailing slashes from PUBLIC_ORIGIN", () => {
    process.env.PUBLIC_ORIGIN = "https://dlectroflow.dev//";
    expect(publicOrigin()).toBe("https://dlectroflow.dev");
  });

  it("falls back to localhost in non-production when PUBLIC_ORIGIN is unset", () => {
    delete process.env.PUBLIC_ORIGIN;
    (process.env as Record<string, string | undefined>).NODE_ENV =
      "development";
    expect(publicOrigin()).toBe("http://localhost:3000");
  });

  it("refuses to guess in production when PUBLIC_ORIGIN is unset", () => {
    delete process.env.PUBLIC_ORIGIN;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    expect(() => publicOrigin()).toThrow(/PUBLIC_ORIGIN/);
  });
});

// #174 — the OAuth flow can only complete on the ONE origin PUBLIC_ORIGIN
// names, because the PKCE verifier and state cookies are host-only. An auth
// path arriving on another hostname has to be moved there before it sets a
// cookie. Which paths those are is isCanonicalOriginPath (auth/gate.ts).
describe("canonicalOriginRedirect", () => {
  const savedOrigin = process.env.PUBLIC_ORIGIN;
  afterEach(() => {
    process.env.PUBLIC_ORIGIN = savedOrigin;
  });

  const CANONICAL = "https://canonical.example";

  it("redirects an off-canonical host, preserving path and query", () => {
    process.env.PUBLIC_ORIGIN = CANONICAL;
    expect(
      canonicalOriginRedirect({
        host: "legacy.example",
        pathname: "/api/auth/gitlab/start",
        search: "?a=1&b=2",
      }),
    ).toBe("https://canonical.example/api/auth/gitlab/start?a=1&b=2");
  });

  it("returns null when the request is already on the canonical host", () => {
    process.env.PUBLIC_ORIGIN = CANONICAL;
    expect(
      canonicalOriginRedirect({
        host: "canonical.example",
        pathname: "/login",
        search: "",
      }),
    ).toBeNull();
  });

  it("compares hosts case-insensitively", () => {
    process.env.PUBLIC_ORIGIN = CANONICAL;
    expect(
      canonicalOriginRedirect({
        host: "Canonical.Example",
        pathname: "/login",
        search: "",
      }),
    ).toBeNull();
  });

  it("keeps the port in the comparison, so a wrong-port host is redirected", () => {
    process.env.PUBLIC_ORIGIN = "https://canonical.example:8443";
    expect(
      canonicalOriginRedirect({
        host: "canonical.example",
        pathname: "/login",
        search: "",
      }),
    ).toBe("https://canonical.example:8443/login");
  });

  it("tolerates a trailing slash on PUBLIC_ORIGIN", () => {
    process.env.PUBLIC_ORIGIN = "https://canonical.example/";
    expect(
      canonicalOriginRedirect({
        host: "legacy.example",
        pathname: "/login",
        search: "",
      }),
    ).toBe("https://canonical.example/login");
  });

  // SECURITY, two independent layers. `new URL("//evil.example", base)` resolves
  // to https://evil.example — a protocol-relative path escapes the origin
  // entirely — which is why the implementation assigns `.pathname` instead. The
  // path classifier refuses those shapes first, but the guard is asserted here
  // rather than assumed, because the classifier is not the guard: whatever comes
  // back is either nothing at all or an URL on the canonical origin.
  it.each([
    "//evil.example/login",
    "//evil.example",
    "/login//evil.example",
    "/api/auth/..//evil.example",
    "/login/%2e%2e/%2e%2e/x",
    "/api/auth/\\evil.example",
  ])("cannot be walked off the canonical origin by %s", (pathname) => {
    process.env.PUBLIC_ORIGIN = CANONICAL;
    const target = canonicalOriginRedirect({
      host: "legacy.example",
      pathname,
      search: "",
    });
    if (target !== null) {
      expect(new URL(target).host).toBe("canonical.example");
    }
  });

  it("never redirects to the inbound host, however hostile the Host header", () => {
    process.env.PUBLIC_ORIGIN = CANONICAL;
    const target = canonicalOriginRedirect({
      host: "evil.example",
      pathname: "/login",
      search: "",
    });
    expect(target).toBe("https://canonical.example/login");
  });

  // Kubernetes probes address the pod by IP, so their Host header is never the
  // canonical one. A 3xx counts as probe success to the kubelet, which would
  // make readiness go green without /api/health ever running its SELECT 1.
  // They are safe because they sit outside CANONICAL_ORIGIN_PREFIXES, and this
  // asserts that stays true rather than trusting it to.
  it.each(["/api/health", "/api/livez"])(
    "never redirects the probe path %s",
    (pathname) => {
      process.env.PUBLIC_ORIGIN = CANONICAL;
      expect(
        canonicalOriginRedirect({
          host: "10.65.129.68:3000",
          pathname,
          search: "",
        }),
      ).toBeNull();
    },
  );

  // The apex and any other served hostname must keep answering 200 on the
  // pages Google's OAuth reviewers fetch cold — see .gitlab-ci.yml's
  // deploy_production. A blanket canonical-host redirect would break that, so
  // only the auth journey moves.
  it.each(["/", "/privacy", "/terms", "/api/ics/feed/tok"])(
    "leaves %s served on whatever hostname it arrived at",
    (pathname) => {
      process.env.PUBLIC_ORIGIN = CANONICAL;
      expect(
        canonicalOriginRedirect({
          host: "legacy.example",
          pathname,
          search: "",
        }),
      ).toBeNull();
    },
  );

  it.each([
    "/login",
    "/api/auth/gitlab/start",
    "/api/auth/gitlab/callback",
    "/api/auth/logout",
    "/api/google/oauth/start",
  ])("moves the auth path %s", (pathname) => {
    process.env.PUBLIC_ORIGIN = CANONICAL;
    expect(
      canonicalOriginRedirect({ host: "legacy.example", pathname, search: "" }),
    ).toBe(`https://canonical.example${pathname}`);
  });

  it("does not treat a lookalike of /login as an auth path", () => {
    process.env.PUBLIC_ORIGIN = CANONICAL;
    expect(
      canonicalOriginRedirect({
        host: "legacy.example",
        pathname: "/loginhack",
        search: "",
      }),
    ).toBeNull();
  });

  it("does nothing when PUBLIC_ORIGIN is unset (local dev, any hostname is fine)", () => {
    delete process.env.PUBLIC_ORIGIN;
    expect(
      canonicalOriginRedirect({
        host: "localhost:3000",
        pathname: "/login",
        search: "",
      }),
    ).toBeNull();
  });

  it("does nothing when the request carries no Host header", () => {
    process.env.PUBLIC_ORIGIN = CANONICAL;
    expect(
      canonicalOriginRedirect({ host: null, pathname: "/login", search: "" }),
    ).toBeNull();
  });

  it("does nothing when PUBLIC_ORIGIN is not a parseable URL", () => {
    process.env.PUBLIC_ORIGIN = "not a url";
    expect(
      canonicalOriginRedirect({
        host: "legacy.example",
        pathname: "/login",
        search: "",
      }),
    ).toBeNull();
  });
});

// Extracted in review on !280 after the #174 diagnostic field was found reading
// a bare `Host`. Tested directly because it is now shared by the proxy's
// canonical-origin comparison and the auth-failure log line, and a regression
// in either is silent.
describe("inboundHost", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("prefers x-forwarded-host over host", () => {
    expect(
      inboundHost(
        h({ host: "pod.internal", "x-forwarded-host": "dlectroflow.dev" }),
      ),
    ).toBe("dlectroflow.dev");
  });

  it("takes the client-facing entry when a proxy chain appended to it", () => {
    expect(
      inboundHost(h({ "x-forwarded-host": "a.example, b.internal" })),
    ).toBe("a.example");
  });

  it("falls back to host when nothing was forwarded", () => {
    expect(inboundHost(h({ host: "dlectroflow.dev" }))).toBe("dlectroflow.dev");
  });

  // An empty forwarded header must not win the `||` and shadow a real Host.
  it("ignores an empty forwarded header rather than returning a blank host", () => {
    expect(
      inboundHost(h({ host: "real.example", "x-forwarded-host": "" })),
    ).toBe("real.example");
  });

  it("returns null when the request carries neither", () => {
    expect(inboundHost(h({}))).toBeNull();
  });
});
