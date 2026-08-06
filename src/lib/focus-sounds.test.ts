// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FocusSoundCategory } from "@/lib/constants";

// A fake HTMLAudioElement — records construction + play/pause + mutations.
const audioPlay = vi.fn().mockResolvedValue(undefined);
const audioPause = vi.fn();
class FakeAudio {
  src: string;
  loop = false;
  currentTime = 0;
  volume = 1;
  onended: (() => void) | null = null;
  play = audioPlay;
  pause = audioPause;
  constructor(src: string) {
    this.src = src;
  }
}

const vibrate = vi.fn();
const wakeRelease = vi.fn().mockResolvedValue(undefined);
const wakeRequest = vi.fn().mockResolvedValue({ release: wakeRelease });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("Audio", FakeAudio as unknown as typeof Audio);
  vi.stubGlobal("navigator", { vibrate, wakeLock: { request: wakeRequest } });
});
afterEach(() => vi.unstubAllGlobals());

describe("focus-sounds — FOCUS_SOUND_SRC + track catalog", () => {
  it("maps off → null and lofi_calm → the bundled ambient track (placeholder replaced)", async () => {
    const { FOCUS_SOUND_SRC } = await import("@/lib/focus-sounds");
    expect(FOCUS_SOUND_SRC.off).toBeNull();
    expect(FOCUS_SOUND_SRC.lofi_calm).toBe("/audio/lofi/aurora-on-mute.mp3");
    // The dead silent placeholder must no longer be referenced.
    expect(Object.values(FOCUS_SOUND_SRC)).not.toContain(
      "/audio/lofi-calm.mp3",
    );
  });

  it("has one curated track per BundledFocusTrack id, all under /audio/lofi/", async () => {
    const { FOCUS_SOUND_TRACKS, FOCUS_SOUND_SRC, BundledFocusTrack } =
      await import("@/lib/focus-sounds");
    // #180 — the ids moved out of FocusSound (now a two-value switch) into their
    // own object. The bijection they had with the catalogue is the thing that
    // must survive the move, so it is still asserted, just against the new home.
    expect(FOCUS_SOUND_TRACKS.map((t) => t.id).sort()).toEqual(
      Object.values(BundledFocusTrack).sort(),
    );
    for (const t of FOCUS_SOUND_TRACKS) {
      expect(t.src).toMatch(/^\/audio\/lofi\/.+\.mp3$/);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.categoryLabel.length).toBeGreaterThan(0);
      expect(FOCUS_SOUND_SRC[t.id]).toBe(t.src);
    }
    // 10 open-lofi categories, one track each.
    expect(new Set(FOCUS_SOUND_TRACKS.map((t) => t.category)).size).toBe(
      FOCUS_SOUND_TRACKS.length,
    );
  });
});

/**
 * #70 — the category vocabulary moved into constants.ts.
 *
 * It had to move: `Settings.focusSoundCategory` is a CHECK-constrained column,
 * and `enum-constraint-sync` derives the expected value set from a constants.ts
 * object rather than a re-typed literal list. Leaving the slugs here as inline
 * strings would have left the constraint mirroring nothing.
 *
 * These two assertions are the lockstep. `focus-sounds.ts` imports the constant
 * (it cannot be the other way round — constants.ts must stay dependency-free),
 * so a slug can only drift by adding a category with no bundled track or a
 * bundled track with a category the constraint would reject; both fail here.
 */
describe("focus-sounds — the category vocabulary (#70)", () => {
  it("bundles exactly one track per FocusSoundCategory value, and no others", async () => {
    const { FOCUS_SOUND_TRACKS } = await import("@/lib/focus-sounds");
    const declared = Object.values(FocusSoundCategory);
    expect(FOCUS_SOUND_TRACKS.map((t) => t.category).sort()).toEqual(
      [...declared].sort(),
    );
  });

  it("uses open-lofi's own slugs, not paraphrases of them", async () => {
    // Spelled out because #70's first version invented `ambient`, `asian` and
    // `seasonal`, none of which exist. The corrected slugs are the contract the
    // picker, the constraint and any future manifest all have to agree on, so
    // they are pinned as literals here rather than derived from the code they
    // are meant to police.
    expect(Object.values(FocusSoundCategory).sort()).toEqual(
      [
        "activities",
        "ambient-lofi",
        "asian-lofi",
        "chillhop",
        "funk-soul",
        "hybrid",
        "jazzhop",
        "late-night",
        "seasonal-weather",
        "soul-rnb",
      ].sort(),
    );
  });
});

/**
 * #70 — grouping the playlist by category, as pure functions.
 *
 * The two rules these pin are different on purpose, and the difference is the
 * answer to "what should the picker do on an instance with no catalog?":
 *
 *  * **Offering** a category needs MIN_CATEGORY_PLAYLIST_TRACKS of them. A
 *    one-track category IS that track, and offering it recreates exactly the
 *    objection that had #70 blocked on #61 in the first place.
 *  * **Honouring** a stored one does not. A selection made while the catalog was
 *    reachable must not silently change genre when it goes away, so a category
 *    that has shrunk to one track plays that one track.
 */
describe("focus-sounds — category playlists (#70)", () => {
  const streamed = (title: string, category: string, label: string) => ({
    id: `catalog:${title.toLowerCase().replace(/\W+/g, "-")}.mp3`,
    title,
    category,
    categoryLabel: label,
    src: `/api/focus-catalog/audio?track=${title.toLowerCase().replace(/\W+/g, "-")}.mp3`,
  });

  it("tracksInCategory keeps only that category, in list order", async () => {
    const { tracksInCategory, FOCUS_SOUND_TRACKS } =
      await import("@/lib/focus-sounds");
    const grown = [
      ...FOCUS_SOUND_TRACKS,
      streamed("Paper Cranes", "chillhop", "Chillhop"),
      streamed("Bell Field", "hybrid", "Hybrid / world"),
    ];
    const chillhop = tracksInCategory(grown, "chillhop");
    expect(chillhop.map((t) => t.title)).toEqual([
      "Porchlight Golden Hour",
      "Paper Cranes",
    ]);
    expect(tracksInCategory(grown, "no-such-category")).toEqual([]);
  });

  it("focusPlaylistCategories offers nothing when every category has one track", async () => {
    // The default install: #43's bundled ten, one per category. This is the
    // whole no-catalog-configured decision in one assertion.
    const { focusPlaylistCategories, FOCUS_SOUND_TRACKS } =
      await import("@/lib/focus-sounds");
    expect(focusPlaylistCategories(FOCUS_SOUND_TRACKS)).toEqual([]);
  });

  it("focusPlaylistCategories offers only the categories that reached the floor", async () => {
    const { focusPlaylistCategories, FOCUS_SOUND_TRACKS } =
      await import("@/lib/focus-sounds");
    const grown = [
      ...FOCUS_SOUND_TRACKS,
      streamed("Paper Cranes", "chillhop", "Chillhop"),
      streamed("Second Wind", "chillhop", "Chillhop"),
      streamed("Bell Field", "hybrid", "Hybrid / world"),
    ];
    expect(focusPlaylistCategories(grown)).toEqual([
      { slug: "chillhop", label: "Chillhop", count: 3 },
      { slug: "hybrid", label: "Hybrid / world", count: 2 },
    ]);
  });

  it("focusPlaylistCategories keeps first-appearance order and labels a category we do not bundle", async () => {
    const { focusPlaylistCategories, FOCUS_SOUND_TRACKS } =
      await import("@/lib/focus-sounds");
    const grown = [
      ...FOCUS_SOUND_TRACKS,
      streamed("Wind One", "wind-chimes", "Wind chimes"),
      streamed("Wind Two", "wind-chimes", "Wind chimes"),
      streamed("Paper Cranes", "chillhop", "Chillhop"),
    ];
    // Bundled categories come first in the merged list, so `chillhop` is offered
    // before `wind-chimes` even though its second track arrived later.
    expect(focusPlaylistCategories(grown).map((c) => c.slug)).toEqual([
      "chillhop",
      "wind-chimes",
    ]);
  });

  it("trackIndexIn addresses a track inside the resolved list, not the bundled one", async () => {
    // focusTrackIndex() searches FOCUS_SOUND_TRACKS, so it returns 1 for the
    // chillhop track wherever that track actually is. Inside a narrowed playlist
    // that index is wrong, which is why this exists.
    const {
      trackIndexIn,
      focusTrackIndex,
      resolveFocusPool,
      FOCUS_SOUND_TRACKS,
      BundledFocusTrack,
    } = await import("@/lib/focus-sounds");
    const narrowed = resolveFocusPool(FOCUS_SOUND_TRACKS, ["chillhop"]);
    expect(focusTrackIndex(BundledFocusTrack.Chillhop)).toBe(1);
    expect(trackIndexIn(narrowed, BundledFocusTrack.Chillhop)).toBe(0);
    expect(trackIndexIn(narrowed, BundledFocusTrack.Jazzhop)).toBe(-1);
    expect(trackIndexIn(narrowed, "off")).toBe(-1);
  });

  it("offerableFocusCategories drops a category the database could not store", async () => {
    // A self-hoster's manifest may declare categories outside open-lofi's ten.
    // Those tracks still play (they are in the merged list), but the category
    // cannot be SAVED — Settings_focusSoundCategories_check would reject it — so
    // offering it would produce a control that silently does not stick.
    const {
      offerableFocusCategories,
      focusPlaylistCategories,
      FOCUS_SOUND_TRACKS,
    } = await import("@/lib/focus-sounds");
    const grown = [
      ...FOCUS_SOUND_TRACKS,
      streamed("Wind One", "wind-chimes", "Wind chimes"),
      streamed("Wind Two", "wind-chimes", "Wind chimes"),
      streamed("Paper Cranes", "chillhop", "Chillhop"),
    ];
    expect(focusPlaylistCategories(grown).map((c) => c.slug)).toContain(
      "wind-chimes",
    );
    expect(offerableFocusCategories(grown).map((c) => c.slug)).toEqual([
      "chillhop",
    ]);
  });
});

/**
 * #180 — the pool a session draws from is now the UNION of several categories.
 *
 * `resolveFocusPlaylist` took one nullable slug; `resolveFocusPool` takes an
 * array, and empty means the whole catalogue (what #70's NULL meant). All three
 * of the old fallbacks are kept, because each one exists to stop a focus session
 * going silent — the failure a user reports as the feature being broken.
 */
describe("focus-sounds — the multi-category pool (#180)", () => {
  const streamed = (title: string, category: string, label: string) => ({
    id: `catalog:${title.toLowerCase().replace(/\W+/g, "-")}.mp3`,
    title,
    category,
    categoryLabel: label,
    src: `/api/focus-catalog/audio?track=${title.toLowerCase().replace(/\W+/g, "-")}.mp3`,
  });

  it("returns the SAME array when nothing is selected", async () => {
    // Identity, not equality: useFocusSound re-deals its play order when the
    // list changes, and "the whole catalogue" must not look like a change. All
    // three spellings of "nothing" have to behave alike — the column is NOT NULL
    // so `[]` is the real one, but the prop is optional on the way down.
    const { resolveFocusPool, FOCUS_SOUND_TRACKS } =
      await import("@/lib/focus-sounds");
    expect(resolveFocusPool(FOCUS_SOUND_TRACKS, [])).toBe(FOCUS_SOUND_TRACKS);
    expect(resolveFocusPool(FOCUS_SOUND_TRACKS, null)).toBe(FOCUS_SOUND_TRACKS);
    expect(resolveFocusPool(FOCUS_SOUND_TRACKS, undefined)).toBe(
      FOCUS_SOUND_TRACKS,
    );
  });

  it("narrows to one selected category", async () => {
    const { resolveFocusPool, FOCUS_SOUND_TRACKS } =
      await import("@/lib/focus-sounds");
    const grown = [
      ...FOCUS_SOUND_TRACKS,
      streamed("Paper Cranes", "chillhop", "Chillhop"),
    ];
    expect(resolveFocusPool(grown, ["chillhop"]).map((t) => t.title)).toEqual([
      "Porchlight Golden Hour",
      "Paper Cranes",
    ]);
  });

  it("returns the union in CATALOGUE order, not selection order", async () => {
    // The distinction that matters: the pool is a filter over the list, so the
    // player's in-order pass reads in the same order as the catalogue however
    // the categories were ticked. Building it by concatenating per-category
    // slices would group the playlist by category instead, which sounds like
    // three short playlists rather than one.
    const { resolveFocusPool, FOCUS_SOUND_TRACKS } =
      await import("@/lib/focus-sounds");
    const grown = [
      ...FOCUS_SOUND_TRACKS,
      streamed("Paper Cranes", "chillhop", "Chillhop"),
    ];
    expect(
      resolveFocusPool(grown, ["hybrid", "chillhop"]).map((t) => t.title),
    ).toEqual(["Porchlight Golden Hour", "Cafe Da Tarde", "Paper Cranes"]);
  });

  it("never yields the same track twice, however the selection is spelled", async () => {
    // Duplicates are not reachable through the UI, but the column is a plain
    // text[] — a hand-edited row, or a future writer that forgets to dedupe,
    // must not make the player think it has two tracks and skip one on wrap.
    const { resolveFocusPool, FOCUS_SOUND_TRACKS } =
      await import("@/lib/focus-sounds");
    expect(
      resolveFocusPool(FOCUS_SOUND_TRACKS, [
        "chillhop",
        "chillhop",
        "jazzhop",
      ]).map((t) => t.title),
    ).toEqual(["Porchlight Golden Hour", "Breezy Afternoon Terrace"]);
  });

  it("honours a selection that has shrunk to one track", async () => {
    // The catalog went away under a stored selection. Playing the one bundled
    // chillhop track is what the user asked for; falling back to all ten would
    // silently change the genre, which is worse than a short playlist.
    const { resolveFocusPool, FOCUS_SOUND_TRACKS } =
      await import("@/lib/focus-sounds");
    expect(
      resolveFocusPool(FOCUS_SOUND_TRACKS, ["chillhop"]).map((t) => t.title),
    ).toEqual(["Porchlight Golden Hour"]);
  });

  it("falls back to the whole catalogue when every selected category is absent", async () => {
    // A retired slug, or a manifest that stopped carrying the category. Silence
    // is the one outcome a focus session must never reach by accident.
    const { resolveFocusPool, FOCUS_SOUND_TRACKS } =
      await import("@/lib/focus-sounds");
    expect(resolveFocusPool(FOCUS_SOUND_TRACKS, ["retired-slug"])).toBe(
      FOCUS_SOUND_TRACKS,
    );
    expect(resolveFocusPool(FOCUS_SOUND_TRACKS, ["retired", "gone"])).toBe(
      FOCUS_SOUND_TRACKS,
    );
  });

  it("lets an absent category contribute nothing rather than emptying the union", async () => {
    // The fallback above is for a selection that resolves to NOTHING. One dead
    // slug alongside a live one must not widen the pool back to all ten — the
    // live half is still exactly what was asked for.
    const { resolveFocusPool, FOCUS_SOUND_TRACKS } =
      await import("@/lib/focus-sounds");
    expect(
      resolveFocusPool(FOCUS_SOUND_TRACKS, ["retired-slug", "jazzhop"]).map(
        (t) => t.title,
      ),
    ).toEqual(["Breezy Afternoon Terrace"]);
  });

  it("returns an empty list only when the catalogue itself is empty", async () => {
    const { resolveFocusPool } = await import("@/lib/focus-sounds");
    expect(resolveFocusPool([], ["chillhop"])).toEqual([]);
    expect(resolveFocusPool([], [])).toEqual([]);
  });
});

describe("focus-sounds — pure playlist helpers", () => {
  it("focusTrackById / focusTrackIndex resolve real tracks and reject off/unknown", async () => {
    const {
      focusTrackById,
      focusTrackIndex,
      FOCUS_SOUND_TRACKS,
      BundledFocusTrack,
    } = await import("@/lib/focus-sounds");
    expect(focusTrackById(BundledFocusTrack.Calm)?.id).toBe(
      BundledFocusTrack.Calm,
    );
    expect(focusTrackById("off")).toBeUndefined();
    expect(focusTrackById("nope")).toBeUndefined();
    expect(focusTrackIndex(FOCUS_SOUND_TRACKS[0].id)).toBe(0);
    expect(focusTrackIndex("off")).toBe(-1);
  });

  it("next/prev cycle the playlist and wrap around", async () => {
    const { nextFocusTrackId, prevFocusTrackId, FOCUS_SOUND_TRACKS } =
      await import("@/lib/focus-sounds");
    const ids = FOCUS_SOUND_TRACKS.map((t) => t.id);
    const first = ids[0];
    const last = ids[ids.length - 1];
    expect(nextFocusTrackId(first)).toBe(ids[1]);
    expect(nextFocusTrackId(last)).toBe(first); // wrap forward
    expect(prevFocusTrackId(first)).toBe(last); // wrap back
    expect(prevFocusTrackId(ids[1])).toBe(first);
  });

  it("next/prev fall back to first/last when given off/unknown", async () => {
    const { nextFocusTrackId, prevFocusTrackId, FOCUS_SOUND_TRACKS } =
      await import("@/lib/focus-sounds");
    const ids = FOCUS_SOUND_TRACKS.map((t) => t.id);
    expect(nextFocusTrackId("off")).toBe(ids[0]);
    expect(prevFocusTrackId("off")).toBe(ids[ids.length - 1]);
  });

  it("clampVolume constrains to [0,1] and defaults NaN to 1", async () => {
    const { clampVolume } = await import("@/lib/focus-sounds");
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(-3)).toBe(0);
    expect(clampVolume(9)).toBe(1);
    expect(clampVolume(Number.NaN)).toBe(1);
  });
});

// #68 — the play order is what stops the "same track again" complaint: the
// player consumes a whole pass before it wraps, so no track can repeat
// mid-pass in either order.
describe("focus-sounds — play order (#68)", () => {
  it("shuffleIndices returns a permutation of a COPY (input untouched)", async () => {
    const { shuffleIndices } = await import("@/lib/focus-sounds");
    const input = [0, 1, 2, 3, 4];
    const out = shuffleIndices(input);
    expect(out).not.toBe(input);
    expect(input).toEqual([0, 1, 2, 3, 4]);
    expect([...out].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("shuffleIndices is deterministic for an injected rng (Fisher–Yates)", async () => {
    const { shuffleIndices } = await import("@/lib/focus-sounds");
    // rng always 0 → every swap picks index 0.
    expect(shuffleIndices([0, 1, 2], () => 0)).toEqual([1, 2, 0]);
    // rng at the top of the range → each element swaps with itself (identity).
    expect(shuffleIndices([0, 1, 2], () => 0.99)).toEqual([0, 1, 2]);
  });

  it("buildPlayOrder is the sequential order when shuffle is off", async () => {
    const { buildPlayOrder } = await import("@/lib/focus-sounds");
    expect(buildPlayOrder(4, { shuffle: false })).toEqual([0, 1, 2, 3]);
    // startAt does not rotate an in-order pass — the cursor handles that.
    expect(buildPlayOrder(4, { shuffle: false, startAt: 2 })).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("a shuffled pass contains every track exactly once", async () => {
    const { buildPlayOrder } = await import("@/lib/focus-sounds");
    for (let attempt = 0; attempt < 50; attempt++) {
      const order = buildPlayOrder(10, { shuffle: true });
      expect([...order].sort((a, b) => a - b)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);
    }
  });

  it("a shuffled pass starts at startAt, so the chosen track plays first", async () => {
    const { buildPlayOrder } = await import("@/lib/focus-sounds");
    for (let attempt = 0; attempt < 50; attempt++) {
      const order = buildPlayOrder(10, { shuffle: true, startAt: 7 });
      expect(order[0]).toBe(7);
      expect(new Set(order).size).toBe(10);
    }
  });

  it("ignores an out-of-range startAt rather than corrupting the pass", async () => {
    const { buildPlayOrder } = await import("@/lib/focus-sounds");
    const order = buildPlayOrder(5, { shuffle: true, startAt: 99 });
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("avoidFirst keeps the just-played track off the head of the next pass", async () => {
    const { buildPlayOrder } = await import("@/lib/focus-sounds");
    for (let attempt = 0; attempt < 50; attempt++) {
      const order = buildPlayOrder(10, { shuffle: true, avoidFirst: 3 });
      expect(order[0]).not.toBe(3);
      expect(new Set(order).size).toBe(10);
    }
  });

  it("avoidFirst is ignored for a one-track playlist (nothing else to play)", async () => {
    const { buildPlayOrder } = await import("@/lib/focus-sounds");
    expect(buildPlayOrder(1, { shuffle: true, avoidFirst: 0 })).toEqual([0]);
  });

  it("returns an empty order for an empty playlist", async () => {
    const { buildPlayOrder } = await import("@/lib/focus-sounds");
    expect(buildPlayOrder(0, { shuffle: true })).toEqual([]);
    expect(buildPlayOrder(0, { shuffle: false })).toEqual([]);
  });

  it("playOrderCursor locates a track in the pass and falls back to the head", async () => {
    const { playOrderCursor } = await import("@/lib/focus-sounds");
    expect(playOrderCursor([4, 2, 0, 1, 3], 0)).toBe(2);
    expect(playOrderCursor([4, 2, 0, 1, 3], 4)).toBe(0);
    expect(playOrderCursor([4, 2, 0, 1, 3], 9)).toBe(0);
    expect(playOrderCursor([], 0)).toBe(0);
  });
});

describe("createAlarm", () => {
  it("plays the chime from the start and vibrates on play()", async () => {
    const { createAlarm } = await import("@/lib/focus-sounds");
    createAlarm().play();
    expect(audioPlay).toHaveBeenCalled();
    expect(vibrate).toHaveBeenCalled();
  });
});

describe("createPlaylistPlayer", () => {
  it("play/pause/stop drive the element", async () => {
    const { createPlaylistPlayer } = await import("@/lib/focus-sounds");
    const p = createPlaylistPlayer("/audio/lofi/aurora-on-mute.mp3");
    p.play();
    expect(audioPlay).toHaveBeenCalled();
    p.pause();
    expect(audioPause).toHaveBeenCalledTimes(1);
    p.stop();
    expect(audioPause).toHaveBeenCalledTimes(2);
  });

  // #68 — the element must NOT loop: a looping single source is exactly the
  // "it repeats the same track" bug. The playlist advances on `ended` instead.
  it("never loops the element and reports the track end via onEnded", async () => {
    const { createPlaylistPlayer } = await import("@/lib/focus-sounds");
    const captured: FakeAudio[] = [];
    vi.stubGlobal(
      "Audio",
      class extends FakeAudio {
        constructor(src: string) {
          super(src);
          captured.push(this);
        }
      } as unknown as typeof Audio,
    );
    const onEnded = vi.fn();
    const p = createPlaylistPlayer("/audio/lofi/aurora-on-mute.mp3", {
      onEnded,
    });
    expect(captured[0].loop).toBe(false);
    p.play();
    captured[0].onended?.();
    expect(onEnded).toHaveBeenCalledTimes(1);
    // Swapping the source (next/prev/auto-advance) keeps the handler attached,
    // so the pass keeps advancing for the whole session.
    p.load("/audio/lofi/3-am-echoes.mp3");
    captured[0].onended?.();
    expect(onEnded).toHaveBeenCalledTimes(2);
  });

  it("setVolume clamps and initial volume is applied", async () => {
    const { createPlaylistPlayer } = await import("@/lib/focus-sounds");
    const captured: FakeAudio[] = [];
    vi.stubGlobal(
      "Audio",
      class extends FakeAudio {
        constructor(src: string) {
          super(src);
          captured.push(this);
        }
      } as unknown as typeof Audio,
    );
    const p = createPlaylistPlayer("/audio/lofi/aurora-on-mute.mp3", {
      volume: 0.3,
    });
    expect(captured[0].volume).toBe(0.3);
    p.setVolume(2); // clamps to 1
    expect(captured[0].volume).toBe(1);
  });

  it("play() after pause() resumes from the current position (no currentTime reset)", async () => {
    const { createPlaylistPlayer } = await import("@/lib/focus-sounds");
    const captured: FakeAudio[] = [];
    vi.stubGlobal(
      "Audio",
      class extends FakeAudio {
        constructor(src: string) {
          super(src);
          captured.push(this);
        }
      } as unknown as typeof Audio,
    );
    const p = createPlaylistPlayer("/audio/lofi/aurora-on-mute.mp3");
    p.play();
    // Simulate playback progress, then a timer-driven pause + resume.
    captured[0].currentTime = 42;
    p.pause();
    expect(captured[0].currentTime).toBe(42);
    p.play();
    // Resume must NOT rewind — play() leaves currentTime untouched.
    expect(captured[0].currentTime).toBe(42);
  });

  it("stop() rewinds to the start (session-end semantics)", async () => {
    const { createPlaylistPlayer } = await import("@/lib/focus-sounds");
    const captured: FakeAudio[] = [];
    vi.stubGlobal(
      "Audio",
      class extends FakeAudio {
        constructor(src: string) {
          super(src);
          captured.push(this);
        }
      } as unknown as typeof Audio,
    );
    const p = createPlaylistPlayer("/audio/lofi/aurora-on-mute.mp3");
    p.play();
    captured[0].currentTime = 30;
    p.stop();
    expect(captured[0].currentTime).toBe(0);
  });

  it("load() swaps the source and resumes only when playing", async () => {
    const { createPlaylistPlayer } = await import("@/lib/focus-sounds");
    const captured: FakeAudio[] = [];
    vi.stubGlobal(
      "Audio",
      class extends FakeAudio {
        constructor(src: string) {
          super(src);
          captured.push(this);
        }
      } as unknown as typeof Audio,
    );
    const p = createPlaylistPlayer("/audio/lofi/aurora-on-mute.mp3");
    // Not playing yet: load swaps src but does not auto-play.
    p.load("/audio/lofi/3-am-echoes.mp3");
    expect(captured[0].src).toBe("/audio/lofi/3-am-echoes.mp3");
    expect(audioPlay).not.toHaveBeenCalled();
    // Now playing: load swaps src AND resumes.
    p.play();
    audioPlay.mockClear();
    p.load("/audio/lofi/cafe-da-tarde.mp3");
    expect(captured[0].src).toBe("/audio/lofi/cafe-da-tarde.mp3");
    expect(audioPlay).toHaveBeenCalled();
  });
});

describe("createPreviewPlayer", () => {
  it("plays one source and stopping pauses it; a second preview replaces the first", async () => {
    const { createPreviewPlayer } = await import("@/lib/focus-sounds");
    const preview = createPreviewPlayer();
    preview.play("/audio/lofi/aurora-on-mute.mp3");
    expect(audioPlay).toHaveBeenCalledTimes(1);
    preview.play("/audio/lofi/3-am-echoes.mp3"); // stops+replaces
    expect(audioPause).toHaveBeenCalled();
    expect(audioPlay).toHaveBeenCalledTimes(2);
    const pausesBeforeStop = audioPause.mock.calls.length;
    preview.stop();
    expect(audioPause.mock.calls.length).toBe(pausesBeforeStop + 1);
  });
});

describe("acquireWakeLock", () => {
  it("requests a screen wake lock and releases via the guard", async () => {
    const { acquireWakeLock } = await import("@/lib/focus-sounds");
    const guard = await acquireWakeLock();
    expect(wakeRequest).toHaveBeenCalledWith("screen");
    guard.release();
    expect(wakeRelease).toHaveBeenCalled();
  });

  it("degrades to a no-op guard when the Wake Lock API is unavailable", async () => {
    vi.stubGlobal("navigator", {}); // no wakeLock
    const { acquireWakeLock } = await import("@/lib/focus-sounds");
    const guard = await acquireWakeLock();
    expect(() => guard.release()).not.toThrow();
    expect(wakeRequest).not.toHaveBeenCalled();
  });
});
