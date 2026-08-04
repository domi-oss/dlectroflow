/**
 * #61 — the catalog's I/O half, exercised against a REAL HTTP origin.
 *
 * A `node:http` server on 127.0.0.1 stands in for the object store. That is the
 * point of this file rather than a mocked `fetch`: the open question on #61 was
 * whether a Next route handler can proxy audio *properly* — range requests,
 * seeking, byte fidelity — and a stubbed fetch would answer that question by
 * assumption. Everything here goes over a socket.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  CATALOG_ORIGIN_ENV,
  NotUnderCatalogBaseError,
  catalogBase,
  fetchCatalogAudio,
  fetchCatalogTracks,
  fetchFromStore,
  sanitiseRange,
} from "./focus-catalog-source";

/** 64 KiB of deterministic bytes — big enough that a range is a real slice. */
const TRACK_BYTES = Buffer.from(
  Array.from({ length: 64 * 1024 }, (_, i) => i % 251),
);

const MANIFEST = {
  name: "OpenLo-Fi",
  license: "CC0-1.0",
  categories: [
    { slug: "activities", label: "Focus, Rituals & Daily Routines" },
  ],
  tracks: [
    {
      title: "2 AM Debug Loop",
      filename: "2-am-debug-loop.mp3",
      category: "activities",
    },
    {
      title: "Paper Cranes",
      filename: "paper-cranes.mp3",
      category: "chillhop",
    },
  ],
};

/** Every path the fake store was asked for, so a test can prove what it was NOT
 *  asked for — the SSRF assertion needs the negative. */
let requestedPaths: string[] = [];
/** Set by a test to make the store misbehave for the next request. */
let behaviour: "ok" | "500" | "404" | "not-json" | "hang" | "huge" | "trickle" =
  "ok";

let server: Server;
let origin = "";

/**
 * The fake store's Range handling, written without a regex.
 *
 * A `/^bytes=(\d*)-(\d*)$/` here was flagged MEDIUM by the SAST ReDoS rule
 * (`nodejs_scan.javascript-dos-rule-regex_dos`) on !256, because the input is a
 * request header. It was linear and could not actually backtrack — but this
 * parses a header, which is a split, and a fixture is not the place to argue
 * with a scanner over a rule the repo elsewhere chose to fix rather than dismiss.
 */
function serveRange(req: IncomingMessage, body: Buffer) {
  const whole = { status: 200, start: 0, end: body.length - 1 };
  const range = req.headers.range;
  if (typeof range !== "string" || !range.startsWith("bytes=")) return whole;

  const parts = range.slice("bytes=".length).split("-");
  if (parts.length !== 2) return whole;
  const start = parts[0] === "" ? 0 : Number(parts[0]);
  const end = parts[1] === "" ? body.length - 1 : Number(parts[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return whole;
  return { status: 206, start, end };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    requestedPaths.push(req.url ?? "");
    if (behaviour === "hang") return; // never answers; the timeout must fire

    if (req.url?.endsWith("/catalog.json")) {
      if (behaviour === "500") {
        res.writeHead(500).end("nope");
        return;
      }
      if (behaviour === "not-json") {
        res.writeHead(200, { "Content-Type": "application/json" }).end("{[");
        return;
      }
      if (behaviour === "trickle") {
        // Headers promptly, then a body that never finishes. The header-only
        // deadline has already been cleared by the time this matters.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"tracks":[');
        return;
      }
      if (behaviour === "huge") {
        res
          .writeHead(200, {
            "Content-Type": "application/json",
            "Content-Length": String(50 * 1024 * 1024),
          })
          .end("{}");
        return;
      }
      const payload = JSON.stringify(MANIFEST);
      res
        .writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(payload)),
        })
        .end(payload);
      return;
    }

    if (req.url?.endsWith(".mp3")) {
      if (behaviour === "404") {
        res.writeHead(404).end("gone");
        return;
      }
      if (behaviour === "500") {
        res.writeHead(503).end("busy");
        return;
      }
      const { status, start, end } = serveRange(req, TRACK_BYTES);
      const slice = TRACK_BYTES.subarray(start, end + 1);
      res.writeHead(status, {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(slice.length),
        "Accept-Ranges": "bytes",
        ETag: '"track-etag"',
        ...(status === 206
          ? { "Content-Range": `bytes ${start}-${end}/${TRACK_BYTES.length}` }
          : {}),
      });
      res.end(slice);
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}/lofi`;
});

afterAll(async () => {
  // The "hang" and "trickle" cases leave a socket open on purpose, and
  // `server.close()` waits for every connection to end — so without this the
  // teardown hook is what times out, not the test.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.unstubAllEnvs();
  requestedPaths = [];
  behaviour = "ok";
});

describe("catalogBase", () => {
  it("is null until an operator configures a store", () => {
    vi.stubEnv(CATALOG_ORIGIN_ENV, "");
    expect(catalogBase()).toBeNull();
  });

  it("normalises whatever the operator configured", () => {
    vi.stubEnv(CATALOG_ORIGIN_ENV, "https://cdn.example.test/lofi");
    expect(catalogBase()).toBe("https://cdn.example.test/lofi/");
  });

  it("is null for a value that cannot be a store URL", () => {
    vi.stubEnv(CATALOG_ORIGIN_ENV, "javascript:alert(1)");
    expect(catalogBase()).toBeNull();
  });
});

describe("sanitiseRange", () => {
  it("keeps the single-range forms a media element actually sends", () => {
    for (const range of ["bytes=0-", "bytes=100-199", "bytes=-500"]) {
      expect(sanitiseRange(range), range).toBe(range);
    }
    expect(sanitiseRange("  bytes=0-  ")).toBe("bytes=0-");
  });

  it("drops anything else rather than relaying it upstream", () => {
    for (const range of [
      null,
      undefined,
      "",
      "rows=1-2",
      "bytes=0-10, 20-30",
      "bytes=abc-def",
      "bytes=-",
      "bytes=0-10\r\nX-Injected: 1",
    ]) {
      expect(sanitiseRange(range), String(range)).toBeNull();
    }
  });
});

describe("fetchFromStore", () => {
  it("refuses a URL that is not under the configured base", async () => {
    // The runtime half of the REVIEWED_DYNAMIC_HOSTS entry: this module's only
    // outbound call cannot reach a host the operator did not configure, however
    // it is called. Nothing hits the socket.
    vi.stubEnv(CATALOG_ORIGIN_ENV, origin);
    await expect(
      fetchFromStore(`${origin}/`, "http://169.254.169.254/latest/meta-data", {
        timeoutMs: 500,
      }),
    ).rejects.toBeInstanceOf(NotUnderCatalogBaseError);
    expect(requestedPaths).toEqual([]);
  });

  it("refuses a host that merely starts with the base's text", async () => {
    await expect(
      fetchFromStore(
        "https://cdn.example.test/lofi/",
        "https://cdn.example.test.evil/lofi/x.mp3",
        {
          timeoutMs: 500,
        },
      ),
    ).rejects.toBeInstanceOf(NotUnderCatalogBaseError);
  });
});

describe("fetchCatalogTracks", () => {
  it("reports unconfigured rather than erroring when no store is set", async () => {
    vi.stubEnv(CATALOG_ORIGIN_ENV, "");
    const result = await fetchCatalogTracks();
    expect(result.status).toBe("unconfigured");
    expect(requestedPaths).toEqual([]);
  });

  it("reads catalog.json from the configured base and returns playable tracks", async () => {
    vi.stubEnv(CATALOG_ORIGIN_ENV, origin);
    const result = await fetchCatalogTracks();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.tracks.map((t) => t.title)).toEqual([
      "2 AM Debug Loop",
      "Paper Cranes",
    ]);
    // Same-origin: the player is never handed the store's URL.
    for (const track of result.tracks) {
      expect(track.src.startsWith("/api/focus-catalog/audio?")).toBe(true);
    }
    expect(requestedPaths).toEqual(["/lofi/catalog.json"]);
  });

  it("degrades to unavailable on an upstream error", async () => {
    vi.stubEnv(CATALOG_ORIGIN_ENV, origin);
    behaviour = "500";
    const result = await fetchCatalogTracks();
    expect(result.status).toBe("unavailable");
  });

  it("degrades to unavailable on a manifest that is not JSON", async () => {
    vi.stubEnv(CATALOG_ORIGIN_ENV, origin);
    behaviour = "not-json";
    const result = await fetchCatalogTracks();
    expect(result.status).toBe("unavailable");
  });

  it("refuses a manifest that declares an implausible size", async () => {
    // A manifest is JSON.parse'd into memory, so its size is a liability the
    // app cannot stream around. 166 tracks is ~20 KB.
    vi.stubEnv(CATALOG_ORIGIN_ENV, origin);
    behaviour = "huge";
    const result = await fetchCatalogTracks();
    expect(result.status).toBe("unavailable");
  });

  it("gives up on a store that answers and then trickles the body forever", async () => {
    // Duo review (!256). The header deadline is cleared the moment `fetch`
    // resolves — deliberately, so a long audio stream is not truncated — which
    // left the manifest READ itself bounded only by a byte cap. A store that
    // sends headers and then stalls would hold the request open indefinitely.
    vi.stubEnv(CATALOG_ORIGIN_ENV, origin);
    behaviour = "trickle";
    const result = await fetchCatalogTracks({ timeoutMs: 200 });
    expect(result.status).toBe("unavailable");
  });

  it("gives up on a store that never answers", async () => {
    vi.stubEnv(CATALOG_ORIGIN_ENV, origin);
    behaviour = "hang";
    const result = await fetchCatalogTracks({ timeoutMs: 150 });
    expect(result.status).toBe("unavailable");
  });

  it("degrades to unavailable when the host does not resolve", async () => {
    vi.stubEnv(CATALOG_ORIGIN_ENV, "http://127.0.0.1:1/lofi");
    const result = await fetchCatalogTracks({ timeoutMs: 500 });
    expect(result.status).toBe("unavailable");
  });
});

describe("fetchCatalogAudio", () => {
  it("streams a whole track back byte for byte", async () => {
    vi.stubEnv(CATALOG_ORIGIN_ENV, origin);
    const result = await fetchCatalogAudio("2-am-debug-loop.mp3", null);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.upstream.status).toBe(200);
    const body = Buffer.from(await result.upstream.arrayBuffer());
    expect(body.length).toBe(TRACK_BYTES.length);
    expect(body.equals(TRACK_BYTES)).toBe(true);
  });

  it("forwards a Range header and returns the exact slice as 206", async () => {
    // The seeking question, answered over a socket: the store does the range
    // arithmetic and the proxy passes it through, so <audio> can seek.
    vi.stubEnv(CATALOG_ORIGIN_ENV, origin);
    const result = await fetchCatalogAudio(
      "2-am-debug-loop.mp3",
      "bytes=100-199",
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.upstream.status).toBe(206);
    expect(result.upstream.headers.get("content-range")).toBe(
      `bytes 100-199/${TRACK_BYTES.length}`,
    );
    const body = Buffer.from(await result.upstream.arrayBuffer());
    expect(body.length).toBe(100);
    expect(body.equals(TRACK_BYTES.subarray(100, 200))).toBe(true);
  });

  it("forwards an open-ended range, which is what a player opens with", async () => {
    vi.stubEnv(CATALOG_ORIGIN_ENV, origin);
    const result = await fetchCatalogAudio("2-am-debug-loop.mp3", "bytes=0-");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.upstream.status).toBe(206);
    expect(result.upstream.headers.get("content-range")).toBe(
      `bytes 0-${TRACK_BYTES.length - 1}/${TRACK_BYTES.length}`,
    );
  });

  it("gives the body back as a stream rather than a buffer", async () => {
    // A 3 MB track must not be read into the pod's memory before the first byte
    // reaches the browser.
    vi.stubEnv(CATALOG_ORIGIN_ENV, origin);
    const result = await fetchCatalogAudio("2-am-debug-loop.mp3", null);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.upstream.body).toBeInstanceOf(ReadableStream);
    await result.upstream.body?.cancel();
  });

  it("rejects a filename that could leave the configured prefix, without a request", async () => {
    vi.stubEnv(CATALOG_ORIGIN_ENV, origin);
    for (const hostile of [
      "../../etc/passwd",
      "/etc/passwd",
      "//evil.test/x.mp3",
      "http://169.254.169.254/latest/meta-data",
      "track.wav",
      "",
    ]) {
      const result = await fetchCatalogAudio(hostile, null);
      expect(result.status, hostile).toBe("rejected");
    }
    // The negative half: nothing above reached the store at all.
    expect(requestedPaths).toEqual([]);
  });

  it("reports a missing track distinctly from a broken store", async () => {
    vi.stubEnv(CATALOG_ORIGIN_ENV, origin);
    behaviour = "404";
    expect((await fetchCatalogAudio("nope.mp3", null)).status).toBe("missing");
    behaviour = "500";
    expect((await fetchCatalogAudio("nope.mp3", null)).status).toBe(
      "unavailable",
    );
  });

  it("reports unconfigured when no store is set", async () => {
    vi.stubEnv(CATALOG_ORIGIN_ENV, "");
    expect((await fetchCatalogAudio("a.mp3", null)).status).toBe(
      "unconfigured",
    );
    expect(requestedPaths).toEqual([]);
  });

  it("ignores a malformed Range rather than passing it upstream", async () => {
    // A header the store may answer with 416 turns a playable track into a
    // failure; dropping it just serves the whole file.
    vi.stubEnv(CATALOG_ORIGIN_ENV, origin);
    const result = await fetchCatalogAudio("2-am-debug-loop.mp3", "rows=1-2");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.upstream.status).toBe(200);
  });

  it("gives up waiting for a store that never answers", async () => {
    vi.stubEnv(CATALOG_ORIGIN_ENV, origin);
    behaviour = "hang";
    const result = await fetchCatalogAudio("a.mp3", null, { timeoutMs: 150 });
    expect(result.status).toBe("unavailable");
  });
});
