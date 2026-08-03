import { describe, it, expect } from "vitest";
import {
  CATALOG_AUDIO_PATH,
  CATALOG_INDEX_PATH,
  CATALOG_TRACK_ID_PREFIX,
  CATALOG_TRACK_PARAM,
  MAX_CATALOG_TRACKS,
  catalogAudioSrc,
  catalogFileUrl,
  catalogIndexUrl,
  categoryLabel,
  isSafeCatalogFilename,
  mergeFocusTracks,
  parseCatalog,
  resolveCatalogBase,
} from "./focus-catalog";
import { FOCUS_SOUND_TRACKS } from "./focus-sounds";

/** A minimal stand-in for open-lofi's real catalog.json (see LICENSE.md). */
const CATALOG_FIXTURE = {
  name: "OpenLo-Fi",
  version: "1.0.0",
  license: "CC0-1.0",
  trackCount: 3,
  categories: [
    { slug: "chillhop", label: "Chillhop & Cozy Beats", trackCount: 1 },
    { slug: "wind-chimes", label: "Wind Chimes", trackCount: 1 },
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
    {
      title: "Bell Field",
      filename: "bell-field.mp3",
      category: "wind-chimes",
    },
  ],
};

describe("resolveCatalogBase", () => {
  it("treats an unset, empty or blank origin as no catalog", () => {
    for (const raw of [undefined, null, "", "   ", "\n"]) {
      expect(resolveCatalogBase(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("normalises a configured origin to a base that always ends in /", () => {
    // Both spellings an operator will actually write must reduce to the same
    // base — otherwise `${base}${filename}` silently loses the last segment.
    expect(resolveCatalogBase("https://cdn.example.test/lofi")).toBe(
      "https://cdn.example.test/lofi/",
    );
    expect(resolveCatalogBase("https://cdn.example.test/lofi/")).toBe(
      "https://cdn.example.test/lofi/",
    );
    expect(resolveCatalogBase("  https://cdn.example.test  ")).toBe(
      "https://cdn.example.test/",
    );
  });

  it("accepts plain http, which is how a same-network object store is reached", () => {
    // The browser never sees this URL — the proxy fetches it server-side — so a
    // self-hoster pointing at MinIO on the Compose network is not a downgrade.
    expect(resolveCatalogBase("http://minio:9000/lofi")).toBe(
      "http://minio:9000/lofi/",
    );
  });

  it("rejects a scheme that is not http(s)", () => {
    for (const raw of [
      "ftp://example.test/lofi",
      "file:///etc/passwd",
      "data:text/plain,x",
      "//cdn.example.test/lofi",
      "cdn.example.test/lofi",
    ]) {
      expect(resolveCatalogBase(raw), raw).toBeNull();
    }
  });

  it("rejects embedded credentials, a query and a fragment", () => {
    // Credentials in the base would be sent on every proxied request and would
    // also make `${base}${name}` ambiguous about which host it names.
    expect(
      resolveCatalogBase("https://user:pass@cdn.example.test/"),
    ).toBeNull();
    expect(resolveCatalogBase("https://user@cdn.example.test/")).toBeNull();
    expect(resolveCatalogBase("https://cdn.example.test/?sig=abc")).toBeNull();
    expect(resolveCatalogBase("https://cdn.example.test/#frag")).toBeNull();
  });

  it("rejects a value that is not a URL at all", () => {
    expect(resolveCatalogBase("not a url")).toBeNull();
    expect(resolveCatalogBase("https://")).toBeNull();
  });
});

describe("isSafeCatalogFilename", () => {
  it("accepts the filenames the real catalog actually carries", () => {
    for (const name of [
      "2-am-debug-loop.mp3",
      "aurora-on-mute.mp3",
      "cafe_da_tarde.mp3",
      "Bell.Field.mp3",
    ]) {
      expect(isSafeCatalogFilename(name), name).toBe(true);
    }
  });

  it("rejects anything that could leave the catalog prefix", () => {
    for (const name of [
      "../../etc/passwd",
      "../secret.mp3",
      "a/b.mp3",
      "a\\b.mp3",
      "..%2fb.mp3",
      "%2e%2e/b.mp3",
      "track.mp3?x=1",
      "track.mp3#f",
      "http://evil.test/x.mp3",
      "//evil.test/x.mp3",
      "track.mp3 ",
      " track.mp3",
      "trac k.mp3",
      "trac\nk.mp3",
    ]) {
      expect(isSafeCatalogFilename(name), name).toBe(false);
    }
  });

  it("rejects a non-mp3, an empty name and an over-long one", () => {
    expect(isSafeCatalogFilename("track.wav")).toBe(false);
    expect(isSafeCatalogFilename("track")).toBe(false);
    expect(isSafeCatalogFilename(".mp3")).toBe(false);
    expect(isSafeCatalogFilename("")).toBe(false);
    expect(isSafeCatalogFilename("a".repeat(200) + ".mp3")).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(isSafeCatalogFilename(undefined as unknown as string)).toBe(false);
    expect(isSafeCatalogFilename(42 as unknown as string)).toBe(false);
  });
});

describe("catalogAudioSrc / catalogFileUrl / catalogIndexUrl", () => {
  it("points the player at this app's own origin, never at the store", () => {
    // The hard requirement of #61: the browser only ever talks to us, so
    // `default-src 'self'` covers the audio and no CSP directive changes.
    const src = catalogAudioSrc("2-am-debug-loop.mp3");
    expect(src.startsWith("/")).toBe(true);
    expect(src.startsWith("//")).toBe(false);
    expect(src).toBe(
      `${CATALOG_AUDIO_PATH}?${CATALOG_TRACK_PARAM}=2-am-debug-loop.mp3`,
    );
    expect(CATALOG_INDEX_PATH.startsWith("/api/")).toBe(true);
  });

  it("percent-encodes the track name into the query", () => {
    expect(catalogAudioSrc("a&b.mp3")).toBe(
      `${CATALOG_AUDIO_PATH}?${CATALOG_TRACK_PARAM}=a%26b.mp3`,
    );
  });

  it("builds the upstream URL under the configured base", () => {
    const base = resolveCatalogBase("https://cdn.example.test/lofi")!;
    expect(catalogFileUrl(base, "2-am-debug-loop.mp3")).toBe(
      "https://cdn.example.test/lofi/2-am-debug-loop.mp3",
    );
    expect(catalogIndexUrl(base)).toBe(
      "https://cdn.example.test/lofi/catalog.json",
    );
  });

  it("cannot be talked into a different upstream host by the filename", () => {
    const base = resolveCatalogBase("https://cdn.example.test/lofi/")!;
    // Even if a caller skipped isSafeCatalogFilename, encoding the segment
    // keeps every one of these inside the configured base's path.
    for (const hostile of [
      "../../evil.mp3",
      "/evil.mp3",
      "//evil.test/x.mp3",
      "..%2f..%2fevil.mp3",
    ]) {
      const url = new URL(catalogFileUrl(base, hostile));
      expect(url.host, hostile).toBe("cdn.example.test");
      expect(url.pathname.startsWith("/lofi/"), hostile).toBe(true);
    }
  });
});

describe("categoryLabel", () => {
  it("prefers the label the app already shows for a bundled category", () => {
    // Bundled and streamed tracks appear in one list, so "Chillhop" must not
    // become "Chillhop & Cozy Beats" halfway down it.
    expect(categoryLabel("chillhop", CATALOG_FIXTURE.categories)).toBe(
      "Chillhop",
    );
    expect(categoryLabel("soul-rnb", [])).toBe("Soul / R&B");
  });

  it("falls back to the catalog's own label for a category we do not bundle", () => {
    expect(categoryLabel("wind-chimes", CATALOG_FIXTURE.categories)).toBe(
      "Wind Chimes",
    );
  });

  it("humanises the slug when nothing supplies a label", () => {
    expect(categoryLabel("wind-chimes", [])).toBe("Wind chimes");
    expect(categoryLabel("", [])).toBe("Other");
  });
});

describe("parseCatalog", () => {
  it("maps the real catalog.json shape onto playable tracks", () => {
    const tracks = parseCatalog(CATALOG_FIXTURE);
    expect(tracks).toHaveLength(3);
    expect(tracks[0]).toEqual({
      id: `${CATALOG_TRACK_ID_PREFIX}2-am-debug-loop.mp3`,
      title: "2 AM Debug Loop",
      category: "activities",
      categoryLabel: "Activities",
      src: `${CATALOG_AUDIO_PATH}?${CATALOG_TRACK_PARAM}=2-am-debug-loop.mp3`,
    });
    expect(tracks[2].categoryLabel).toBe("Wind Chimes");
  });

  it("accepts a bare array of entries too", () => {
    expect(parseCatalog(CATALOG_FIXTURE.tracks)).toHaveLength(3);
  });

  it("returns nothing for anything that is not a catalog", () => {
    for (const raw of [null, undefined, "", 0, [], {}, { tracks: "no" }]) {
      expect(parseCatalog(raw), JSON.stringify(raw) ?? "undefined").toEqual([]);
    }
  });

  it("drops an entry whose filename could escape the catalog prefix", () => {
    const tracks = parseCatalog({
      tracks: [
        { title: "Evil", filename: "../../etc/passwd", category: "activities" },
        { title: "Also evil", filename: "a/b.mp3", category: "activities" },
        { title: "Good", filename: "good.mp3", category: "activities" },
      ],
    });
    expect(tracks.map((t) => t.title)).toEqual(["Good"]);
  });

  it("drops an entry with a missing, blank or non-string title", () => {
    const tracks = parseCatalog({
      tracks: [
        { filename: "a.mp3", category: "activities" },
        { title: "   ", filename: "b.mp3", category: "activities" },
        { title: 7, filename: "c.mp3", category: "activities" },
        { title: "Good", filename: "d.mp3", category: "activities" },
      ],
    });
    expect(tracks.map((t) => t.title)).toEqual(["Good"]);
  });

  it("survives junk entries without throwing", () => {
    const tracks = parseCatalog({
      tracks: [null, 42, "x", [], { title: "Good", filename: "d.mp3" }],
    });
    expect(tracks.map((t) => t.title)).toEqual(["Good"]);
    // A missing category is not a reason to drop a playable track.
    expect(tracks[0].category).toBe("");
    expect(tracks[0].categoryLabel).toBe("Other");
  });

  it("trims a title and keeps duplicate filenames out", () => {
    const tracks = parseCatalog({
      tracks: [
        { title: "  Spaced  ", filename: "a.mp3", category: "activities" },
        { title: "Same file again", filename: "a.mp3", category: "chillhop" },
      ],
    });
    expect(tracks).toHaveLength(1);
    expect(tracks[0].title).toBe("Spaced");
  });

  it("caps how many tracks one response can introduce", () => {
    // The catalog is fetched from a store the app does not own the contents of,
    // and every entry becomes a React list row. A cap keeps a bad or hostile
    // manifest from turning into an unbounded client render.
    const many = Array.from({ length: MAX_CATALOG_TRACKS + 50 }, (_, i) => ({
      title: `Track ${i}`,
      filename: `track-${i}.mp3`,
      category: "activities",
    }));
    expect(parseCatalog({ tracks: many })).toHaveLength(MAX_CATALOG_TRACKS);
  });

  it("truncates an absurdly long title rather than dropping the track", () => {
    const tracks = parseCatalog({
      tracks: [{ title: "T".repeat(500), filename: "a.mp3", category: "x" }],
    });
    expect(tracks).toHaveLength(1);
    expect(tracks[0].title.length).toBeLessThanOrEqual(120);
  });
});

describe("mergeFocusTracks", () => {
  it("keeps the bundled tracks first, at their existing indices", () => {
    // useFocusSound addresses tracks by index and seeds from Settings.focusSound,
    // so growing the playlist must never renumber what is already playing.
    const merged = mergeFocusTracks(
      FOCUS_SOUND_TRACKS,
      parseCatalog(CATALOG_FIXTURE),
    );
    expect(merged.slice(0, FOCUS_SOUND_TRACKS.length)).toEqual([
      ...FOCUS_SOUND_TRACKS,
    ]);
    expect(merged).toHaveLength(FOCUS_SOUND_TRACKS.length + 3);
  });

  it("prefers the bundled copy of a track the catalog also lists", () => {
    // The bundled ten come from this same catalog; the local file needs no
    // round trip and still plays when the store is unreachable.
    const merged = mergeFocusTracks(FOCUS_SOUND_TRACKS, [
      {
        id: `${CATALOG_TRACK_ID_PREFIX}aurora-on-mute.mp3`,
        title: "Aurora on Mute",
        category: "ambient-lofi",
        categoryLabel: "Ambient lo-fi",
        src: catalogAudioSrc("aurora-on-mute.mp3"),
      },
    ]);
    expect(merged).toHaveLength(FOCUS_SOUND_TRACKS.length);
    expect(merged.find((t) => t.title === "Aurora on Mute")?.src).toBe(
      "/audio/lofi/aurora-on-mute.mp3",
    );
  });

  it("returns the bundled array itself when there is nothing to add", () => {
    // Referential stability matters: useFocusSound re-deals its play order when
    // the track list changes, and an empty catalog must not look like a change.
    expect(mergeFocusTracks(FOCUS_SOUND_TRACKS, [])).toBe(FOCUS_SOUND_TRACKS);
  });

  it("never yields a track whose audio is not same-origin", () => {
    const merged = mergeFocusTracks(
      FOCUS_SOUND_TRACKS,
      parseCatalog(CATALOG_FIXTURE),
    );
    for (const track of merged) {
      expect(track.src.startsWith("/"), track.src).toBe(true);
      expect(track.src.startsWith("//"), track.src).toBe(false);
    }
  });
});
