import { describe, it, expect } from "vitest";
import {
  FOCUS_PLAYLIST_NAME_MAX_LENGTH,
  MAX_FOCUS_PLAYLISTS,
  MAX_FOCUS_PLAYLIST_TRACKS,
  MAX_FOCUS_TRACK_ID_LENGTH,
  addFocusPlaylistTracks,
  focusPlaylistNameError,
  focusPlaylistTracks,
  normaliseFocusPlaylistName,
  normaliseFocusTrackIds,
  removeFocusPlaylistTracks,
  selectedPlaylistTrackIds,
  type FocusPlaylistSummary,
} from "@/lib/focus-playlists";
import { FOCUS_SOUND_TRACKS, type FocusTrack } from "@/lib/focus-sounds";

const streamed = (name: string, category: string): FocusTrack => ({
  id: `catalog:${name}.mp3`,
  title: name,
  category,
  categoryLabel: category,
  src: `/api/focus-catalog/audio?track=${name}.mp3`,
});

const CATALOGUE: FocusTrack[] = [
  ...FOCUS_SOUND_TRACKS,
  streamed("Paper Cranes", "chillhop"),
  streamed("Second Wind", "chillhop"),
];

const playlist = (
  id: string,
  trackIds: string[],
  name = id,
): FocusPlaylistSummary => ({ id, name, trackIds });

describe("normaliseFocusPlaylistName (#185)", () => {
  it("trims, and collapses internal whitespace runs to one space", () => {
    expect(normaliseFocusPlaylistName("  Deep   work \n")).toBe("Deep work");
  });

  it("is null for empty and whitespace-only input", () => {
    expect(normaliseFocusPlaylistName("")).toBeNull();
    expect(normaliseFocusPlaylistName("   \t \n ")).toBeNull();
  });

  it("accepts exactly the bound and refuses one character past it", () => {
    const atBound = "x".repeat(FOCUS_PLAYLIST_NAME_MAX_LENGTH);
    expect(normaliseFocusPlaylistName(atBound)).toBe(atBound);
    expect(normaliseFocusPlaylistName(`${atBound}x`)).toBeNull();
  });

  it("measures the bound AFTER collapsing, so padding never costs a name", () => {
    const padded = `  ${"x".repeat(FOCUS_PLAYLIST_NAME_MAX_LENGTH)}  `;
    expect(normaliseFocusPlaylistName(padded)).toHaveLength(
      FOCUS_PLAYLIST_NAME_MAX_LENGTH,
    );
  });

  it("counts characters, not UTF-8 bytes — an emoji name is not a long one", () => {
    // 🎧 is 4 bytes and 2 UTF-16 code units; [...str].length counts it once, so
    // an all-emoji name must clear a bound a byte count would reject.
    const emoji = "🎧".repeat(FOCUS_PLAYLIST_NAME_MAX_LENGTH);
    expect(normaliseFocusPlaylistName(emoji)).toBe(emoji);
    expect(normaliseFocusPlaylistName(`${emoji}🎧`)).toBeNull();
  });
});

describe("focusPlaylistNameError (#185)", () => {
  it("names which refusal it is, so the field can say why", () => {
    expect(focusPlaylistNameError("  ")).toBe("empty");
    expect(
      focusPlaylistNameError("x".repeat(FOCUS_PLAYLIST_NAME_MAX_LENGTH + 1)),
    ).toBe("too-long");
    expect(focusPlaylistNameError("Deep work")).toBeNull();
  });
});

describe("normaliseFocusTrackIds (#185)", () => {
  it("keeps first-seen order and drops duplicates", () => {
    expect(normaliseFocusTrackIds(["b", "a", "b", "c", "a"])).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("drops non-strings, blanks and ids longer than the id bound", () => {
    expect(
      normaliseFocusTrackIds([
        "keep",
        "",
        "   ",
        42,
        null,
        undefined,
        { id: "no" },
        "x".repeat(MAX_FOCUS_TRACK_ID_LENGTH + 1),
      ]),
    ).toEqual(["keep"]);
  });

  it("caps the array, because the column takes whatever a caller posts", () => {
    const many = Array.from(
      { length: MAX_FOCUS_PLAYLIST_TRACKS + 25 },
      (_, i) => `t${i}`,
    );
    const out = normaliseFocusTrackIds(many);
    expect(out).toHaveLength(MAX_FOCUS_PLAYLIST_TRACKS);
    expect(out[0]).toBe("t0");
  });

  it("does not trim an id — a track id is data, not a name", () => {
    expect(normaliseFocusTrackIds([" spaced "])).toEqual([" spaced "]);
  });
});

describe("addFocusPlaylistTracks (#185)", () => {
  it("appends in order and collapses what is already there", () => {
    expect(addFocusPlaylistTracks(["a", "b"], ["b", "c", "c", "d"])).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("returns the same array identity when nothing new arrives", () => {
    const existing = ["a", "b"];
    expect(addFocusPlaylistTracks(existing, ["a", "b"])).toBe(existing);
  });

  it("still honours the cap when a whole category is dropped in", () => {
    const existing = Array.from(
      { length: MAX_FOCUS_PLAYLIST_TRACKS },
      (_, i) => `t${i}`,
    );
    expect(addFocusPlaylistTracks(existing, ["extra"])).toHaveLength(
      MAX_FOCUS_PLAYLIST_TRACKS,
    );
  });
});

describe("removeFocusPlaylistTracks (#185)", () => {
  it("removes every named id and leaves the rest in order", () => {
    expect(removeFocusPlaylistTracks(["a", "b", "c", "d"], ["b", "d"])).toEqual(
      ["a", "c"],
    );
  });

  it("returns the same array identity when nothing matched", () => {
    const existing = ["a", "b"];
    expect(removeFocusPlaylistTracks(existing, ["z"])).toBe(existing);
  });
});

describe("selectedPlaylistTrackIds (#185)", () => {
  const playlists = [
    playlist("p1", ["a", "b"]),
    playlist("p2", ["b", "c"]),
    playlist("p3", ["z"]),
  ];

  it("unions the selected playlists and de-duplicates across them", () => {
    expect(selectedPlaylistTrackIds(playlists, ["p1", "p2"])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("ignores an id no playlist carries — a stale or foreign selection", () => {
    expect(selectedPlaylistTrackIds(playlists, ["p1", "gone"])).toEqual([
      "a",
      "b",
    ]);
  });

  it("is empty for an empty or absent selection", () => {
    expect(selectedPlaylistTrackIds(playlists, [])).toEqual([]);
    expect(selectedPlaylistTrackIds(playlists, null)).toEqual([]);
    expect(selectedPlaylistTrackIds(playlists, undefined)).toEqual([]);
  });
});

describe("focusPlaylistTracks (#185)", () => {
  it("resolves in the playlist's OWN order, not the catalogue's", () => {
    const ids = [CATALOGUE[2].id, CATALOGUE[0].id];
    expect(focusPlaylistTracks(CATALOGUE, ids).map((t) => t.id)).toEqual(ids);
  });

  it("filters an id this instance's catalogue does not carry", () => {
    // The self-hoster case the model exists for: track ids are catalogue data,
    // so a playlist built elsewhere can name tracks that are simply absent.
    expect(
      focusPlaylistTracks(CATALOGUE, ["catalog:nowhere.mp3", CATALOGUE[0].id]),
    ).toEqual([CATALOGUE[0]]);
  });

  it("is empty rather than throwing when nothing resolves", () => {
    expect(focusPlaylistTracks(CATALOGUE, ["a", "b"])).toEqual([]);
    expect(focusPlaylistTracks(CATALOGUE, [])).toEqual([]);
  });
});

describe("the bounds themselves (#185)", () => {
  it("are the values the DB constraint and the UI are written against", () => {
    // Pinned rather than merely exported: the migration's CHECK, the input's
    // maxLength and the action's refusal all quote these, and a silent bump
    // would leave the three disagreeing about the same rule.
    expect(FOCUS_PLAYLIST_NAME_MAX_LENGTH).toBe(60);
    expect(MAX_FOCUS_PLAYLISTS).toBe(50);
    expect(MAX_FOCUS_PLAYLIST_TRACKS).toBe(500);
    expect(MAX_FOCUS_TRACK_ID_LENGTH).toBe(200);
  });
});
