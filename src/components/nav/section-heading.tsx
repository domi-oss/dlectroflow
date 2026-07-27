import { cn } from "@/lib/utils";
import { sectionById, sectionLabel, type SectionId } from "@/lib/section-nav";
import { type Voice } from "@/lib/strings";

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
 * Not a client component: it holds no state, so Help (server) and the Settings
 * sections (client) can both render it.
 */
export function SectionHeading({
  id,
  voice,
  className,
  children,
}: {
  id: SectionId;
  voice: Voice;
  className?: string;
  /**
   * Trailing inline extras (save indicator, owner-only badge). Rendered as
   * SIBLINGS of the `h2`, not inside it, so the heading's accessible name stays
   * the section name even while a live save indicator is showing.
   */
  children?: React.ReactNode;
}) {
  return (
    <div
      data-section-header=""
      className={cn("flex items-center gap-2", className)}
    >
      <h2
        id={id}
        tabIndex={-1}
        data-section-target=""
        className="focus-visible:ring-ring focus-visible:ring-offset-background rounded-sm text-lg font-semibold outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
      >
        {sectionLabel(sectionById(id), voice)}
      </h2>
      {children}
    </div>
  );
}
