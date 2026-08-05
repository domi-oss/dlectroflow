/**
 * Route tests for GET /api/ics/feed/[token] (#154).
 *
 * The feed's CONTENTS are covered by `scheduledStepEvents` in `ics.test.ts`, and
 * the cross-account guarantee by `calendar-feed.integration.test.ts` against real
 * Postgres. This file is about the four things only the route decides:
 *
 *  1. It authorises from the PATH TOKEN and nothing else — no cookie, no header,
 *     because a subscribing calendar client has none to send.
 *  2. An unknown, malformed or revoked token is a 404 that says nothing.
 *  3. The response is not cacheable by a shared cache, and the token cannot be
 *     read back out of it.
 *  4. It reaches the database only through the pinned module.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { resolveFeedMock, buildFeedIcsMock } = vi.hoisted(() => ({
  resolveFeedMock: vi.fn(),
  buildFeedIcsMock: vi.fn(),
}));

// `isFeedTokenShape` is the REAL function, not a stub: the route's cheap
// pre-database rejection is one of the things being tested, and a fake would
// make it pass for the wrong reason.
vi.mock("@/lib/calendar-feed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar-feed")>();
  return {
    isFeedTokenShape: actual.isFeedTokenShape,
    resolveFeed: resolveFeedMock,
    buildFeedIcs: buildFeedIcsMock,
  };
});

import { GET } from "./route";

const TOKEN = "T".repeat(43);
const ICS = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";

const call = (token: string) =>
  GET(new Request(`https://dlectroflow.dev/api/ics/feed/${token}`), {
    params: Promise.resolve({ token }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  resolveFeedMock.mockResolvedValue({ userId: "user-1", workspaceId: "ws-1" });
  buildFeedIcsMock.mockResolvedValue(ICS);
});

describe("GET /api/ics/feed/[token]", () => {
  it("serves the calendar for the workspace the token resolves to", async () => {
    const res = await call(TOKEN);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ICS);
    expect(resolveFeedMock).toHaveBeenCalledWith(TOKEN);
    expect(buildFeedIcsMock).toHaveBeenCalledWith({ workspaceId: "ws-1" });
  });

  it("declares itself a calendar, so a client subscribes instead of downloading", async () => {
    const res = await call(TOKEN);
    expect(res.headers.get("Content-Type")).toBe(
      "text/calendar; charset=utf-8",
    );
    // `inline`, not `attachment`: a subscription is fetched by a background
    // agent, and an attachment disposition makes some clients save a file.
    expect(res.headers.get("Content-Disposition")).toContain("inline");
  });

  it("is not cacheable by a shared cache", async () => {
    // The response is one person's schedule served without a cookie, so it is
    // exactly the shape a proxy would happily hand to the next caller of the
    // same URL. `no-store` also means a regenerate takes effect on the next
    // request rather than whenever something expires.
    const cacheControl = await call(TOKEN).then((r) =>
      r.headers.get("Cache-Control"),
    );
    expect(cacheControl).toContain("no-store");
    expect(cacheControl).toContain("private");
  });

  it("asks not to be indexed, in case the URL ever escapes", async () => {
    const res = await call(TOKEN);
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("never echoes the token back in the response", async () => {
    // A capability URL that appears in a body or a header is one more surface it
    // can be copied off — an error page, a log line, a screenshot.
    const res = await call(TOKEN);
    expect(await res.text()).not.toContain(TOKEN);
    for (const [, value] of res.headers) {
      expect(value).not.toContain(TOKEN);
    }
  });

  it("answers 404 for a token that resolves to nobody", async () => {
    resolveFeedMock.mockResolvedValue(null);
    const res = await call(TOKEN);

    expect(res.status).toBe(404);
    expect(buildFeedIcsMock).not.toHaveBeenCalled();
  });

  it("says nothing about WHY an unknown token failed", async () => {
    // Revoked, regenerated, never existed and never token-shaped are all the
    // same answer. Distinguishing them would turn the endpoint into an oracle.
    resolveFeedMock.mockResolvedValue(null);
    const unknown = await call(TOKEN);
    const malformed = await call("nope");

    expect(unknown.status).toBe(malformed.status);
    expect(await unknown.text()).toBe(await malformed.text());
  });

  it("rejects a malformed token without touching the database", async () => {
    for (const bad of ["nope", "../../etc/passwd", "%2e%2e", "a".repeat(200)]) {
      const res = await call(bad);
      expect(res.status).toBe(404);
    }
    expect(resolveFeedMock).not.toHaveBeenCalled();
  });

  it("does not cache the 404 either", async () => {
    resolveFeedMock.mockResolvedValue(null);
    const res = await call(TOKEN);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });
});
