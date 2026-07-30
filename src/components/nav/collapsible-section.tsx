"use client";

import { useEffect, useId, useState } from "react";
import { SectionHeading } from "@/components/nav/section-heading";
import {
  announceSectionActive,
  SECTION_JUMP_EVENT,
  type SectionId,
  type SectionJumpDetail,
} from "@/lib/section-nav";
import { type Voice } from "@/lib/strings";
import {
  currentHashTarget,
  subscribeToHashTarget,
  useHashTarget,
} from "@/lib/use-hash-target";

/**
 * #101 — one section of /settings, as a disclosure.
 *
 * The mechanism is !175's People panel, lifted rather than reinvented, so the app
 * has ONE disclosure dialect and not nine:
 *
 *  • `hidden` the ATTRIBUTE, not a `display:none` class. It takes the collapsed
 *    subtree out of the accessibility tree and the tab order without depending on
 *    a stylesheet, so the collapsed state is honest even before CSS loads. The
 *    body stays MOUNTED, so `aria-controls` always resolves and a section's own
 *    state (a pending edit, a save indicator) survives a close and reopen.
 *  • Expansion is DERIVED, never synced from an effect. Server and client render
 *    the same thing on the first pass, so `aria-expanded` is honest from the
 *    first byte and there is no expanded-then-collapsed flash on hydration —
 *    and the react-hooks rules are at `error` here, so a set-state-in-effect
 *    (which would BE that flash) is not available anyway.
 *  • Collapsed by default, every visit; reopening is remembered for the rest of
 *    the visit and nothing is persisted. !162's precedent: default rather than
 *    restore a state the reader has forgotten they left.
 *
 * Clicking the header also publishes {@link announceSectionActive}, which is how
 * the owner's "clicking other section headers should highlight the section title"
 * lands on !162's existing magenta current-section treatment instead of a second
 * highlight style.
 *
 * #115 adds the other direction: a section OPENS ITSELF when it is asked for —
 * by a "Jump to…" pill ({@link SECTION_JUMP_EVENT}) or by the URL fragment
 * naming it, which covers a deep link, a bookmark and Back/Forward with the same
 * code. It has to live here rather than in the nav for the same reason the
 * highlight has to live in the nav: expansion is this component's state, and the
 * nav is not in its tree. Two rules keep that from becoming officious — only an
 * explicit ask opens a section (never the scroll-spy), and the reader's own
 * collapse stands until they ask for the section again.
 */
export function CollapsibleSection({
  id,
  voice,
  defaultExpanded = false,
  summary,
  headingExtras,
  children,
}: {
  id: SectionId;
  voice: Voice;
  /**
   * Open on arrival. The page decides this, not the section — it is a statement
   * about page order ("the first section should not greet you as an empty page"),
   * so it belongs at the composition site.
   */
  defaultExpanded?: boolean;
  /**
   * One line that answers "is anything up in here?" while the section is closed
   * (the People panel's account/invitation triage line). Shown in the heading
   * band and wired to the trigger as its accessible DESCRIPTION.
   */
  summary?: React.ReactNode;
  /** Inline extras for the heading band: the save indicator, owner-only badges. */
  headingExtras?: React.ReactNode;
  children: React.ReactNode;
}) {
  const bodyId = useId();
  const summaryId = useId();

  // ── #115 — three inputs, one answer ───────────────────────────────────────
  // The reader's own last word on this section, or `null` if they have not
  // touched it since it was last asked for. It outranks everything else while
  // it stands, which is what keeps the scroll-spy (and a re-render, and a
  // history event) from re-opening a section they deliberately closed.
  const [readerChoice, setReaderChoice] = useState<boolean | null>(null);
  // How many times this section has been explicitly asked for during this
  // visit. A COUNT, not a flag: asking twice has to be distinguishable from
  // asking once, because the reader may have closed it in between — and
  // because the second ask is the one that has to re-issue the landing below.
  const [asks, setAsks] = useState(0);
  // The URL fragment naming this section is an ask too, and on a fresh page
  // load it is the ONLY one available: there is no event to hear, and reading
  // it into state from an effect would be a set-state-in-effect (error here,
  // and it would BE the expanded-on-second-paint flash). `useHashTarget` is a
  // store, so the value simply arrives with the first post-hydration render.
  const namedByFragment = useHashTarget() === id;
  const expanded =
    readerChoice ?? (asks > 0 || namedByFragment || defaultExpanded);

  // One channel for "the reader asked to be taken here", two sources: the nav's
  // jump (#115), and the fragment changing to name this section (Back/Forward,
  // a pasted link, a link from a doc). Both are events, so setting state from
  // them is a plain event handler and not an effect writing state.
  useEffect(() => {
    const asked = () => {
      setAsks((n) => n + 1);
      // They have asked again — a collapse aimed at the previous ask no longer
      // stands. Without this, "jump, close, jump again" leaves it closed.
      setReaderChoice(null);
    };
    const onJump = (event: Event) => {
      if ((event as CustomEvent<SectionJumpDetail>).detail?.id === id) asked();
    };
    const onFragment = () => {
      if (currentHashTarget() === id) asked();
    };
    window.addEventListener(SECTION_JUMP_EVENT, onJump);
    const unsubscribe = subscribeToHashTarget(onFragment);
    return () => {
      window.removeEventListener(SECTION_JUMP_EVENT, onJump);
      unsubscribe();
    };
  }, [id]);

  // Land the reader ON the heading, and do it in the commit that OPENED the
  // section rather than before it.
  //
  // Expanding raises the document's scroll limit, so a landing computed against
  // the COLLAPSED page clamps short and leaves the heading somewhere down the
  // viewport instead of under the bar. Re-issuing it once the body is on the
  // page is what makes the landing correct; where the first scroll is still
  // animating, this simply retargets it.
  //
  // The deep link is the case that needs it. Measured on a production build
  // with this effect removed: /settings#settings-people lands the heading at
  // y=733 (its spot is 67) with the page at 1395 of a scroll limit that the
  // expansion has meanwhile raised to 2175 — the browser did its fragment jump
  // while parsing, long before hydration could open anything. A nav PILL is
  // already fine without this, because React flushes the click's state update
  // before the anchor's default action runs, so the browser measures the page
  // expanded; the effect is harmless there and the e2e covers both.
  //
  // Deps are the two ASKS, never `expanded`: the reader opening a section by
  // its own header must not yank the page to it. No `behavior` argument, also
  // deliberately — that leaves the choice to CSS, which is `scroll-smooth`
  // while the nav is mounted and `auto` under prefers-reduced-motion
  // (globals.css), so this honours the same one rule as the rest of the app.
  // `scroll-margin-top` on `[data-section-target]` keeps it clear of the bar.
  useEffect(() => {
    if (asks === 0 && !namedByFragment) return;
    document.getElementById(id)?.scrollIntoView();
  }, [asks, namedByFragment, id]);

  return (
    <section className="space-y-3">
      <SectionHeading
        id={id}
        voice={voice}
        disclosure={{
          expanded,
          bodyId,
          summaryId: summary == null ? undefined : summaryId,
          onToggle: () => {
            // The reader's word, which stands until they are taken here again.
            setReaderChoice(!expanded);
            // Both directions: clicking a header means "this is the section I am
            // dealing with", whether it just opened or just closed.
            announceSectionActive(id);
          },
        }}
      >
        {summary != null && (
          <span
            id={summaryId}
            className="text-muted-foreground min-w-0 shrink truncate text-sm"
          >
            {summary}
          </span>
        )}
        {headingExtras}
      </SectionHeading>

      {/* `hidden` the ATTRIBUTE (see the note above), and still mounted. */}
      <div id={bodyId} hidden={!expanded} className="space-y-3">
        {children}
      </div>
    </section>
  );
}
