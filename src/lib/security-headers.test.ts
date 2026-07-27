import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";

/**
 * #69 — guard the deliberately self-hosted-only media posture.
 *
 * WHY THIS FILE EXISTS (policy, not a snapshot):
 *
 * Every sound this app plays during a focus session is a CC0 file we ship
 * ourselves (`public/audio/`, provenance in `public/audio/LICENSE.md`). That is
 * a privacy decision, not an accident of what we happened to build: a focus
 * session is a long, personal, unattended page view, and we do not want a
 * third-party media host — cookies, fingerprinting, request logs — sitting
 * inside it. The CSP in `next.config.ts` is what makes that a *fact* rather
 * than an intention, because `default-src 'self'` with no `media-src`,
 * `frame-src` or `child-src` means the browser will refuse third-party audio
 * and frames even if some future component asks for them.
 *
 * #69 evaluated embedding a forked lo-fi player whose audio is entirely
 * YouTube (`react-player/youtube` + the YouTube iframe API). Adopting it would
 * have required opening `script-src` and `frame-src` to Google. It was closed
 * as won't-do for exactly that reason; #61 (a self-hosted catalog, served
 * same-origin) is the sanctioned route to more track variety instead.
 *
 * So these tests are not asserting "the config currently says X". They assert
 * the properties the decision rests on, and each is written to fail on any
 * relaxation rather than only on the one we happened to foresee:
 *
 *   1. `default-src 'self'` still backstops every unset directive, and
 *      `media-src`/`frame-src`/`child-src` stay unset so they inherit it.
 *   2. `connect-src` only ever contains origins from the reviewed allowlist.
 *   3. No directive names a third-party media/embed host, and none opens a
 *      wildcard (`*`, `https://*.example.com`, bare `https:`) that would let
 *      one in without naming it.
 *   4. The policy applies to *every* route — a relaxed CSP scoped to just
 *      `/focus` would defeat the whole thing, so per-route overrides are
 *      checked too, not only the first header group.
 *
 * If you are here because this test went red: that is the point. Relaxing the
 * posture is allowed, but it is a product decision — make it on purpose, record
 * it on #69, and edit this file in the same MR.
 */

type CspDirectives = Record<string, string[]>;

/** Parse a CSP header value into `{ directive: sources[] }`. */
function parseCsp(value: string): CspDirectives {
  const directives: CspDirectives = {};
  for (const part of value.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives[name.toLowerCase()] = sources;
  }
  return directives;
}

type HeaderGroup = {
  source: string;
  headers: { key: string; value: string }[];
};

async function getHeaderGroups(): Promise<HeaderGroup[]> {
  expect(
    nextConfig.headers,
    "next.config.ts must still declare a headers() function",
  ).toBeTypeOf("function");
  return (await nextConfig.headers!()) as HeaderGroup[];
}

function findHeader(group: HeaderGroup, key: string): string | undefined {
  return group.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())
    ?.value;
}

/**
 * Every CSP in the config, keyed by the route pattern it applies to.
 *
 * Deliberately returns *all* of them: a second header group that relaxed the
 * policy for one route is a realistic way the posture would erode, and a test
 * that only looked at the first group would sail straight past it.
 */
async function getAllCsps(): Promise<{ source: string; csp: CspDirectives }[]> {
  const groups = await getHeaderGroups();
  const found = groups
    .map((group) => ({
      source: group.source,
      value: findHeader(group, "Content-Security-Policy"),
    }))
    .filter((entry): entry is { source: string; value: string } =>
      Boolean(entry.value),
    );

  expect(
    found.length,
    "at least one Content-Security-Policy header must be configured",
  ).toBeGreaterThan(0);

  return found.map(({ source, value }) => ({ source, csp: parseCsp(value) }));
}

/**
 * Origins a third-party audio/video embed would need. None may appear anywhere.
 *
 * Matched on **host boundaries**, never as substrings: `hostOf()` reduces a CSP
 * source to its host and `isForbiddenHost()` accepts only an exact match or a
 * subdomain. A substring test would flag `https://demux.com` for `mux.com`
 * (raised in review on !163) — and a policy test that cries wolf is a policy
 * test somebody eventually deletes, so the matcher is unit-tested below.
 */
const FORBIDDEN_MEDIA_HOSTS = [
  "youtube.com",
  "youtube-nocookie.com",
  "ytimg.com",
  "googlevideo.com",
  "spotify.com",
  "scdn.co",
  "soundcloud.com",
  "sndcdn.com",
  "vimeo.com",
  "mux.com",
  "mixcloud.com",
  "bandcamp.com",
];

/**
 * Sources that allow arbitrary hosts. Naming a CDN is the obvious way to relax
 * the posture; a wildcard is the quiet way, so it is blocked by shape rather
 * than by hostname. `data:` and `blob:` are excluded — they are same-document,
 * carry no third party, and are used on purpose by `img-src`/`font-src`.
 */
const WILDCARD_SOURCES = ["*", "http:", "https:", "ws:", "wss:"];

function isWildcardSource(source: string): boolean {
  const token = source.toLowerCase();
  return WILDCARD_SOURCES.includes(token) || token.includes("*");
}

/**
 * Reduce a CSP source expression to the host it names, or `null` if it names no
 * host — keywords (`'self'`, `'none'`, `'unsafe-inline'`) and scheme-only
 * sources (`data:`, `blob:`, `https:`) have no host to check.
 *
 * Handles the forms a CSP source can actually take: `https://host`, `//host`,
 * `host:443`, `https://host/path`, and `*.host`.
 */
function hostOf(source: string): string | null {
  let token = source.trim().toLowerCase();
  if (!token) return null;
  if (token.startsWith("'")) return null; // 'self', 'none', 'unsafe-inline'…
  if (/^[a-z][a-z0-9+.-]*:$/.test(token)) return null; // data:, blob:, https:
  token = token.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme://
  token = token.replace(/^\/\//, ""); // protocol-relative
  token = token.split("/")[0]; // drop any path
  token = token.replace(/:\d+$/, ""); // drop any port
  token = token.replace(/^\*\./, ""); // *.host → host
  return token || null;
}

/**
 * True when `host` IS `forbidden` or a subdomain of it — never when it merely
 * contains it. `demux.com` is not `mux.com`; `cdn.mux.com` is.
 */
function isForbiddenHost(host: string, forbidden: string): boolean {
  return host === forbidden || host.endsWith(`.${forbidden}`);
}

describe("CSP — self-hosted-only media posture (#69)", () => {
  it("keeps default-src locked to 'self' on every route", async () => {
    for (const { source, csp } of await getAllCsps()) {
      expect(csp["default-src"], `default-src for route ${source}`).toEqual([
        "'self'",
      ]);
    }
  });

  it("leaves media-src, frame-src and child-src unset so they inherit default-src 'self'", async () => {
    for (const { source, csp } of await getAllCsps()) {
      // Absent on purpose: setting any of these is how a third-party player
      // would get its audio or its iframe in. See #69.
      for (const directive of ["media-src", "frame-src", "child-src"]) {
        expect(
          csp[directive],
          `${directive} must stay unset (route ${source}) so it inherits default-src 'self' — see #69`,
        ).toBeUndefined();
      }
    }
  });

  it("allows only reviewed external origins in connect-src", async () => {
    // Server-to-server calls do not need connect-src; this list is only the
    // origins the *browser* is permitted to reach. Adding one is a review
    // decision, so an unlisted origin fails here.
    const reviewedOrigins = [
      "'self'",
      "https://api.anthropic.com",
      "https://tasks.googleapis.com",
      "https://accounts.google.com",
      "https://oauth2.googleapis.com",
    ];

    for (const { source, csp } of await getAllCsps()) {
      const connectSrc = csp["connect-src"] ?? [];
      expect(connectSrc, `connect-src for route ${source}`).toContain("'self'");
      for (const origin of connectSrc) {
        expect(
          reviewedOrigins,
          `connect-src on route ${source} allows unreviewed origin ${origin} — add it here deliberately if it is intended`,
        ).toContain(origin);
      }
    }
  });

  it("names no third-party media or embed host in any directive", async () => {
    for (const { source, csp } of await getAllCsps()) {
      for (const [directive, sources] of Object.entries(csp)) {
        for (const candidate of sources) {
          const host = hostOf(candidate);
          if (!host) continue;
          const match = FORBIDDEN_MEDIA_HOSTS.find((forbidden) =>
            isForbiddenHost(host, forbidden),
          );
          expect(
            match,
            `${directive} on route ${source} allows ${candidate} (${match}) — audio is self-hosted (#69); more variety goes through #61, served same-origin`,
          ).toBeUndefined();
        }
      }
    }
  });

  it("opens no wildcard source that would admit a third-party host unnamed", async () => {
    for (const { source, csp } of await getAllCsps()) {
      for (const [directive, sources] of Object.entries(csp)) {
        for (const candidate of sources) {
          expect(
            isWildcardSource(candidate),
            `${directive} on route ${source} allows wildcard source ${candidate} — name the origin instead`,
          ).toBe(false);
        }
      }
    }
  });

  it("still denies framing of the app itself", async () => {
    for (const { source, csp } of await getAllCsps()) {
      expect(csp["frame-ancestors"], `frame-ancestors for ${source}`).toEqual([
        "'none'",
      ]);
      expect(csp["object-src"], `object-src for ${source}`).toEqual(["'none'"]);
    }
  });

  it("keeps X-Frame-Options consistent with frame-ancestors 'none'", async () => {
    // next.config.ts documents these two as intentionally matching; a change to
    // one and not the other is a mistake, not a policy change.
    for (const group of await getHeaderGroups()) {
      if (!findHeader(group, "Content-Security-Policy")) continue;
      expect(
        findHeader(group, "X-Frame-Options"),
        `X-Frame-Options for route ${group.source}`,
      ).toBe("DENY");
    }
  });
});

/**
 * The host matcher is the one piece of real logic in this file, and a policy
 * test that raises false alarms is a policy test somebody deletes under
 * deadline pressure. So it is tested itself — in particular against the
 * substring bug this originally shipped with (review on !163): `mux.com` is the
 * shortest entry in the blocklist and matched inside `demux.com`.
 */
describe("host matching (the matcher the media policy relies on)", () => {
  it("returns no host for CSP keywords and scheme-only sources", () => {
    for (const keyword of [
      "'self'",
      "'none'",
      "'unsafe-inline'",
      "'strict-dynamic'",
    ]) {
      expect(hostOf(keyword), keyword).toBeNull();
    }
    for (const scheme of ["data:", "blob:", "https:", "ws:"]) {
      expect(hostOf(scheme), scheme).toBeNull();
    }
  });

  it("extracts the host from the source forms a CSP can use", () => {
    expect(hostOf("https://www.youtube.com")).toBe("www.youtube.com");
    expect(hostOf("http://example.com")).toBe("example.com");
    expect(hostOf("//example.com")).toBe("example.com");
    expect(hostOf("example.com:8443")).toBe("example.com");
    expect(hostOf("https://example.com/embed/path")).toBe("example.com");
    expect(hostOf("https://*.googlevideo.com")).toBe("googlevideo.com");
    expect(hostOf("HTTPS://WWW.YouTube.COM")).toBe("www.youtube.com");
  });

  it("flags a forbidden host and its subdomains", () => {
    expect(isForbiddenHost("mux.com", "mux.com")).toBe(true);
    expect(isForbiddenHost("cdn.mux.com", "mux.com")).toBe(true);
    expect(isForbiddenHost("www.youtube.com", "youtube.com")).toBe(true);
    expect(
      isForbiddenHost("rr1---sn-x.googlevideo.com", "googlevideo.com"),
    ).toBe(true);
  });

  it("does not flag unrelated hosts that merely contain a forbidden name", () => {
    // Regression: the substring matcher flagged every one of these. (!163)
    const legitimate: [string, string][] = [
      ["demux.com", "mux.com"],
      ["demuxer.mux.example", "mux.com"],
      ["notspotify.com", "spotify.com"],
      ["myvimeo.com.au", "vimeo.com"],
      ["bandcamp.com.example.net", "bandcamp.com"],
      ["fake-youtube.com", "youtube.com"],
    ];
    for (const [host, forbidden] of legitimate) {
      expect(isForbiddenHost(host, forbidden), `${host} vs ${forbidden}`).toBe(
        false,
      );
    }
  });

  it("still catches a real embed origin end to end", () => {
    const host = hostOf("https://www.youtube-nocookie.com")!;
    expect(FORBIDDEN_MEDIA_HOSTS.some((f) => isForbiddenHost(host, f))).toBe(
      true,
    );

    // …and leaves a legitimate lookalike alone.
    const benign = hostOf("https://demux.com")!;
    expect(FORBIDDEN_MEDIA_HOSTS.some((f) => isForbiddenHost(benign, f))).toBe(
      false,
    );
  });
});
