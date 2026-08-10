/**
 * Browser-API boundary for the focus timer's device effects (MR ②, extended by
 * #43). Everything here touches the DOM / navigator and degrades silently where
 * unsupported, so the timer component stays thin and its tests mock this module.
 * Audio must be constructed inside a user gesture (the Start tap, or a tap on a
 * player/preview control) so the browser unlocks later programmatic playback.
 */

import { FocusSound, FocusSoundCategory } from "@/lib/constants";

/**
 * #43 — the id of each bundled CC0 track.
 *
 * These lived in `FocusSound` (src/lib/constants.ts) until #180, because
 * `Settings.focusSound` used to persist one of them as the session's opening
 * track. It does not any more — that column is a two-value switch — so they are
 * no longer a DB value set and have no CHECK constraint to mirror. Keeping them
 * in constants.ts would have left `enum-constraint-sync`'s neighbours implying a
 * constraint that does not exist.
 *
 * They are still ids, and still stable ones: `/api/focus-catalog` distinguishes a
 * bundled track from a streamed one by the absence of `CATALOG_TRACK_ID_PREFIX`,
 * and `lofi_calm` is retained from MR ② rather than renamed to match its
 * category, so nothing that recorded a track id by value has to be rewritten.
 */
export const BundledFocusTrack = {
  Calm: "lofi_calm",
  Chillhop: "lofi_chillhop",
  Jazzhop: "lofi_jazzhop",
  SoulRnb: "lofi_soul_rnb",
  LateNight: "lofi_late_night",
  FunkSoul: "lofi_funk_soul",
  Asian: "lofi_asian",
  Seasonal: "lofi_seasonal",
  Activities: "lofi_activities",
  Hybrid: "lofi_hybrid",
} as const;
export type BundledFocusTrack =
  (typeof BundledFocusTrack)[keyof typeof BundledFocusTrack];

/**
 * #43 — the curated, bundled lo-fi library. One CC0 track per open-lofi category
 * (see public/audio/lofi/ + public/audio/LICENSE.md for provenance). This array
 * is the in-timer mini-player's playlist, and its order is the in-order pass
 * (#68). Titles/categories mirror open-lofi's catalog.json.
 */
export type FocusTrack = {
  id: string;
  title: string;
  /**
   * The category slug. Typed `string`, not `FocusSoundCategory`, and that is the
   * decision rather than laziness: a BUNDLED track always carries one of the ten
   * (`focus-sounds.test.ts` asserts the bijection), but a STREAMED one carries
   * whatever its manifest said, including a category this app has never heard of
   * — `categoryLabel()` in focus-catalog.ts humanises exactly that case. Only the
   * ten are persistable (#70); an unknown one still plays and still groups.
   */
  category: string;
  categoryLabel: string;
  src: string;
};

export const FOCUS_SOUND_TRACKS: readonly FocusTrack[] = [
  {
    id: BundledFocusTrack.Calm,
    title: "Aurora on Mute",
    category: FocusSoundCategory.AmbientLofi,
    categoryLabel: "Ambient lo-fi",
    src: "/audio/lofi/aurora-on-mute.mp3",
  },
  {
    id: BundledFocusTrack.Chillhop,
    title: "Porchlight Golden Hour",
    category: FocusSoundCategory.Chillhop,
    categoryLabel: "Chillhop",
    src: "/audio/lofi/porchlight-golden-hour.mp3",
  },
  {
    id: BundledFocusTrack.Jazzhop,
    title: "Breezy Afternoon Terrace",
    category: FocusSoundCategory.Jazzhop,
    categoryLabel: "Jazz hop",
    src: "/audio/lofi/breezy-afternoon-terrace.mp3",
  },
  {
    id: BundledFocusTrack.SoulRnb,
    title: "Barefoot in the Kitchen",
    category: FocusSoundCategory.SoulRnb,
    categoryLabel: "Soul / R&B",
    src: "/audio/lofi/barefoot-in-the-kitchen.mp3",
  },
  {
    id: BundledFocusTrack.LateNight,
    title: "3 AM Echoes",
    category: FocusSoundCategory.LateNight,
    categoryLabel: "Late night",
    src: "/audio/lofi/3-am-echoes.mp3",
  },
  {
    id: BundledFocusTrack.FunkSoul,
    title: "Burnt Sunset Groove",
    category: FocusSoundCategory.FunkSoul,
    categoryLabel: "Funk / soul",
    src: "/audio/lofi/burnt-sunset-groove.mp3",
  },
  {
    id: BundledFocusTrack.Asian,
    title: "Lanterns in Slow Motion",
    category: FocusSoundCategory.AsianLofi,
    categoryLabel: "Asian lo-fi",
    src: "/audio/lofi/lanterns-in-slow-motion.mp3",
  },
  {
    id: BundledFocusTrack.Seasonal,
    title: "After School Rain",
    category: FocusSoundCategory.SeasonalWeather,
    categoryLabel: "Seasonal / weather",
    src: "/audio/lofi/after-school-rain.mp3",
  },
  {
    id: BundledFocusTrack.Activities,
    title: "Chapter By Lamplight",
    category: FocusSoundCategory.Activities,
    categoryLabel: "Activities",
    src: "/audio/lofi/chapter-by-lamplight.mp3",
  },
  {
    id: BundledFocusTrack.Hybrid,
    title: "Cafe Da Tarde",
    category: FocusSoundCategory.Hybrid,
    categoryLabel: "Hybrid / world",
    src: "/audio/lofi/cafe-da-tarde.mp3",
  },
];

/** Each Focus-sound value → its bundled CC0 asset (null = silent). Files live
 * under public/audio/ with a LICENSE note. Derived from FOCUS_SOUND_TRACKS so
 * the picker, the player and this map can never drift. Streaming the full
 * catalog is a future release (#61) — not here. */
export const FOCUS_SOUND_SRC: Record<string, string | null> = {
  [FocusSound.Off]: null,
  ...Object.fromEntries(FOCUS_SOUND_TRACKS.map((t) => [t.id, t.src])),
};

// ── Pure playlist helpers (unit-tested; no DOM) ────────────────────────────────

/** The track for a FocusSound value, or undefined for "off"/unknown. */
export function focusTrackById(id: string): FocusTrack | undefined {
  return FOCUS_SOUND_TRACKS.find((t) => t.id === id);
}

/** Index of a track id in the playlist, or -1 if it isn't a real track. */
export function focusTrackIndex(id: string): number {
  return FOCUS_SOUND_TRACKS.findIndex((t) => t.id === id);
}

/** Next track id in the playlist, wrapping around; falls back to the first
 * track when the current id isn't a real track (e.g. "off"). Returns "" when
 * the playlist is empty. */
export function nextFocusTrackId(id: string): string {
  if (FOCUS_SOUND_TRACKS.length === 0) return "";
  const i = focusTrackIndex(id);
  if (i < 0) return FOCUS_SOUND_TRACKS[0].id;
  return FOCUS_SOUND_TRACKS[(i + 1) % FOCUS_SOUND_TRACKS.length].id;
}

/** Previous track id in the playlist, wrapping around; falls back to the last
 * track when the current id isn't a real track. Returns "" when empty. */
export function prevFocusTrackId(id: string): string {
  const n = FOCUS_SOUND_TRACKS.length;
  if (n === 0) return "";
  const i = focusTrackIndex(id);
  if (i < 0) return FOCUS_SOUND_TRACKS[n - 1].id;
  return FOCUS_SOUND_TRACKS[(i - 1 + n) % n].id;
}

// ── Category playlists (#70) ──────────────────────────────────────────────────
// One category of the catalog = one playlist. Everything here is pure and takes
// the track list as an argument rather than reading FOCUS_SOUND_TRACKS, because
// the list the player actually walks is the MERGED one (bundled + streamed, see
// mergeFocusTracks) and the whole point of a category is to narrow it.

/**
 * Fewest tracks a category needs before the picker offers it as a playlist.
 *
 * This constant is the answer to the question that had #70 blocked on #61: with
 * no `FOCUS_CATALOG_ORIGIN` configured the app has #43's bundled ten, **one per
 * category**, so every category would resolve to a single track — and the issue's
 * own words for that are "picking a category would just be picking a single
 * track, which is what we already have". Two is therefore the floor at which a
 * category becomes a different thing from a track.
 *
 * It is a floor on OFFERING, not on honouring: see {@link resolveFocusPool}.
 *
 * Deriving it from the data rather than from the env var is deliberate. The
 * origin is server-only configuration (`focus-catalog-source.ts`), the client has
 * no business knowing whether it is set, and a data-derived rule self-enables the
 * moment a manifest arrives and self-disables if it stops answering — with no
 * second flag to drift out of step with the first.
 */
export const MIN_CATEGORY_PLAYLIST_TRACKS = 2;

/** A category the picker can offer, with the size that qualified it. */
export type FocusPlaylistCategory = {
  slug: string;
  label: string;
  count: number;
};

/** Every track of one category, in the list's own order. */
export function tracksInCategory(
  tracks: readonly FocusTrack[],
  category: string,
): FocusTrack[] {
  return tracks.filter((t) => t.category === category);
}

/**
 * Index of a track id inside an ARBITRARY list, or -1.
 *
 * `focusTrackIndex` searches FOCUS_SOUND_TRACKS, which is the wrong array once a
 * category has narrowed the playlist: the chillhop track is index 1 there and
 * index 0 in a chillhop-only list. Handing the second number to a play order
 * built over the first is how a player ends up displaying one track while the
 * element plays another.
 */
export function trackIndexIn(
  tracks: readonly FocusTrack[],
  id: string,
): number {
  return tracks.findIndex((t) => t.id === id);
}

/**
 * The categories worth offering as playlists, in first-appearance order.
 *
 * First-appearance rather than alphabetical because the merged list puts the
 * bundled ten first (an invariant `mergeFocusTracks` keeps for the player's
 * sake), so the picker reads in the same order as the track list underneath it,
 * and a category only the store knows about lands at the end instead of jumping
 * into the middle.
 *
 * The label comes off the first track of the category, which is where
 * `categoryLabel()` (focus-catalog.ts) has already applied its precedence — the
 * app's own wording wins over the manifest's, and an unknown slug is humanised.
 * Reading it here rather than re-deriving it is what stops one category being
 * spelled two ways in one list.
 */
export function focusPlaylistCategories(
  tracks: readonly FocusTrack[],
  min: number = MIN_CATEGORY_PLAYLIST_TRACKS,
): FocusPlaylistCategory[] {
  const byCategory = new Map<string, FocusPlaylistCategory>();
  for (const track of tracks) {
    if (!track.category) continue; // a manifest entry with no category at all
    const seen = byCategory.get(track.category);
    if (seen) {
      seen.count += 1;
      continue;
    }
    byCategory.set(track.category, {
      slug: track.category,
      label: track.categoryLabel || track.category,
      count: 1,
    });
  }
  return [...byCategory.values()].filter((c) => c.count >= min);
}

/**
 * The categories a PICKER may offer — {@link focusPlaylistCategories}, minus any
 * the database would refuse.
 *
 * `Settings.focusSoundCategories` is CHECK-constrained to `FocusSoundCategory`
 * (by containment, #180), so a self-hoster whose manifest declares its own
 * category gets tracks that play (they are in the merged list, and they group)
 * but a slug that cannot be SAVED. Offering it would be a control that silently
 * does not stick, which is worse than not offering it — the server action drops
 * the unknown slug and the control would spring back on the next load with no
 * explanation.
 *
 * Widening the constraint to accept arbitrary manifest slugs is the alternative,
 * and it was declined: a CHECK constraint over an open set is no constraint, and
 * `enum-constraint-sync` would have nothing to mirror.
 *
 * #180 moved the picker itself off the Settings page; this stays because the
 * in-session player (#181) asks the same question of the same data.
 */
export function offerableFocusCategories(
  tracks: readonly FocusTrack[],
  min: number = MIN_CATEGORY_PLAYLIST_TRACKS,
): FocusPlaylistCategory[] {
  const persistable = new Set<string>(Object.values(FocusSoundCategory));
  return focusPlaylistCategories(tracks, min).filter((c) =>
    persistable.has(c.slug),
  );
}

/**
 * The categories the in-session PICKER lists — {@link offerableFocusCategories},
 * widened by whatever is already selected (#181).
 *
 * The floor exists so a one-track category is not offered as a "playlist", and
 * that is still right for a category nobody has chosen. It is wrong for one that
 * IS chosen, and not as an edge case: every new row is created with
 * `focusSoundCategories: ["ambient-lofi"]`, and the default install is #43's
 * bundled ten — one track per category, so nothing clears the floor. A picker
 * built on `offerableFocusCategories` alone would therefore open, out of the box,
 * showing a single unticked "All tracks" row while the session was really playing
 * one category: precisely the "nothing is ticked and you cannot tell what will
 * play" state #181 exists to rule out, and with no control on screen to leave it.
 *
 * So: offer at the floor, and always show what is switched on. The count is the
 * category's REAL size, including below the floor — "(1)" is the honest answer to
 * "what am I picking?" and is the number that makes the floor's reasoning visible
 * rather than hidden behind an absent row.
 *
 * A selected slug the catalogue does not carry gets NO row, deliberately. A "(0)"
 * would be a lie about what plays: {@link resolveFocusPool} widens a selection
 * that matches nothing back to the whole catalogue, so the honest rendering is no
 * row at all and a ticked "All tracks" — see {@link poolIsWholeCatalogue}.
 *
 * The persistable filter survives the widening, for the reason
 * `offerableFocusCategories` gives: a slug outside `FocusSoundCategory` cannot be
 * stored, so a control for it would silently not stick. The CHECK constraint
 * means such a slug cannot really BE selected, but this takes the selection as an
 * argument and must not depend on its caller having checked.
 */
export function pickerFocusCategories(
  tracks: readonly FocusTrack[],
  selected: readonly string[] | null | undefined,
  min: number = MIN_CATEGORY_PLAYLIST_TRACKS,
): FocusPlaylistCategory[] {
  const persistable = new Set<string>(Object.values(FocusSoundCategory));
  const chosen = new Set(selected ?? []);
  // One pass over the catalogue (min = 1 counts everything), then a filter over
  // the ten-ish categories it found — not a second pass over the manifest.
  return focusPlaylistCategories(tracks, 1).filter(
    (c) => persistable.has(c.slug) && (c.count >= min || chosen.has(c.slug)),
  );
}

/**
 * Does this selection narrow anything at all? (#181)
 *
 * The "All tracks" row's ticked state, and it has to be true in all three cases
 * where the whole catalogue is what plays: nothing selected, a selection that
 * matches nothing (which {@link resolveFocusPool} widens rather than let the
 * session go silent), and a selection that happens to name every category there
 * is. Comparing the pool's IDENTITY to the catalogue would get the first two and
 * miss the third, because the filter builds a new array; the length is exact,
 * since the pool is always a subset.
 *
 * #185 — it takes the custom-playlist half as well, and has to: derived from the
 * categories alone, ticking a playlist would narrow what plays while "All
 * tracks" stayed ticked, which is the picker saying one thing and the speakers
 * doing another.
 */
export function poolIsWholeCatalogue(
  tracks: readonly FocusTrack[],
  categories: readonly string[] | null | undefined,
  playlistTrackIds?: readonly string[] | null,
): boolean {
  return (
    resolveFocusPool(tracks, categories, playlistTrackIds).length ===
    tracks.length
  );
}

/** One category heading in the player's jump-list, with the tracks under it. */
export type FocusTrackGroup = {
  slug: string;
  label: string;
  tracks: FocusTrack[];
};

/**
 * The pool, split under category headings in first-appearance order (#181).
 *
 * Headings rather than a flat list because 166 titles in one uninterrupted run
 * loses which playlist a track came from, and because they give a screen reader
 * structure to move between. First-appearance order for the same reason
 * {@link focusPlaylistCategories} uses it: the list then reads in the same order
 * as the tick-list above it.
 *
 * A track whose manifest gave it no category is KEPT, under a humanised heading
 * of its own. `parseCatalog` stores `""` for that and still plays the track, so
 * dropping it here would leave a track that plays and cannot be jumped to.
 */
export function groupTracksByCategory(
  tracks: readonly FocusTrack[],
): FocusTrackGroup[] {
  const groups = new Map<string, FocusTrackGroup>();
  for (const track of tracks) {
    const existing = groups.get(track.category);
    if (existing) {
      existing.tracks.push(track);
      continue;
    }
    groups.set(track.category, {
      slug: track.category,
      // Same precedence as focusPlaylistCategories: the label already on the
      // track, then the slug, then a last-resort word for the uncategorised —
      // an empty heading is not a heading.
      label: track.categoryLabel || track.category || UNCATEGORISED_LABEL,
      tracks: [track],
    });
  }
  return [...groups.values()];
}

/** Heading for tracks whose manifest declared no category at all. Matches
 * `focus-catalog.ts`'s own fallback for an unnameable slug. */
const UNCATEGORISED_LABEL = "Other";

/**
 * The pool a session draws from, given the categories stored in
 * `Settings.focusSoundCategories`.
 *
 * #180 — this took one nullable slug until the column became an array. The union
 * is built by FILTERING the catalogue rather than by concatenating a slice per
 * category, and that is the behavioural difference rather than a style one: the
 * player's in-order pass walks this list, so a concatenation would group it by
 * category and sound like three short playlists played back to back. Filtering
 * keeps catalogue order whatever order the categories were ticked in, and makes
 * a repeated slug impossible to hear.
 *
 * All three of #70's fallbacks are kept, because each one exists to stop a focus
 * session going silent:
 *
 * 1. **Nothing selected** — the whole catalogue, returned as `tracks` ITSELF,
 *    same identity. `useFocusSound` re-deals its play order when the list
 *    changes, so "the whole catalogue" must not look like a change (the same
 *    reason `mergeFocusTracks` returns the bundled array when the catalog added
 *    nothing). The empty array is what the column stores for this; `null` and
 *    `undefined` are accepted because the prop is optional on the way down.
 * 2. **A selection that has shrunk to one track** — honoured, not widened. A
 *    selection made while the store was reachable must not silently change genre
 *    when it stops answering: one chillhop track is what the user asked for, all
 *    ten categories is not. So the {@link MIN_CATEGORY_PLAYLIST_TRACKS} floor
 *    governs what a picker OFFERS and deliberately not what this honours.
 * 3. **A selection that matches nothing at all** — falls back to the whole list.
 *    A retired slug, or a manifest that no longer carries the category, must
 *    never leave a focus session with an empty playlist and therefore silent.
 *
 * A category that is merely absent from a selection that also names a live one
 * contributes nothing and does NOT trigger case 3: the live half is still
 * exactly what was asked for.
 *
 * ── #185: the second half of the union ──────────────────────────────────────
 *
 * `playlistTrackIds` is the flattened selection of the workspace's own named
 * playlists (`selectedPlaylistTrackIds` in focus-playlists.ts), and it joins the
 * categories by widening the SAME filter rather than by appending a second list.
 * That is the same behavioural argument #180 made one level up: appending would
 * play the categories and then the playlist as two audible blocks, and a track
 * that is in both would be heard twice in one pass. Filtering keeps one
 * catalogue-ordered pool in which every track appears exactly once, whichever
 * half — or both — put it there.
 *
 * It also gives "unknown track ids are filtered at resolution time" for free,
 * which is the promise made in place of a CHECK constraint the column cannot
 * have: an id no catalogue entry carries matches nothing and therefore
 * contributes nothing. All three fallbacks above read the two halves together —
 * "nothing selected" means neither half selected anything, and a playlist whose
 * every id has left the manifest is case 3, not a silent session.
 */
export function resolveFocusPool(
  tracks: readonly FocusTrack[],
  categories: readonly string[] | null | undefined,
  playlistTrackIds?: readonly string[] | null,
): readonly FocusTrack[] {
  const noCategories = !categories || categories.length === 0;
  const noTrackIds = !playlistTrackIds || playlistTrackIds.length === 0;
  if (noCategories && noTrackIds) return tracks;
  const selected = new Set(categories ?? []);
  const selectedIds = new Set(playlistTrackIds ?? []);
  const pool = tracks.filter(
    (t) => selected.has(t.category) || selectedIds.has(t.id),
  );
  return pool.length > 0 ? pool : tracks;
}

/** Clamp a volume to the [0, 1] range the <audio> element accepts. */
export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

// ── Play order (#68) ──────────────────────────────────────────────────────────
// The player consumes a "pass": an array of track indices, head→tail, and only
// wraps once the pass is exhausted. That is what guarantees no track repeats
// mid-pass — including in shuffle, which shuffles a COPY of the order up front
// rather than picking at random on each advance (random-per-advance can play the
// same track twice in a row, which is the complaint #68 exists to fix).

/**
 * Fisher–Yates shuffle of a COPY of `indices` (the input is never mutated).
 * `rng` is injectable so tests get a deterministic order; it must return a
 * number in [0, 1) like Math.random.
 */
export function shuffleIndices(
  indices: readonly number[],
  rng: () => number = Math.random,
): number[] {
  const out = [...indices];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Build a pass over `length` tracks: `[0..length-1]` in order, or a full
 * permutation of it when `shuffle` is set. Both forms contain every track
 * exactly once.
 *
 * - `startAt` — deal this track to the head of a shuffled pass, so toggling
 *   shuffle (or starting a session) never interrupts what is already playing.
 *   Ignored when out of range, and irrelevant in order (the cursor, not the
 *   order, says where an in-order pass is being read from).
 * - `avoidFirst` — keep this track OFF the head. Used when a shuffled pass is
 *   re-dealt on exhaustion: the track that just finished must not immediately
 *   play again. Ignored for a single-track playlist (nothing else to play).
 */
export function buildPlayOrder(
  length: number,
  opts: {
    shuffle?: boolean;
    startAt?: number;
    avoidFirst?: number;
    rng?: () => number;
  } = {},
): number[] {
  if (length <= 0) return [];
  const inOrder = Array.from({ length }, (_, i) => i);
  if (!opts.shuffle) return inOrder;

  const rng = opts.rng ?? Math.random;
  const order = shuffleIndices(inOrder, rng);
  const { startAt, avoidFirst } = opts;
  const inRange = (i: number | undefined): i is number =>
    i != null && Number.isInteger(i) && i >= 0 && i < length;

  if (inRange(startAt)) {
    // Swap the requested track into the head — still a permutation.
    const at = order.indexOf(startAt);
    [order[0], order[at]] = [order[at], order[0]];
  } else if (inRange(avoidFirst) && length > 1 && order[0] === avoidFirst) {
    const j = 1 + Math.floor(rng() * (length - 1));
    [order[0], order[j]] = [order[j], order[0]];
  }
  return order;
}

/** Where a track index sits in a pass; the head (0) when it isn't in there. */
export function playOrderCursor(
  order: readonly number[],
  index: number,
): number {
  const at = order.indexOf(index);
  return at < 0 ? 0 : at;
}

const ALARM_SRC = "/audio/alarm.wav";

export type Alarm = { play(): void };
export type PlaylistPlayer = {
  play(): void;
  pause(): void;
  stop(): void;
  /** Set output volume (0..1, clamped). */
  setVolume(v: number): void;
  /** Swap the source; resumes automatically if currently playing. */
  load(src: string): void;
  /** Current playback position + track length (seconds); 0s where unknown. */
  getTime(): { currentTime: number; duration: number };
};
export type PreviewPlayer = {
  /** Play a one-shot (non-looping) preview; stops any previous preview first. */
  play(src: string, onEnded?: () => void): void;
  stop(): void;
};
export type WakeGuard = { release(): void };

// Nothing here loops an element any more (#68): the background player advances
// its playlist on `ended` instead, and the alarm/preview are one-shots.
function makeAudio(src: string): HTMLAudioElement | null {
  try {
    if (typeof Audio === "undefined") return null;
    const a = new Audio(src);
    a.loop = false;
    return a;
  } catch {
    return null;
  }
}

/** One-shot alarm — call play() at time's-up; also vibrates on mobile. */
export function createAlarm(): Alarm {
  const audio = makeAudio(ALARM_SRC);
  return {
    play() {
      try {
        if (audio) {
          audio.currentTime = 0;
          void audio.play().catch(() => {});
        }
      } catch {
        /* ignore playback errors */
      }
      try {
        navigator.vibrate?.([200, 100, 200]);
      } catch {
        /* vibrate unsupported */
      }
    },
  };
}

/**
 * Background player for one shared element. Supports live volume changes and
 * swapping the source (the mini-player's next/prev, and the playlist's own
 * auto-advance) without losing the play/pause state.
 *
 * #68 — the element deliberately does NOT loop: a looping single source is what
 * made the focus music repeat the same track forever. When a track finishes we
 * report it via `onEnded` and the caller (useFocusSound) loads the next one, so
 * "what plays next" belongs to the playlist rather than to the element.
 */
export function createPlaylistPlayer(
  src: string,
  opts: { volume?: number; onEnded?: () => void } = {},
): PlaylistPlayer {
  const audio = makeAudio(src);
  if (audio && opts.volume != null) audio.volume = clampVolume(opts.volume);
  // Assigned once, on the element we keep for the whole session — load() swaps
  // only `src`, so the handler survives every track change.
  if (audio) audio.onended = opts.onEnded ?? null;
  let playing = false;
  return {
    play() {
      playing = true;
      try {
        void audio?.play().catch(() => {});
      } catch {
        /* ignore */
      }
    },
    pause() {
      playing = false;
      try {
        audio?.pause();
      } catch {
        /* ignore */
      }
    },
    stop() {
      playing = false;
      try {
        if (audio) {
          audio.pause();
          audio.currentTime = 0;
        }
      } catch {
        /* ignore */
      }
    },
    setVolume(v: number) {
      try {
        if (audio) audio.volume = clampVolume(v);
      } catch {
        /* ignore */
      }
    },
    load(nextSrc: string) {
      try {
        if (!audio) return;
        audio.src = nextSrc;
        audio.currentTime = 0;
        if (playing) void audio.play().catch(() => {});
      } catch {
        /* ignore */
      }
    },
    getTime() {
      try {
        if (!audio) return { currentTime: 0, duration: 0 };
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        const currentTime = Number.isFinite(audio.currentTime)
          ? audio.currentTime
          : 0;
        return { currentTime, duration };
      } catch {
        return { currentTime: 0, duration: 0 };
      }
    },
  };
}

/** One shared, non-looping preview player for the settings picker: starting a
 * new preview stops the previous one, so only one auditions at a time. */
export function createPreviewPlayer(): PreviewPlayer {
  let audio: HTMLAudioElement | null = null;
  return {
    play(src: string, onEnded?: () => void) {
      try {
        if (!audio) audio = makeAudio(src);
        if (!audio) return;
        audio.pause();
        audio.src = src;
        audio.currentTime = 0;
        audio.onended = onEnded ?? null;
        void audio.play().catch(() => {});
      } catch {
        /* ignore */
      }
    },
    stop() {
      try {
        if (audio) {
          audio.pause();
          audio.currentTime = 0;
          audio.onended = null;
        }
      } catch {
        /* ignore */
      }
    },
  };
}

type WakeLockLike = {
  request(type: "screen"): Promise<{ release(): Promise<void> }>;
};

/** Acquire a screen wake lock; returns a release handle (a no-op guard where
 * the Wake Lock API is unsupported). */
export async function acquireWakeLock(): Promise<WakeGuard> {
  try {
    const wl = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!wl) return { release() {} };
    const sentinel = await wl.request("screen");
    return {
      release() {
        void sentinel.release().catch(() => {});
      },
    };
  } catch {
    return { release() {} };
  }
}
