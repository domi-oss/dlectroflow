/**
 * Route tests for GET /api/focus-catalog/audio (#61) — the media proxy.
 *
 * `src/lib/focus-catalog-source.test.ts` proves the store conversation over a
 * real socket (Range forwarded, 206 byte-for-byte, body streamed). This file
 * proves what the ROUTE adds on top: the session gate, the mapping from source
 * verdicts to HTTP, and the response headers — which is where a media proxy
 * usually goes wrong, because `<audio>` will not seek without `Accept-Ranges`
 * and will not play a track the browser is allowed to sniff into something else.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { hasSessionMock, fetchCatalogAudioMock } = vi.hoisted(() => ({
  hasSessionMock: vi.fn(),
  fetchCatalogAudioMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({ hasSession: hasSessionMock }));
vi.mock("@/lib/focus-catalog-source", () => ({
  fetchCatalogAudio: fetchCatalogAudioMock,
}));

import { GET } from "./route";

const BODY = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]);

/** An upstream response shaped like a static file server's. */
function upstream(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(BODY, {
    status,
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(BODY.byteLength),
      "Accept-Ranges": "bytes",
      ETag: '"abc"',
      "Last-Modified": "Mon, 04 Aug 2026 00:00:00 GMT",
      ...headers,
    },
  });
}

function request(
  query = "?track=paper-cranes.mp3",
  headers: Record<string, string> = {},
): Request {
  return new Request(
    `https://app.example.test/api/focus-catalog/audio${query}`,
    {
      headers,
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hasSessionMock.mockResolvedValue(true);
  fetchCatalogAudioMock.mockResolvedValue({
    status: "ok",
    upstream: upstream(200),
  });
});

describe("GET /api/focus-catalog/audio", () => {
  it("refuses a caller with no session, without touching the store", async () => {
    hasSessionMock.mockResolvedValue(false);
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(fetchCatalogAudioMock).not.toHaveBeenCalled();
  });

  it("refuses a request with no track at all", async () => {
    const res = await GET(request(""));
    expect(res.status).toBe(400);
    expect(fetchCatalogAudioMock).not.toHaveBeenCalled();
  });

  it("streams the track back", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BODY);
    expect(fetchCatalogAudioMock).toHaveBeenCalledWith(
      "paper-cranes.mp3",
      null,
      expect.anything(),
    );
  });

  it("pins the content type instead of trusting the store's", async () => {
    // Only mp3 filenames get this far, so the type is knowable; taking the
    // store's word for it would let a mislabelled object decide how the browser
    // treats the bytes. `nosniff` closes the other half of that.
    fetchCatalogAudioMock.mockResolvedValue({
      status: "ok",
      upstream: upstream(200, { "Content-Type": "text/html" }),
    });
    const res = await GET(request());
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("advertises range support so <audio> offers a scrub bar", async () => {
    const res = await GET(request());
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe(String(BODY.byteLength));
  });

  it("forwards the client's Range header to the store", async () => {
    await GET(request("?track=paper-cranes.mp3", { Range: "bytes=100-199" }));
    expect(fetchCatalogAudioMock).toHaveBeenCalledWith(
      "paper-cranes.mp3",
      "bytes=100-199",
      expect.anything(),
    );
  });

  it("passes a 206 straight through, Content-Range and all", async () => {
    // Without Content-Range surviving the hop, a seek silently restarts the
    // track from zero.
    fetchCatalogAudioMock.mockResolvedValue({
      status: "ok",
      upstream: upstream(206, { "Content-Range": "bytes 100-199/4096" }),
    });
    const res = await GET(
      request("?track=paper-cranes.mp3", { Range: "bytes=100-199" }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 100-199/4096");
  });

  it("keeps the validators a conditional request needs", async () => {
    const res = await GET(request());
    expect(res.headers.get("ETag")).toBe('"abc"');
    expect(res.headers.get("Last-Modified")).toBe(
      "Mon, 04 Aug 2026 00:00:00 GMT",
    );
  });

  it("copies no header the store sent beyond the ones it needs", async () => {
    // A relayed Set-Cookie would let the store set cookies on THIS origin.
    fetchCatalogAudioMock.mockResolvedValue({
      status: "ok",
      upstream: upstream(200, {
        "Set-Cookie": "store_session=1",
        "Access-Control-Allow-Origin": "*",
        Server: "SomeStore/1.0",
      }),
    });
    const res = await GET(request());
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Server")).toBeNull();
  });

  it("caches a track hard — the bytes behind a name never change", async () => {
    const cacheControl = await GET(request()).then((r) =>
      r.headers.get("Cache-Control"),
    );
    expect(cacheControl).toContain("private");
    expect(cacheControl).toMatch(/max-age=\d+/);
  });

  it("answers 404 for a name the proxy will not ask for", async () => {
    fetchCatalogAudioMock.mockResolvedValue({ status: "rejected" });
    const res = await GET(request("?track=..%2F..%2Fetc%2Fpasswd"));
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers 404 when no store is configured", async () => {
    // Same answer as a missing track on purpose: from the player's side "this
    // track is not available here" is the whole of the truth, and it already
    // has the bundled ten to fall back on.
    fetchCatalogAudioMock.mockResolvedValue({ status: "unconfigured" });
    expect((await GET(request())).status).toBe(404);
  });

  it("answers 404 when the store does not have it", async () => {
    fetchCatalogAudioMock.mockResolvedValue({ status: "missing" });
    expect((await GET(request())).status).toBe(404);
  });

  it("answers 502 when the store is broken, and says nothing about it", async () => {
    fetchCatalogAudioMock.mockResolvedValue({
      status: "unavailable",
      reason: "getaddrinfo ENOTFOUND internal-store.example.test",
    });
    const res = await GET(request());
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("internal-store.example.test");
  });

  it("hands the client's abort signal down to the store", async () => {
    // A listener who skips a track mid-download should not leave the pod
    // pulling the rest of it from the store.
    const controller = new AbortController();
    const req = new Request(
      "https://app.example.test/api/focus-catalog/audio?track=paper-cranes.mp3",
      { signal: controller.signal },
    );
    await GET(req);
    expect(fetchCatalogAudioMock).toHaveBeenCalledWith(
      "paper-cranes.mp3",
      null,
      expect.objectContaining({ signal: req.signal }),
    );
  });
});
