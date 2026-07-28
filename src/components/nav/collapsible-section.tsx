"use client";

import { useId, useState } from "react";
import { SectionHeading } from "@/components/nav/section-heading";
import { announceSectionActive, type SectionId } from "@/lib/section-nav";
import { type Voice } from "@/lib/strings";

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
 *  • Plain `useState`, seeded from a prop. Server and client render the same
 *    thing on the first pass, so `aria-expanded` is honest from the first byte
 *    and there is no expanded-then-collapsed flash on hydration. Deliberately
 *    NOT synced from an effect — the react-hooks rules are at `error` here, and a
 *    set-state-in-effect would BE the flash.
 *  • Collapsed by default, every visit; reopening is remembered for the rest of
 *    the visit and nothing is persisted. !162's precedent: default rather than
 *    restore a state the reader has forgotten they left.
 *
 * Clicking the header also publishes {@link announceSectionActive}, which is how
 * the owner's "clicking other section headers should highlight the section title"
 * lands on !162's existing magenta current-section treatment instead of a second
 * highlight style.
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
  const [expanded, setExpanded] = useState(defaultExpanded);

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
            setExpanded((open) => !open);
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
