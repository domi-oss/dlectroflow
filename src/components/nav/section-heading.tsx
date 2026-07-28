import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { sectionById, sectionLabel, type SectionId } from "@/lib/section-nav";
import { type Voice } from "@/lib/strings";

/**
 * #101 — the disclosure half of a heading band, when the section is collapsible.
 * `<CollapsibleSection>` owns the state and passes this down; nothing else
 * should construct it.
 */
export type SectionDisclosure = {
  readonly expanded: boolean;
  /** The `id` of the body this trigger controls (`aria-controls`). */
  readonly bodyId: string;
  /** The `id` of the visible summary line, if the section has one. */
  readonly summaryId?: string;
  readonly onToggle: () => void;
};

/**
 * #72 — the heading band for one section of a long page (Settings, Help).
 *
 * Four jobs:
 *  1. ONE heading weight. Settings used to mix `text-lg`, `text-sm` and an
 *     unsized `font-semibold` for the same semantic level; listing those side
 *     by side in the nav made the inconsistency obvious. Every section heading
 *     now renders through here.
 *  2. The jump target. `id` comes from the shared registry, so the nav entry and
 *     the heading can never drift apart.
 *  3. An iOS-style sticky list header. The OUTER band is what sticks, and it is
 *     rendered here rather than by each caller so it is always a direct child of
 *     its `<section>` — the section is then the sticky containing block, which
 *     is what makes the header pin for exactly as long as its section is on
 *     screen. (Three of the settings components used to wrap the heading in a
 *     flex div at the call site; that little div became the containing block and
 *     the header never pinned at all.) globals.css styles the band and its
 *     `data-current` state; SectionNav sets that attribute.
 *  4. A landing place for focus. `tabIndex={-1}` makes the heading
 *     programmatically focusable, so a fragment jump moves real focus here
 *     instead of leaving keyboard and screen-reader users at the top of the
 *     document. It stays out of the tab order.
 *
 * #101 adds a fifth, optional job: being the disclosure trigger for a
 * collapsible section. The trigger is rendered INSIDE the `h2` (the ARIA
 * accordion pattern) rather than beside it, for two reasons — the chevron has to
 * sit before the title, and the heading's accessible name has to stay exactly
 * the section's registry label. Everything in job 2, 3 and 4 above still holds:
 * the `h2` is the element with the id, the scroll-margin hook and the focus.
 *
 * Not a client component: it holds no state, so Help (server) and the Settings
 * sections (client) can both render it.
 */
export function SectionHeading({
  id,
  voice,
  className,
  disclosure,
  children,
}: {
  id: SectionId;
  voice: Voice;
  className?: string;
  /** Present when the section is collapsible (#101). */
  disclosure?: SectionDisclosure;
  /**
   * Trailing inline extras (save indicator, owner-only badge). Rendered as
   * SIBLINGS of the `h2`, not inside it, so the heading's accessible name stays
   * the section name even while a live save indicator is showing.
   */
  children?: React.ReactNode;
}) {
  const label = sectionLabel(sectionById(id), voice);
  return (
    <div
      data-section-header=""
      className={cn("flex items-center gap-2", className)}
    >
      <h2
        id={id}
        tabIndex={-1}
        data-section-target=""
        className={cn(
          "focus-visible:ring-ring focus-visible:ring-offset-background rounded-sm text-lg font-semibold outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
          // The trigger fills the row, so the h2 has to be allowed to.
          disclosure && "min-w-0 flex-1",
        )}
      >
        {disclosure ? (
          <button
            type="button"
            // A stable hook for the tests and for anything that needs to find one
            // section's trigger among nine identical ones.
            data-section-toggle={id}
            aria-expanded={disclosure.expanded}
            aria-controls={disclosure.bodyId}
            // The summary (if any) is the trigger's DESCRIPTION, never its name:
            // WCAG 2.5.3 wants the accessible name to be the visible label, and
            // the visible label of a section heading is the section's name.
            aria-describedby={disclosure.summaryId}
            onClick={disclosure.onToggle}
            // The WHOLE ROW is the target, not the 16px glyph — #73 already had
            // to fix an 11x20px hit box for exactly this reason. `-ml-2` pulls
            // the padded hit area back to the page's text margin so the extra
            // height costs no extra indent.
            //
            // `hover:bg-current/10`, never `hover:bg-accent`: this button sits
            // inside the sticky section band, and while that band is the current
            // section globals.css paints it magenta and forces
            // `color: currentColor` on its children — an `--accent` hover
            // background put white text on light pink at 1.16:1 (!175). A tint of
            // currentColor is correct in BOTH contexts by construction, because
            // it is derived from the text colour actually in force.
            className="focus-visible:ring-ring focus-visible:ring-offset-background -ml-2 flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-current/10 focus-visible:ring-2 focus-visible:ring-offset-2"
          >
            {/* BEFORE the title (the standard accordion/tree affordance), from
                the icon set the transport and timer glyphs already come from: a
                literal "^" would not sit on the heading baseline across the four
                typeface options (#40). Decorative — `aria-expanded` above is
                what carries the state — and ROTATED rather than swapped for a
                second glyph, so there is one element to style and the change of
                state is legible. The rotation is a CSS transition, so the global
                prefers-reduced-motion rule in globals.css governs it. */}
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "h-4 w-4 shrink-0 transition-transform",
                disclosure.expanded && "rotate-180",
              )}
            />
            <span className="truncate">{label}</span>
          </button>
        ) : (
          label
        )}
      </h2>
      {children}
    </div>
  );
}
