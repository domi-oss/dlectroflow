/**
 * Route tests for GET /api/focus-catalog (#61).
 *
 * The store conversation itself is covered over a real socket in
 * `src/lib/focus-catalog-source.test.ts`, so this file is about the four things
 * only the route decides: that it refuses a caller with no session, that every
 * flavour of "no catalog" still leaves the player something sane to do, that a
 * broken store is distinguishable from an unconfigured one, and that the
 * response is cacheable per-session but never shared.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { hasSessionMock, fetchCatalogTracksMock } = vi.hoisted(() => ({
  hasSessionMock: vi.fn(),
  fetchCatalogTracksMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ hasSession: hasSessionMock }));
vi.mock("@/lib/focus-catalog-source", () => ({
  fetchCatalogTracks: fetchCatalogTracksMock,
}));

import { GET } from "./route";

const TRACK = {
  id: "catalog:paper-cranes.mp3",
  title: "Paper Cranes",
  category: "chillhop",
  categoryLabel: "Chillhop",
  src: "/api/focus-catalog/audio?track=paper-cranes.mp3",
};

beforeEach(() => {
  vi.clearAllMocks();
  hasSessionMock.mockResolvedValue(true);
  fetchCatalogTracksMock.mockResolvedValue({ status: "ok", tracks: [TRACK] });
});

describe("GET /api/focus-catalog", () => {
  it("refuses a caller with no session, without asking the store", async () => {
    // Not about confidentiality — the tracks are public domain — but about not
    // leaving the instance as an open relay to the operator's store.
    hasSessionMock.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(fetchCatalogTracksMock).not.toHaveBeenCalled();
  });

  it("serves the catalog as JSON", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ source: "catalog", tracks: [TRACK] });
  });

  it("hands back nothing, successfully, when no store is configured", async () => {
    // The overwhelmingly common case on a fresh install. It is not an error:
    // the player has ten bundled tracks and needs no help from this route.
    fetchCatalogTracksMock.mockResolvedValue({ status: "unconfigured" });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ source: "unconfigured", tracks: [] });
  });

  it("reports a broken store as 502, distinctly from an unconfigured one", async () => {
    // Same body shape, so the client's handling is identical, but the status
    // makes a misconfigured store visible to whoever is watching the logs.
    fetchCatalogTracksMock.mockResolvedValue({
      status: "unavailable",
      reason: "the store answered 503",
    });
    const res = await GET();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ source: "unavailable", tracks: [] });
  });

  it("never leaks the store's address or the failure detail to the client", async () => {
    fetchCatalogTracksMock.mockResolvedValue({
      status: "unavailable",
      reason: "getaddrinfo ENOTFOUND internal-store.example.test",
    });
    const res = await GET();
    expect(await res.text()).not.toContain("internal-store.example.test");
  });

  it("is cacheable by the browser but never by a shared cache", async () => {
    const cacheControl = await GET().then((r) =>
      r.headers.get("Cache-Control"),
    );
    expect(cacheControl).toContain("private");
    expect(cacheControl).toMatch(/max-age=\d+/);
  });

  it("does not cache a failure", async () => {
    fetchCatalogTracksMock.mockResolvedValue({
      status: "unavailable",
      reason: "boom",
    });
    const res = await GET();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
