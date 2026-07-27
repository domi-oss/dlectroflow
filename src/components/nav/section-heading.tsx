import { cn } from "@/lib/utils";
import { sectionById, sectionLabel, type SectionId } from "@/lib/section-nav";
import { type Voice } from "@/lib/strings";

/**
 * #72 — the `<h2>` for one section of a long page (Settings, Help).
 *
 * Three jobs:
 *  1. ONE heading weight. Settings used to mix `text-lg`, `text-sm` and an
 *     unsized `font-semibold` for the same semantic level; listing those side
 *     by side in the nav made the inconsistency obvious. Every section heading
 *     now renders through here.
 *  2. The jump target. `id` comes from the shared registry, so the nav entry and
 *     the heading can never drift apart, and `data-section-target` picks up the
 *     `scroll-margin-top` rule in globals.css that keeps the sticky nav from
 *     covering the heading it just jumped to.
 *  3. A landing place for focus. `tabIndex={-1}` makes the heading
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
  /** Trailing inline extras (save indicator, owner-only badge). */
  children?: React.ReactNode;
}) {
  return (
    <h2
      id={id}
      tabIndex={-1}
      data-section-target=""
      className={cn(
        "text-lg font-semibold",
        "focus-visible:ring-ring focus-visible:ring-offset-background rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        children != null && "flex items-center gap-2",
        className,
      )}
    >
      {sectionLabel(sectionById(id), voice)}
      {children}
    </h2>
  );
}
