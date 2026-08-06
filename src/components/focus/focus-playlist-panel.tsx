"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown, ChevronUp, ListMusic } from "lucide-react";
import {
  groupTracksByCategory,
  pickerFocusCategories,
  poolIsWholeCatalogue,
  type FocusTrackGroup,
} from "@/lib/focus-sounds";
import { t, type Voice } from "@/lib/strings";
import { cn } from "@/lib/utils";
import type { FocusSoundControls } from "@/lib/use-focus-sound";

/**
 * #181 — "what am I listening to", answered in one place: which playlists the
 * session draws from, and which track plays right now.
 *
 * ## Shape
 *
 * One disclosure, collapsed by default, opening INLINE below the mini-player's
 * progress bar at a capped height with its own scroll. Chosen over a floating
 * popover (which would cover the timer's number, the one thing that screen is
 * for) and over a slide-out drawer (too big a gesture for a page designed not to
 * grab attention). The timer's whole design is one number and one action, so
 * nothing here may compete with that: collapsed, it is a single quiet button.
 *
 * ## Accessibility
 *
 * This project produced three mangled accessible-name bugs in one day, all from
 * assuming visible arrangement equals announced text. The specific answers here:
 *
 *  * A real disclosure — `aria-expanded` + `aria-controls` on a real `button`,
 *    with focus handed into the panel on open and back to the button on close.
 *    The APG's disclosure pattern leaves focus on the button; this does not,
 *    because the panel is a capped-height scroller whose content is the entire
 *    reason for pressing, and because a close that happens while focus is inside
 *    it must have somewhere to put focus back.
 *  * The checkboxes are a `fieldset` with a `legend`, or they announce as a run
 *    of loose checkboxes with no idea what they belong to.
 *  * Counts are in the accessible NAME, not adjacent text. The visible "(21)" is
 *    `aria-hidden` and a spelled-out "21 tracks" carries it instead.
 *  * Each track's name carries its category as well as its title. The category is
 *    a heading above the list, which is right for reading order and useless to
 *    anyone landing on the button from a list of form controls.
 *  * The playing track is `aria-current` AND says "Playing" in text — the second
 *    half is WCAG 1.4.1, the first is what a screen reader actually hears.
 *
 * `aria-label` is used on the checkbox inputs and the track buttons rather than
 * letting the name fall out of the content. That is deliberate: the visible rows
 * are a label plus a right-aligned figure plus (sometimes) a badge, which
 * concatenates into a name whose punctuation depends on the layout. Composing it
 * explicitly is the only way the announced text stays stable when the layout
 * changes. The visible text is contained in every one of them (WCAG 2.5.3), and
 * the parts that are not are `aria-hidden`.
 */

/** Panel height cap. Roughly six rows — enough to be a list rather than a
 * peephole, short enough that the timer's number stays on screen underneath the
 * expanded panel on a phone. */
const PANEL_MAX_HEIGHT = "max-h-64";

const NO_GROUPS: FocusTrackGroup[] = [];

export function FocusPlaylistPanel({
  controls,
  voice,
  categories,
  onCategoriesChange,
}: {
  controls: FocusSoundControls;
  voice: Voice;
  /** The live selection (`Settings.focusSoundCategories`), owned by the timer so
   * the same value drives the pool and this list. */
  categories: readonly string[];
  /** Report a new selection. The timer persists it, debounced. */
  onCategoriesChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const playlistsLabelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  /**
   * The selection, flattened for the memo keys below — the same reason
   * `useFocusSound` does it. Every realistic caller writes
   * `categories={settings.focusSoundCategories ?? []}`, which is a fresh array on
   * every render, so keying on identity would recompute on the mini-player's
   * 250ms progress tick forever.
   */
  const categoryKey = JSON.stringify([...categories].sort());

  /**
   * Everything derived from a track list is memoised AND gated on `open`, which
   * together answer "can the counts be computed without a second pass over the
   * manifest on every render?".
   *
   * The counts need no pass of their own at all: `focusPlaylistCategories` already
   * accumulates them in the single pass it makes to find the categories, so
   * `pickerFocusCategories` returns them as a field. Grouping the POOL is a
   * genuinely different pass over a different list, and the all-tracks state is a
   * third (`resolveFocusPool` filters). Each is keyed on an identity its owner
   * keeps stable — `useFocusCatalog` returns the bundled array itself when the
   * catalog added nothing, and `useFocusSound` memoises the pool — so the
   * mini-player's 250ms progress tick recomputes none of them. Gating on `open`
   * then means the collapsed default, which shows none of this, costs nothing.
   */
  const playlists = useMemo(
    () =>
      open
        ? pickerFocusCategories(
            controls.catalog,
            JSON.parse(categoryKey) as string[],
          )
        : [],
    [open, controls.catalog, categoryKey],
  );
  const groups = useMemo(
    () => (open ? groupTracksByCategory(controls.pool) : NO_GROUPS),
    [open, controls.pool],
  );
  // Derived from the SELECTION rather than from `controls.pool`, so the row and
  // the ticks under it can never disagree — both answer the same question about
  // the same array. It is the same function the hook resolves the pool with.
  const allTracks = useMemo(
    () =>
      open &&
      poolIsWholeCatalogue(
        controls.catalog,
        JSON.parse(categoryKey) as string[],
      ),
    [open, controls.catalog, categoryKey],
  );

  const selected = new Set(categories);

  /**
   * Ticking a playlist row.
   *
   * A selected slug with no row is PRESERVED. That is not a corner case: when the
   * streamed catalog stops answering its categories vanish from `controls.catalog`
   * and therefore from `playlists`, and rebuilding the selection from the visible
   * rows alone would permanently discard a playlist because the store blipped for
   * a moment.
   */
  const toggleCategory = (slug: string, checked: boolean) => {
    const shown = new Set(playlists.map((p) => p.slug));
    const kept = categories.filter((c) => !shown.has(c));
    const ticked = playlists
      .filter((p) => (p.slug === slug ? checked : selected.has(p.slug)))
      .map((p) => p.slug);
    onCategoriesChange([...kept, ...ticked]);
  };

  const countName = (n: number) =>
    `${n} ${t(n === 1 ? "focus.sound.trackOne" : "focus.sound.trackMany", voice)}`;

  const row =
    "flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 text-sm";

  return (
    <div>
      <button
        type="button"
        ref={buttonRef}
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-controls={panelId}
        // One label in both states, like the shuffle toggle: aria-expanded
        // carries open/closed, and a label that rewrote itself under the user
        // would be a second thing to re-read on every press.
        className="text-muted-foreground hover:bg-accent hover:text-accent-foreground inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-md text-xs"
      >
        <ListMusic aria-hidden="true" className="h-4 w-4 shrink-0" />
        {t("focus.sound.panel", voice)}
        {open ? (
          <ChevronUp aria-hidden="true" className="h-4 w-4 shrink-0" />
        ) : (
          <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0" />
        )}
      </button>

      {open && (
        <div
          id={panelId}
          ref={panelRef}
          // A focus target, not a tab stop. The UA outline is deliberately left
          // alone (a11y-class-hygiene Rule D / WCAG 2.4.11): a visible ring
          // around what just appeared is correct.
          tabIndex={-1}
          role="group"
          aria-label={t("focus.sound.panel", voice)}
          className={cn(
            "mt-2 space-y-3 rounded-md border p-2 text-left",
            PANEL_MAX_HEIGHT,
            "overflow-y-auto",
          )}
        >
          {playlists.length > 0 && (
            // Omitted entirely when nothing qualifies — the ten-track bundled
            // instance with nothing selected. A group holding one permanently
            // ticked "All tracks" row would be noise on a screen whose job is to
            // stay out of the way.
            <fieldset aria-labelledby={playlistsLabelId}>
              <legend id={playlistsLabelId} className="text-sm font-medium">
                {t("focus.sound.playlists", voice)}
              </legend>
              <p className="text-muted-foreground text-xs">
                {t("focus.sound.playlistsHint", voice)}
              </p>
              <label className={row}>
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0"
                  checked={allTracks}
                  // Already-all-tracks has no off-switch of its own: you leave
                  // that state by ticking a playlist. aria-disabled rather than
                  // disabled, matching the timer's retry button — a disabled
                  // control cannot hold focus, so unticking would drop a
                  // keyboard user to <body> from the middle of the list.
                  aria-disabled={allTracks || undefined}
                  aria-label={`${t("focus.sound.allTracks", voice)} ${countName(controls.catalog.length)}`}
                  onChange={() => {
                    if (!allTracks) onCategoriesChange([]);
                  }}
                />
                <span className="flex-1">
                  {t("focus.sound.allTracks", voice)}
                </span>
                <span
                  aria-hidden="true"
                  className="text-muted-foreground tabular-nums"
                >
                  ({controls.catalog.length})
                </span>
              </label>
              {playlists.map((p) => (
                <label key={p.slug} className={row}>
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0"
                    checked={selected.has(p.slug)}
                    aria-label={`${p.label} ${countName(p.count)}`}
                    onChange={(e) => toggleCategory(p.slug, e.target.checked)}
                  />
                  <span className="flex-1">{p.label}</span>
                  <span
                    aria-hidden="true"
                    className="text-muted-foreground tabular-nums"
                  >
                    ({p.count})
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          <div>
            {/* h2 under the timer's h1, with the category headings below at h3 —
                no level is skipped. It names the section for anyone moving by
                heading; the per-category lists are named by their own h3, which
                is the association that has to exist in the tree. */}
            <h2 className="text-sm font-medium">
              {t("focus.sound.tracks", voice)}
            </h2>
            {groups.map((g) => (
              <TrackGroup
                key={g.slug}
                group={g}
                voice={voice}
                currentId={controls.track?.id ?? null}
                onJump={controls.jumpTo}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TrackGroup({
  group,
  voice,
  currentId,
  onJump,
}: {
  group: FocusTrackGroup;
  voice: Voice;
  currentId: string | null;
  onJump: (trackId: string) => void;
}) {
  const headingId = useId();
  return (
    <div className="mt-2">
      {/* A real heading, not styled text: 166 titles in one uninterrupted run
          loses which playlist a track came from, and a screen reader needs
          something to move BETWEEN. h3 under the panel's own h2, under the
          timer's h1 — no level is skipped. */}
      <h3
        id={headingId}
        className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase"
      >
        {group.label}
      </h3>
      <ul aria-labelledby={headingId}>
        {group.tracks.map((track) => {
          const current = track.id === currentId;
          return (
            <li key={track.id}>
              <button
                type="button"
                onClick={() => onJump(track.id)}
                // "true", not "page"/"step": this is the current item of a set
                // with no better-fitting token.
                aria-current={current ? "true" : undefined}
                aria-label={
                  current
                    ? `${track.title}, ${group.label}, ${t("focus.sound.playing", voice)}`
                    : `${track.title}, ${group.label}`
                }
                className={cn(
                  "hover:bg-accent hover:text-accent-foreground flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 text-left text-sm",
                  current && "bg-accent text-accent-foreground font-medium",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{track.title}</span>
                {current && (
                  // The same state as aria-current, in text, so it is never
                  // carried by the tint alone (WCAG 1.4.1).
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-[11px] uppercase"
                  >
                    {t("focus.sound.playing", voice)}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
