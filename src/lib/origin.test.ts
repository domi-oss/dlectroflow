import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  publicOrigin,
  canonicalOriginRedirect,
  hasDisallowedOrigin,
  inboundHost,
  _resetOriginWarningForTest,
} from "./origin";

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

/**
 * #175 — the CSRF comparand (CWE-352).
 *
 * `src/app/api/braindump/route.test.ts` asserts what the ROUTE does with the
 * answer (a 400 that writes no row, and does not borrow the 403/409 the queue maps
 * to sign-in copy). What is asserted HERE is the predicate itself, and
 * specifically the branches a route test reaches awkwardly or not at all: the
 * fail-closed arms, the normalisation, and the difference between an ABSENT
 * `Origin` and the string `"null"`.
 */
describe("hasDisallowedOrigin", () => {
  /** A POST as a proxy delivers it: arrival host forwarded, plus any extras. */
  const req = (arrivedOn: string, headers: Record<string, string> = {}) =>
    new Request(`https://${arrivedOn}/api/braindump`, {
      method: "POST",
      headers: { "x-forwarded-host": arrivedOn, ...headers },
    });

  const CANONICAL = "work.dlectroflow.dev";
  /** Served by the same ingress with no redirect — `legacyHosts[1]`. */
  const APEX = "dlectroflow.dev";

  it("allows an Origin matching the host the request arrived on", () => {
    expect(
      hasDisallowedOrigin(req(CANONICAL, { origin: `https://${CANONICAL}` })),
    ).toBe(false);
  });

  // ⚠️ The #175 regression, at the level the bug actually lived: a request from a
  // hostname this deployment serves but PUBLIC_ORIGIN does not name. Pinned with
  // PUBLIC_ORIGIN SET, because unset is the configuration in which the old
  // comparand accidentally behaved — an unstubbed test cannot see this.
  it("allows a served hostname PUBLIC_ORIGIN does not name", () => {
    vi.stubEnv("PUBLIC_ORIGIN", `https://${CANONICAL}`);
    expect(hasDisallowedOrigin(req(APEX, { origin: `https://${APEX}` }))).toBe(
      false,
    );
  });

  it("refuses an attacker's Origin against either served host", () => {
    vi.stubEnv("PUBLIC_ORIGIN", `https://${CANONICAL}`);
    const forged = { origin: "https://evil.example" };
    expect(hasDisallowedOrigin(req(CANONICAL, forged))).toBe(true);
    expect(hasDisallowedOrigin(req(APEX, forged))).toBe(true);
  });

  // The two served hostnames are different origins to a browser, and the app's own
  // capture fetch is a relative path — so this is never a request the app makes,
  // and widening to "any host we serve" would have been over-widening.
  it("refuses one served host's Origin against the other's Host", () => {
    expect(
      hasDisallowedOrigin(req(APEX, { origin: `https://${CANONICAL}` })),
    ).toBe(true);
  });

  // A MISSING header is the deliberate non-browser allowance. `"null"` is a real
  // value a browser SENDS — an opaque origin: a sandboxed iframe, or a POST that
  // arrived via a cross-origin redirect — so the two must not collapse, which is
  // why the implementation tests for `=== null` rather than for falsiness.
  //
  // The EMPTY string is the input that separates `=== null` from a falsiness
  // check, and it is why the implementation is written the stricter way: `!declared`
  // would wave `Origin: ""` through as if the header had not been sent.
  it("allows an absent Origin but refuses the opaque string 'null'", () => {
    expect(hasDisallowedOrigin(req(CANONICAL))).toBe(false);
    expect(hasDisallowedOrigin(req(CANONICAL, { origin: "null" }))).toBe(true);
    expect(hasDisallowedOrigin(req(CANONICAL, { origin: "" }))).toBe(true);
  });

  it("refuses a scheme downgrade on the right host", () => {
    expect(
      hasDisallowedOrigin(req(CANONICAL, { origin: `http://${CANONICAL}` })),
    ).toBe(true);
  });

  it.each([
    `https://${CANONICAL}.evil.example`,
    `https://evil.${CANONICAL}`,
    `https://${CANONICAL}/`,
  ])("refuses the near-miss %s", (origin) => {
    expect(hasDisallowedOrigin(req(CANONICAL, { origin }))).toBe(true);
  });

  // Case and a default port are normalised because the browser normalised them
  // first: it lowercases the host and omits `:443`, so a proxy that forwarded
  // either form would otherwise refuse every request rather than none.
  it.each([
    ["an upper-case forwarded host", CANONICAL.toUpperCase()],
    ["an explicit default port", `${CANONICAL}:443`],
  ])("normalises %s the way the browser already did", (_label, arrivedOn) => {
    expect(
      hasDisallowedOrigin(
        new Request(`https://${CANONICAL}/api/braindump`, {
          method: "POST",
          headers: {
            "x-forwarded-host": arrivedOn,
            origin: `https://${CANONICAL}`,
          },
        }),
      ),
    ).toBe(false);
  });

  it("takes only the first entry of a forwarded chain", () => {
    expect(
      hasDisallowedOrigin(
        new Request(`https://${CANONICAL}/api/braindump`, {
          method: "POST",
          headers: {
            "x-forwarded-host": `${CANONICAL}, internal.lb`,
            origin: `https://${CANONICAL}`,
          },
        }),
      ),
    ).toBe(false);
  });

  // No proxy in front: `npm run dev`, or a self-host terminating TLS in the app.
  it("compares against a bare Host when nothing forwarded one", () => {
    const bare = (origin: string) =>
      hasDisallowedOrigin(
        new Request("http://localhost:3000/api/braindump", {
          method: "POST",
          headers: { host: "localhost:3000", origin },
        }),
      );
    expect(bare("http://localhost:3000")).toBe(false);
    expect(bare("http://localhost:3001")).toBe(true);
  });

  // ⚠️ Fail closed. An Origin that cannot be checked is not an Origin that can be
  // allowed — the opposite reading turns the guard into a formality, and it is the
  // same failure `canonicalOriginRedirect`'s unparseable-PUBLIC_ORIGIN branch was
  // pulled up on in !280.
  //
  // A non-http scheme is the case that matters most: without the http/https
  // restriction `new URL("javascript://h").origin` is the literal `"null"`, which
  // would MATCH a browser's opaque `Origin: null` and turn a sentinel collision
  // into an allow. Neither proxy lets a spoofed `x-forwarded-proto` reach the pod,
  // so this is defence in depth rather than a live hole — but a security
  // comparison must not depend on that being true forever.
  it.each([
    ["a non-http forwarded scheme", { "x-forwarded-proto": "javascript" }],
    ["a garbage forwarded scheme", { "x-forwarded-proto": "" }],
  ])("refuses rather than allowing when it cannot verify — %s", (_l, extra) => {
    expect(
      hasDisallowedOrigin(req(CANONICAL, { origin: "null", ...extra })),
    ).toBe(true);
    expect(
      hasDisallowedOrigin(
        req(CANONICAL, { origin: `https://${CANONICAL}`, ...extra }),
      ),
    ).toBe(true);
  });

  it("trusts the forwarded proto over the URL's own scheme", () => {
    // Behind a TLS-terminating ingress the pod is spoken to over http, so the
    // request URL's scheme is not the browser's. Both proxies overwrite this
    // header, so it is the trustworthy half of the pair.
    expect(
      hasDisallowedOrigin(
        new Request(`http://${CANONICAL}/api/braindump`, {
          method: "POST",
          headers: {
            "x-forwarded-host": CANONICAL,
            "x-forwarded-proto": "https",
            origin: `https://${CANONICAL}`,
          },
        }),
      ),
    ).toBe(false);
  });
});

// Raised in review on !280: returning null on an unparseable PUBLIC_ORIGIN
// disables the canonical-origin protection entirely, which is #174's own
// failure mode moved one level up — the app says nothing and the only symptom
// is users looping at sign-in.
describe("canonicalOriginRedirect — a malformed PUBLIC_ORIGIN is not silent", () => {
  beforeEach(() => {
    _resetOriginWarningForTest();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const call = () =>
    canonicalOriginRedirect({
      host: "somewhere.example",
      pathname: "/login",
      search: "",
    });

  it("still serves the request rather than taking it down", () => {
    vi.stubEnv("PUBLIC_ORIGIN", "not a url");
    expect(call()).toBeNull();
  });

  it("says so, once", () => {
    vi.stubEnv("PUBLIC_ORIGIN", "not a url");

    call();
    call();
    call();

    const lines = vi
      .mocked(console.warn)
      .mock.calls.map((c) => JSON.parse(c[0] as string))
      .filter((l) => l.reason === "public_origin_unparseable");
    // Once per process, not once per request — this runs on every auth-flow
    // request, so an unlatched warning would bury the logs it is trying to reach.
    expect(lines).toHaveLength(1);
  });

  it("stays quiet when PUBLIC_ORIGIN parses", () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://canonical.example");

    call();

    expect(
      vi
        .mocked(console.warn)
        .mock.calls.filter((c) =>
          String(c[0]).includes("public_origin_unparseable"),
        ),
    ).toEqual([]);
  });
});
