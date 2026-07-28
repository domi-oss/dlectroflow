"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { sectionLabel, type SectionDef } from "@/lib/section-nav";
import { useMediaQuery } from "@/lib/use-media-query";
import { type Voice } from "@/lib/strings";

/** Tailwind's `sm` breakpoint (40rem). */
const WIDE = "(min-width: 40rem)";

/**
 * "Which section am I in" is answered by the topmost section overlapping a band
 * near the top of the viewport. Two details make or break it:
 *
 *  - the band must START below the sticky bar, at exactly where a jump target
 *    lands (`--section-nav-h`, plus a few px for rounding). Otherwise the sliver
 *    of the PREVIOUS section still showing under the bar is the topmost match,
 *    and clicking "Focus timer" leaves "Notifications" lit.
 *  - it must reach well down the viewport, because at the very top of the page
 *    the first section starts below the header, the h1 and the expanded bar.
 */
const BAND_TOP_SLACK = 4; // rounding only — a jump now lands flush at the bar
const BAND_BOTTOM = "-35%"; // band ends 65% down the viewport

/**
 * #72 — collapsible sticky section nav for the long pages (Settings, Help).
 *
 * Plain in-page anchors, deliberately: everything stays on one page, so
 * scrolling and Ctrl+F still work, sections are deep-linkable (`#settings-voice`)
 * and the jump itself needs no JavaScript.
 *
 * Accessibility notes:
 *  - real `<nav>` with an accessible name (`label`), one `<ul>` of links;
 *  - the toggle is a `<button>` with `aria-expanded` + `aria-controls`;
 *  - the current section carries `aria-current="true"` AND a dot marker, so the
 *    "you are here" cue is never colour alone. The same section's heading is
 *    marked `data-current`, which globals.css renders as the pinned magenta
 *    section header — its PINNED POSITION is a second non-colour cue;
 *  - every control clears the 44px touch-target minimum;
 *  - motion: the smooth scroll is opted into by adding `scroll-smooth` to
 *    `<html>`, which the global `prefers-reduced-motion` rule in globals.css
 *    already overrides with `scroll-behavior: auto !important` — so reduced
 *    motion is honoured by the same one rule that covers the rest of the app;
 *  - the bar publishes its own live height as `--section-nav-h` so the target
 *    heading is never left underneath it (see `[data-section-target]`).
 */
export function SectionNav({
  sections,
  voice,
  label,
}: {
  sections: readonly SectionDef[];
  voice: Voice;
  /** Accessible name for the landmark, e.g. "Settings sections". */
  label: string;
}) {
  const listId = useId();
  const navRef = useRef<HTMLElement>(null);
  // Only used to decide whether picking a section should close the panel again
  // (see onJump) — the collapsed/expanded DEFAULT no longer depends on it.
  const wide = useMediaQuery(WIDE, true);
  // Collapsed at every viewport on load: the resting state of both pages is the
  // single compact row. Server and client agree on `false`, so there is no
  // first-paint flip and `aria-expanded` is honest from the very first byte.
  // Reopening is remembered for the rest of the visit, nothing is persisted
  // across visits.
  const [expanded, setExpanded] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  // Measured height of the sticky bar. Feeds both the jump targets'
  // scroll-margin (via a CSS custom property) and the tracking band below.
  const [barHeight, setBarHeight] = useState(0);

  // `current` was set from whatever section list was live when the observer was
  // built, and props can hand us a SHORTER list before the observer catches up:
  // Settings renders a different set for owner vs guest (Integrations is
  // conditional) and several saves call router.refresh(). Resolve the id to a
  // section ONCE and tolerate a miss — an id we can no longer find means we do
  // not know where the reader is, and marking the wrong entry is worse than
  // marking none. EVERY "you are here" cue keys off this single resolved value
  // — the highlighted pill, the collapsed-row label and the pinned heading band
  // — so they cannot disagree with each other.
  const currentSection = current
    ? (sections.find((s) => s.id === current) ?? null)
    : null;
  const currentSectionId = currentSection?.id ?? null;
  const currentLabel = currentSection
    ? sectionLabel(currentSection, voice)
    : null;

  // Smooth in-page scrolling while this page is open (reduced motion still wins,
  // via globals.css).
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("scroll-smooth");
    return () => root.classList.remove("scroll-smooth");
  }, []);

  // Publish the bar's height for `[data-section-target]`'s scroll-margin-top.
  // It changes whenever the list expands, collapses or rewraps, so measure live.
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const root = document.documentElement;
    const measure = () => Math.round(el.getBoundingClientRect().height);
    const publish = (height: number) =>
      root.style.setProperty("--section-nav-h", `${height}px`);
    // Synchronous first publish so the scroll margin is right even before the
    // observer's first callback (and where there is no ResizeObserver at all).
    // Deliberately DOM-only: the state update happens in the observer callback,
    // which is where React wants external-system updates to land.
    publish(measure());
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const height = measure();
            publish(height);
            setBarHeight(height);
          });
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--section-nav-h");
    };
  }, []);

  // Scroll-position tracking via IntersectionObserver (never a scroll handler).
  // We observe each heading's enclosing <section>, not the heading itself: a
  // heading leaves the band within a few pixels of scrolling, a section spans it.
  const ids = sections.map((s) => s.id).join("|");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const order = ids.split("|");
    const idFor = new Map<Element, string>();
    for (const id of order) {
      const heading = document.getElementById(id);
      const target = heading?.closest("section") ?? heading;
      if (target) idFor.set(target, id);
    }
    if (idFor.size === 0) return;

    // At the very bottom of the document the last section can never reach the
    // top of the viewport, so plain "topmost wins" strands it: you jump to
    // "Integrations", the page hits its scroll limit, and the entry above stays
    // lit. End of page ⇒ last section.
    const atDocumentEnd = (): boolean => {
      const maxScroll =
        document.documentElement.scrollHeight - window.innerHeight;
      return maxScroll > 4 && window.scrollY >= maxScroll - 2;
    };

    // Measure the bar HERE rather than trusting the `barHeight` state, which is
    // still 0 on the very first run (the ResizeObserver has not reported yet).
    // Building the first observer with no bar offset would open a brief window
    // of exactly the bug BAND_TOP_SLACK exists to prevent. `barHeight` stays in
    // the dependency list purely as the rebuild trigger for later resizes.
    const barOffset = () =>
      Math.round(navRef.current?.getBoundingClientRect().height ?? barHeight);

    const inBand = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = idFor.get(entry.target);
          if (!id) continue;
          if (entry.isIntersecting) inBand.add(id);
          else inBand.delete(id);
        }
        if (atDocumentEnd()) {
          setCurrent(order[order.length - 1]);
          return;
        }
        // Topmost section in document order wins when several overlap the band.
        const next = order.find((id) => inBand.has(id));
        // Nothing in the band (a long section scrolled past its own end) — keep
        // the last answer rather than blanking the "you are here" cue.
        if (next) setCurrent(next);
      },
      {
        rootMargin: `-${barOffset() + BAND_TOP_SLACK}px 0px ${BAND_BOTTOM} 0px`,
        threshold: 0,
      },
    );
    for (const target of idFor.keys()) observer.observe(target);

    // A smooth scroll that lands against the document's scroll limit produces no
    // further intersection change, so the end-of-page rule above needs one more
    // trigger. `scrollend` is a single discrete event when the scroll comes to
    // rest — not a scroll-position poller — and where it is unsupported the
    // observer's own (possibly mid-animation) verdict simply stands.
    const onScrollEnd = () => {
      if (atDocumentEnd()) setCurrent(order[order.length - 1]);
    };
    const hasScrollEnd = "onscrollend" in window;
    if (hasScrollEnd) window.addEventListener("scrollend", onScrollEnd);

    return () => {
      observer.disconnect();
      if (hasScrollEnd) window.removeEventListener("scrollend", onScrollEnd);
    };
    // Re-observing on a bar-height change is deliberate: rootMargin is fixed at
    // construction, and the band's top edge has to follow the bar as the list
    // expands, collapses or rewraps.
  }, [ids, barHeight]);

  // Hand the current section to its own heading, which globals.css turns into
  // the pinned magenta header. The headings live OUTSIDE this component's tree
  // — Help renders them from a server component, Settings from five separate
  // client components — so there is no shared React state to thread `current`
  // through; marking the element is the honest way across that boundary.
  useEffect(() => {
    // Keyed off the RESOLVED section, not the raw id, so the pinned band and
    // the highlighted nav pill can never disagree: if the id is not in
    // `sections` no pill is lit, and no band may claim to be current either.
    if (!currentSectionId) return;
    const heading = document.getElementById(currentSectionId);
    // Mark the surrounding band — that is the element globals.css styles and
    // the one that actually sticks.
    const band = heading?.closest("[data-section-header]") ?? heading;
    if (!band) return;
    band.setAttribute("data-current", "");
    return () => band.removeAttribute("data-current");
  }, [currentSectionId]);

  const onJump = (
    event: React.MouseEvent<HTMLAnchorElement>,
    id: string,
  ): void => {
    // Leave modified clicks (open in a new tab, etc.) entirely alone.
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    // On a small screen the expanded bar would cover a third of the viewport, so
    // it steps aside once it has done its job. Collapsing removes the link that
    // currently has focus, so move focus onto the destination heading ourselves
    // instead of relying on the browser's fragment-navigation focus move —
    // `preventScroll` leaves the (smooth) scroll to the anchor's default action.
    if (!wide) setExpanded(false);
    document.getElementById(id)?.focus({ preventScroll: true });
  };

  return (
    <nav
      ref={navRef}
      aria-label={label}
      // z-index 2, chosen precisely. Sticky alone is NOT enough: anything later
      // in the page with `opacity` < 1 (the disabled model radios, the guest
      // integrations shell) forms its own stacking context at the same level as
      // a positioned element, and being later in the DOM it painted straight
      // over the stuck bar. There are now TWO stacked sticky layers, so the
      // order is: page content (0) < sticky section header (1) < this bar (2)
      // < the header's app-menu dropdown (10), which must stay on top of both.
      // The negative margin lets the background cover the page container's
      // gutters when the bar is stuck.
      className="bg-background sticky top-0 z-[2] -mx-4 border-b px-4 py-2"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((v) => !v)}
          // Collapsed is now the resting state at every width, so this row is
          // the whole nav most of the time — it carries real weight (semibold,
          // full-contrast) rather than reading as quiet chrome. The -ml-2
          // pulls the padded hit area back to the page's text margin so the
          // extra weight costs no extra height.
          className="hover:bg-accent focus-visible:ring-ring focus-visible:ring-offset-background -ml-2 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2 text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn(
              "h-4 w-4 shrink-0 transition-transform",
              expanded && "rotate-180",
            )}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
          Jump to…
        </button>
        {!expanded && currentLabel && (
          // Collapsed, the bar still answers "where am I?" — and at the top of
          // the page, before any section header has pinned, it is the ONLY
          // thing that does. Full-contrast and semibold to match the button:
          // between them they are the entire resting UI.
          <span className="text-foreground min-w-0 truncate text-base font-semibold">
            {currentLabel}
          </span>
        )}
      </div>

      <ul
        id={listId}
        className={cn("flex-wrap gap-1.5 pt-2", expanded ? "flex" : "hidden")}
      >
        {sections.map((section) => {
          const active = section.id === currentSection?.id;
          return (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                aria-current={active ? "true" : undefined}
                onClick={(event) => onJump(event, section.id)}
                className={cn(
                  "focus-visible:ring-ring focus-visible:ring-offset-background inline-flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
                  active
                    ? "bg-primary text-primary-foreground border-primary font-medium"
                    : "hover:bg-accent",
                )}
              >
                {active && (
                  // Non-colour "you are here" cue, alongside the heavier weight
                  // — drawn, not a glyph, so it survives the OpenDyslexic and
                  // Atkinson typeface options.
                  <span
                    data-current-marker=""
                    aria-hidden="true"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
                  />
                )}
                {sectionLabel(section, voice)}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
