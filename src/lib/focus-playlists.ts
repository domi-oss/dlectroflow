/**
 * #185 — the pure half of "build and edit your own named playlists".
 *
 * A custom playlist is a **flat list of track ids** with a name. Adding a
 * category copies its tracks in AT ADD TIME and stores nothing about the
 * category, so a catalogue that later grows cannot silently change what a saved
 * playlist plays. Everything here is therefore string-list arithmetic over ids,
 * with the catalogue supplied as an argument — the same shape the category
 * helpers in `focus-sounds.ts` take, and for the same reason: the list the
 * player walks is the MERGED one (bundled + streamed), which this module has no
 * business fetching.
 *
 * The bounds below are the module's other job. `FocusPlaylist.trackIds` is
 * deliberately NOT check-constrained against the catalogue (ids vary per
 * instance — a self-hoster with no `FOCUS_CATALOG_ORIGIN` has a different set),
 * so an id's *validity* cannot be enforced anywhere. Its *size* can, and has to
 * be: every one of these values arrives from a client-callable server action.
 */

import type { FocusTrack } from "@/lib/focus-sounds";

/**
 * Longest playlist name, in CHARACTERS.
 *
 * 60 is where a name stops being a label. It is read out whole in three
 * accessible names ("Edit Deep work", "Delete Deep work", the tick-list row) and
 * shown in a capped-height panel row that already carries a count and a button,
 * so anything longer is truncated on screen and unlistenable in a screen reader
 * — the two places the name is the only thing telling one playlist from another.
 *
 * Mirrored by `FocusPlaylist_name_check` (see the migration), which measures
 * with `char_length` for the same reason {@link normaliseFocusPlaylistName}
 * counts code points: `octet_length` differs by up to 4x on astral characters,
 * so a byte bound would reject an all-emoji name a quarter the length of a Latin
 * one it accepts.
 */
export const FOCUS_PLAYLIST_NAME_MAX_LENGTH = 60;

/**
 * Most playlists one workspace may hold.
 *
 * Two reasons, and the second is the load-bearing one. They render as rows in a
 * `max-h-64` scroller inside a timer panel, so a hundred of them is not a
 * feature. And `createFocusPlaylist` is an authenticated, client-callable write
 * with no other rate limit in front of it — an unbounded row count per workspace
 * is storage exhaustion available to anyone with a session, including a guest.
 * 50 is far above any plausible use ("Deep work", "Admin Monday", "Late shift"
 * is the issue's own example, and it lists three).
 */
export const MAX_FOCUS_PLAYLISTS = 50;

/**
 * Most track ids one playlist may hold.
 *
 * The honest use is bounded by the catalogue — the full open-lofi manifest is
 * ~166 tracks and adding every category would still fit — but the COLUMN is not,
 * because unknown ids are legal by design. Without a cap, one action call can
 * write an arbitrarily large `text[]`. 500 leaves room for a catalogue three
 * times today's size.
 */
export const MAX_FOCUS_PLAYLIST_TRACKS = 500;

/**
 * Longest single track id.
 *
 * Streamed ids are `catalog:<filename>` (`focus-catalog.ts`), so 200 characters
 * is a filename bound with room to spare. It exists so the cap above is a real
 * size bound rather than a count of unbounded strings.
 */
export const MAX_FOCUS_TRACK_ID_LENGTH = 200;

/** Why a name was refused, so the field can say which rule it broke. */
export type FocusPlaylistNameError = "empty" | "too-long";

/** The shape every surface here needs of a stored playlist. Deliberately not
 * the Prisma row: `createdAt` and `workspaceId` are nobody's business up here,
 * and taking a structural type keeps this module testable without a database. */
export type FocusPlaylistSummary = {
  id: string;
  name: string;
  trackIds: readonly string[];
};

/** Code points, not UTF-16 units: `"🎧".length` is 2, and a bound that counted
 * that way would reject an emoji name half the length of the Latin one beside
 * it. Matches `char_length` in Postgres. */
function characterCount(value: string): number {
  return [...value].length;
}

/**
 * The stored form of a name: trimmed, internal whitespace runs collapsed to one
 * space, or `null` if that leaves nothing or overruns the bound.
 *
 * Collapsing BEFORE measuring is deliberate — padding a name should not cost the
 * user characters they can see. Collapsing at all is what stops `"Deep  work"`
 * and `"Deep work"` being two visually identical rows, which is the same
 * ambiguity the uniqueness rule exists to prevent (see
 * `src/app/actions/focus-playlists.ts`).
 */
export function normaliseFocusPlaylistName(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return null;
  if (characterCount(collapsed) > FOCUS_PLAYLIST_NAME_MAX_LENGTH) return null;
  return collapsed;
}

/**
 * Which refusal {@link normaliseFocusPlaylistName} would give, or `null` if it
 * would accept.
 *
 * Separate from the normaliser because the UI has to say WHY — "an empty or
 * whitespace-only name must be refused visibly, not silently" (#185) — and a
 * lone `null` cannot tell "you typed nothing" from "that is too long".
 */
export function focusPlaylistNameError(
  raw: string,
): FocusPlaylistNameError | null {
  if (raw.trim().length === 0) return "empty";
  if (normaliseFocusPlaylistName(raw) === null) return "too-long";
  return null;
}

/**
 * The stored form of a track-id list: strings only, no blanks, no duplicates,
 * first-seen order, capped.
 *
 * `unknown[]` rather than `string[]` on purpose. This runs on a server-action
 * payload, which is whatever reached the wire — the Prisma types stop nothing
 * there, and a non-string element in a `text[]` write is a runtime error rather
 * than a rejected value.
 *
 * Ids are NOT trimmed: a name is something a person typed and a track id is
 * data, so trimming one would silently rewrite a catalogue key that legitimately
 * contains a space. A blank-only id is dropped instead, which is the one case
 * that can only be junk.
 */
export function normaliseFocusTrackIds(ids: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string") continue;
    if (id.trim().length === 0) continue;
    if (characterCount(id) > MAX_FOCUS_TRACK_ID_LENGTH) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_FOCUS_PLAYLIST_TRACKS) break;
  }
  return out;
}

/**
 * Append `incoming` to `existing`, dropping anything already present.
 *
 * This is what "adding a category" does — up to 21 ids at once — so collapsing
 * duplicates is the difference between adding a category twice being a no-op and
 * it doubling every track in the playlist.
 *
 * Returns `existing` ITSELF when nothing new arrived, so a caller holding the
 * array as React state can compare identities to decide whether to re-render or
 * to announce. A fresh equal array would make every re-add look like a change.
 */
export function addFocusPlaylistTracks(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  const merged = normaliseFocusTrackIds([...existing, ...incoming]);
  const base = existing as string[];
  return merged.length === existing.length ? base : merged;
}

/** Remove every named id, keeping the rest in order. Returns `existing` itself
 * when nothing matched — same identity contract as
 * {@link addFocusPlaylistTracks}, for the same reason. */
export function removeFocusPlaylistTracks(
  existing: readonly string[],
  remove: readonly string[],
): string[] {
  const drop = new Set(remove);
  const kept = existing.filter((id) => !drop.has(id));
  return kept.length === existing.length ? (existing as string[]) : kept;
}

/**
 * The track ids a selection of custom playlists resolves to, de-duplicated
 * across them.
 *
 * A selected id no playlist carries contributes nothing rather than throwing:
 * `Settings.focusPlaylistIds` is a scalar list with no foreign key, so a
 * playlist deleted in another tab leaves exactly this state until the delete's
 * own clean-up catches up.
 */
export function selectedPlaylistTrackIds(
  playlists: readonly FocusPlaylistSummary[],
  selected: readonly string[] | null | undefined,
): string[] {
  if (!selected || selected.length === 0) return [];
  const chosen = new Set(selected);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of playlists) {
    if (!chosen.has(p.id)) continue;
    for (const id of p.trackIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * A playlist's tracks, resolved against this instance's catalogue, **in the
 * playlist's own order** and with unknown ids dropped.
 *
 * Playlist order, not catalogue order, and the two callers are why: the builder
 * shows the list the user assembled, and the tick-list counts it. The POOL is a
 * different question with a different answer — `resolveFocusPool` filters the
 * catalogue, so what plays stays in catalogue order however the playlist was
 * built (see its own note on why concatenation would sound wrong).
 *
 * Dropping unknown ids here is the "filter at resolution time" half of the
 * decision not to CHECK-constrain the column. It is the same treatment an absent
 * category already gets.
 */
export function focusPlaylistTracks(
  catalog: readonly FocusTrack[],
  trackIds: readonly string[],
): FocusTrack[] {
  if (trackIds.length === 0) return [];
  const byId = new Map(catalog.map((t) => [t.id, t]));
  const out: FocusTrack[] = [];
  for (const id of trackIds) {
    const track = byId.get(id);
    if (track) out.push(track);
  }
  return out;
}
