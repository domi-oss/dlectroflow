/**
 * #61 — the streamed lo-fi catalog, as pure functions.
 *
 * #43 bundles ten CC0 tracks (one per open-lofi category) in `public/audio/lofi/`.
 * The full open-lofi set is 166 tracks / ~544 MB, which is too much to vendor into
 * the runtime image, so the rest is read from an object store at run time and the
 * app's own origin is what the browser talks to.
 *
 * ── Why the player never sees the store's URL ────────────────────────────────
 *
 * `next.config.ts` sets `default-src 'self'` with `media-src`, `frame-src` and
 * `child-src` deliberately unset, so the browser refuses third-party audio. That
 * is a privacy property of the focus session — a long, personal, unattended page
 * view — and `src/lib/security-headers.test.ts` fails on any relaxation of it.
 *
 * So every `src` this module produces is a same-origin path into
 * `/api/focus-catalog/audio`, which fetches the bytes server-side and streams
 * them back (`src/app/api/focus-catalog/audio/route.ts`). Pointing an `<audio>`
 * element at `https://<store-host>/…` would need a `media-src` origin and is
 * explicitly out of scope for #61. Any store credential stays server-side for the
 * same reason, which the proxy shape gives for free.
 *
 * ── Kept free of `fs`, `fetch` and `process.env` ─────────────────────────────
 *
 * The same split the hygiene modules use: parsing and URL building are unit
 * testable on synthetic input here, and `focus-catalog-source.ts` does the I/O.
 * Both the route handlers and the client hook import from this file, so it must
 * stay safe to pull into a browser bundle.
 */

import { FOCUS_SOUND_TRACKS, type FocusTrack } from "@/lib/focus-sounds";

/** Where the picker/playlist reads the catalog from. Same-origin, by design. */
export const CATALOG_INDEX_PATH = "/api/focus-catalog";

/**
 * Where a single streamed track is read from.
 *
 * The track name is a QUERY parameter rather than a path segment on purpose:
 * `src/proxy.ts`'s matcher excludes any path ending in an extension
 * (`.*\.\w+$`), so `/api/focus-catalog/audio/foo.mp3` would skip the middleware
 * — and with it the guest-session cookie the middleware mints, leaving every
 * guest unable to play a streamed track for reasons nothing in this file
 * explains.
 */
export const CATALOG_AUDIO_PATH = "/api/focus-catalog/audio";
export const CATALOG_TRACK_PARAM = "track";

/** The manifest's filename inside the configured base. open-lofi's own name. */
export const CATALOG_MANIFEST_FILE = "catalog.json";

/**
 * Prefix on a streamed track's `id`.
 *
 * A BUNDLED track's id is its `FocusSound` value, which is what
 * `Settings.focusSound` persists and what a Postgres CHECK constraint validates
 * (see `src/lib/constants.ts` and `enum-constraint-sync`). A streamed track has
 * no such value and therefore cannot be saved as a preference — the prefix makes
 * that visible at a glance rather than at the point a write fails. Giving the
 * catalog a persistable identity is #70's problem, not this one's.
 */
export const CATALOG_TRACK_ID_PREFIX = "catalog:";

/**
 * Most tracks one catalog response may introduce.
 *
 * The manifest comes from a store whose contents this app does not author, and
 * every entry becomes a row the client renders and an index the play order walks.
 * 500 leaves room for open-lofi's 166 plus a self-hoster's own set while keeping
 * a corrupt or hostile manifest from turning into an unbounded render.
 */
export const MAX_CATALOG_TRACKS = 500;

/** Longest title kept. Truncated rather than dropped — a long title is a
 *  cosmetic problem, and a playable track is the point. */
const MAX_TITLE_LENGTH = 120;

/** Longest filename accepted. Comfortably over open-lofi's longest. */
const MAX_FILENAME_LENGTH = 128;

/**
 * A single track as open-lofi's `catalog.json` writes it.
 * `{ title, filename, category }` — the shape #61 asked us to reuse.
 */
export interface CatalogCategory {
  slug: string;
  label: string;
}

/**
 * Filenames that cannot leave the configured base.
 *
 * Deliberately an allowlist of shapes rather than a blocklist of tricks: one
 * leading alphanumeric, then alphanumerics, dot, dash or underscore, ending in
 * `.mp3`. No slash, no backslash, no percent, no whitespace, no colon — so no
 * path segment, no scheme, no authority and no query can be smuggled through.
 * `..` is rejected explicitly as well, which the character class already covers,
 * because a reader should not have to derive that from the regex.
 */
export function isSafeCatalogFilename(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > MAX_FILENAME_LENGTH) return false;
  if (name.includes("..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.mp3$/i.test(name);
}

/**
 * Normalise the operator-configured catalog origin, or `null` if it is unusable.
 *
 * Returns a base that ALWAYS ends in `/`, so `${base}${name}` cannot swallow the
 * last path segment. Rejects, with the reason each matters:
 *
 * - a scheme other than `http`/`https` — `file:` would read the pod's disk;
 * - userinfo (`user:pass@host`) — a credential that would ride every proxied
 *   request, and a base whose host is ambiguous to read;
 * - a query or fragment — a pre-signed base cannot work anyway once a filename
 *   is appended after the `?`, and accepting one would silently serve 403s.
 *
 * Plain `http` IS accepted: the browser never sees this URL, so a self-hoster
 * pointing at an object store on the Compose network is not a transport
 * downgrade for anybody.
 */
export function resolveCatalogBase(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;

  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return `${url.origin}${path}`;
}

/**
 * The upstream URL for one track.
 *
 * `encodeURIComponent` is what keeps the appended value a single path segment:
 * `/`, `:`, `@`, `?` and `#` all become escapes, so nothing a caller passes can
 * re-open the authority or add a query. Callers should still reject the name
 * with {@link isSafeCatalogFilename} first — this is the second layer, not the
 * first.
 */
export function catalogFileUrl(base: string, filename: string): string {
  return `${base}${encodeURIComponent(filename)}`;
}

/** The manifest's upstream URL under the configured base. */
export function catalogIndexUrl(base: string): string {
  return `${base}${CATALOG_MANIFEST_FILE}`;
}

/** The same-origin `src` an `<audio>` element uses for a streamed track. */
export function catalogAudioSrc(filename: string): string {
  return `${CATALOG_AUDIO_PATH}?${CATALOG_TRACK_PARAM}=${encodeURIComponent(filename)}`;
}

/**
 * Category slug → the label already shown for the bundled track of that
 * category, so one list never spells the same category two ways.
 */
const BUNDLED_CATEGORY_LABELS: ReadonlyMap<string, string> = new Map(
  FOCUS_SOUND_TRACKS.map((track) => [track.category, track.categoryLabel]),
);

/** `wind-chimes` → `Wind chimes`. Sentence case, matching the bundled labels. */
function humaniseSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  if (!words) return "Other";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The label to show for a category.
 *
 * Precedence, and why: the app's own label wins so a streamed "Chillhop" track
 * does not sit under "Chillhop & Cozy Beats" next to the bundled one; then the
 * manifest's label, which is the only source for a category we do not bundle;
 * then a humanised slug, so an unknown category still reads as words.
 */
export function categoryLabel(
  slug: string,
  categories: readonly CatalogCategory[] = [],
): string {
  const bundled = BUNDLED_CATEGORY_LABELS.get(slug);
  if (bundled) return bundled;
  const declared = categories.find((c) => c?.slug === slug)?.label;
  if (typeof declared === "string" && declared.trim()) return declared.trim();
  return humaniseSlug(slug);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The declared categories of a manifest, ignoring anything malformed. */
function readCategories(raw: unknown): CatalogCategory[] {
  if (!isRecord(raw) || !Array.isArray(raw.categories)) return [];
  const out: CatalogCategory[] = [];
  for (const entry of raw.categories) {
    if (!isRecord(entry)) continue;
    const { slug, label } = entry;
    if (typeof slug !== "string" || typeof label !== "string") continue;
    out.push({ slug, label });
  }
  return out;
}

/** The track entries of a manifest — `{ tracks: [...] }` or a bare array. */
function readEntries(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw.tracks)) return raw.tracks;
  return [];
}

/**
 * Turn a parsed `catalog.json` into playable tracks, dropping whatever does not
 * survive validation.
 *
 * Lenient by design: a manifest is remote data, and one malformed entry is not a
 * reason to leave the user with no music. Never throws, so a caller can hand it
 * `JSON.parse` output without a second guard.
 */
export function parseCatalog(raw: unknown): FocusTrack[] {
  const categories = readCategories(raw);
  const tracks: FocusTrack[] = [];
  const seen = new Set<string>();

  for (const entry of readEntries(raw)) {
    if (tracks.length >= MAX_CATALOG_TRACKS) break;
    if (!isRecord(entry)) continue;

    const { title, filename, category } = entry;
    if (typeof filename !== "string" || !isSafeCatalogFilename(filename)) {
      continue;
    }
    if (seen.has(filename)) continue;
    if (typeof title !== "string") continue;
    const cleanTitle = title.trim().slice(0, MAX_TITLE_LENGTH);
    if (!cleanTitle) continue;

    const slug = typeof category === "string" ? category : "";
    seen.add(filename);
    tracks.push({
      id: `${CATALOG_TRACK_ID_PREFIX}${filename}`,
      title: cleanTitle,
      category: slug,
      categoryLabel: categoryLabel(slug, categories),
      src: catalogAudioSrc(filename),
    });
  }

  return tracks;
}

/** The filename a bundled track's `public/` path ends in. */
function bundledFilename(track: FocusTrack): string {
  return track.src.split("/").pop() ?? "";
}

/**
 * Bundled tracks first, then whatever the catalog adds.
 *
 * Two invariants the player depends on:
 *
 * 1. **Bundled tracks keep their indices.** `useFocusSound` addresses tracks by
 *    index and seeds from `Settings.focusSound`, so growing the list must not
 *    renumber what is already playing.
 * 2. **Nothing is listed twice.** The bundled ten come from this same catalog, so
 *    the manifest lists them too; the local copy wins because it needs no round
 *    trip and still plays when the store is unreachable.
 *
 * Returns the bundled array ITSELF when there is nothing to add — the hook
 * re-deals its play order when the track list changes, and "the catalog was
 * empty" must not look like a change.
 */
export function mergeFocusTracks(
  bundled: readonly FocusTrack[],
  catalog: readonly FocusTrack[],
): readonly FocusTrack[] {
  const have = new Set(bundled.map(bundledFilename));
  const additions = catalog.filter((track) => {
    const filename = track.id.startsWith(CATALOG_TRACK_ID_PREFIX)
      ? track.id.slice(CATALOG_TRACK_ID_PREFIX.length)
      : bundledFilename(track);
    if (have.has(filename)) return false;
    have.add(filename);
    return true;
  });
  if (additions.length === 0) return bundled;
  return [...bundled, ...additions];
}
