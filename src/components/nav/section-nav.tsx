"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { sectionLabel, type SectionDef } from "@/lib/section-nav";
import { useMediaQuery } from "@/lib/use-media-query";
import { type Voice } from "@/lib/strings";

/** Tailwind's `sm` breakpoint (40rem). Keep in step with `max-sm:` below. */
const WIDE = "(min-width: 40rem)";

/**
 * "Which section am I in" is answered by the topmost section overlapping a band
 * near the top of the viewport. Two details make or break it:
 *
 *  - the band must START below the sticky bar, past where a jump target lands
 *    (`--section-nav-h` + the 1rem in globals.css, plus a few px of slack).
 *    Otherwise the sliver of the PREVIOUS section still showing under the bar is
 *    the topmost match, and clicking "Focus timer" leaves "Notifications" lit.
 *  - it must reach well down the viewport, because at the very top of the page
 *    the first section starts below the header, the h1 and the expanded bar.
 */
const BAND_TOP_SLACK = 16 + 4; // globals.css scroll-margin fudge + rounding
const BAND_BOTTOM = "-35%"; // band ends 65% down the viewport

/** Visibility of the link list. Three states, because "default" is a CSS
 *  decision (see `expanded` below) and must survive server rendering. */
const LIST_CLASS = {
  // Untouched: expanded from `sm` up, collapsed below it — resolved by CSS, so
  // the first paint is already right at both widths (no expand/collapse jump
  // once React hydrates).
  default: "flex max-sm:hidden",
  open: "flex",
  closed: "hidden",
} as const;

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
 *    "you are here" cue is never colour alone;
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
  // Wide is the optimistic server guess: the desktop layout is the one where the
  // full map fits, and it matches the CSS default above so first paint is stable.
  const wide = useMediaQuery(WIDE, true);
  // The user's toggle is remembered WITH the breakpoint it was made at, so
  // crossing the breakpoint hands control back to the viewport default instead
  // of restoring a state chosen for a different screen size. Keying it this way
  // keeps that purely derived — no effect syncing state to state.
  const [override, setOverride] = useState<{
    wide: boolean;
    open: boolean;
  } | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  // Measured height of the sticky bar. Feeds both the jump targets'
  // scroll-margin (via a CSS custom property) and the tracking band below.
  const [barHeight, setBarHeight] = useState(0);

  const applied = override?.wide === wide ? override : null;
  const expanded = applied?.open ?? wide;
  const listClass =
    applied == null
      ? LIST_CLASS.default
      : applied.open
        ? LIST_CLASS.open
        : LIST_CLASS.closed;

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
        rootMargin: `-${barHeight + BAND_TOP_SLACK}px 0px ${BAND_BOTTOM} 0px`,
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
    if (!wide) setOverride({ wide, open: false });
    document.getElementById(id)?.focus({ preventScroll: true });
  };

  // `current` was set from whatever section list was live when the observer was
  // built, and props can hand us a SHORTER list before the observer catches up:
  // Settings renders a different set for owner vs guest (Integrations is
  // conditional) and several saves call router.refresh(). Resolve the id to a
  // section ONCE and tolerate a miss — an id we can no longer find means we do
  // not know where the reader is, and marking the wrong entry is worse than
  // marking none. Everything below keys off this, so the highlighted pill and
  // the collapsed-row label can never disagree.
  const currentSection = current
    ? (sections.find((s) => s.id === current) ?? null)
    : null;
  const currentLabel = currentSection
    ? sectionLabel(currentSection, voice)
    : null;

  return (
    <nav
      ref={navRef}
      aria-label={label}
      // z-index 1, chosen precisely. Sticky alone is NOT enough: anything later
      // in the page with `opacity` < 1 (the disabled model radios, the guest
      // integrations shell) forms its own stacking context at the same level as
      // a positioned element, and being later in the DOM it painted straight
      // over the stuck bar. 1 clears all of that while staying under the
      // header's z-10 app-menu dropdown, which must stay on top of the bar.
      // The negative margin lets the background cover the page container's
      // gutters when the bar is stuck.
      className="bg-background sticky top-0 z-[1] -mx-4 border-b px-4 py-2"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setOverride({ wide, open: !expanded })}
          className="hover:bg-accent focus-visible:ring-ring focus-visible:ring-offset-background inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
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
              "h-3.5 w-3.5 transition-transform",
              expanded && "rotate-180",
            )}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
          Jump to…
        </button>
        {!expanded && currentLabel && (
          // Collapsed, the bar still answers "where am I?" — the whole point of
          // the nav on a page you can get lost scrolling.
          <span className="text-muted-foreground min-w-0 truncate text-xs">
            {currentLabel}
          </span>
        )}
      </div>

      <ul id={listId} className={cn("flex-wrap gap-1.5 pt-2", listClass)}>
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
