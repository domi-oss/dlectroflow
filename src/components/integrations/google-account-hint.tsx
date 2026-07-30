import { cn } from "@/lib/utils";

/**
 * #128 — the one sentence that has to sit next to every "Connect Google"
 * control, in every surface that renders one.
 *
 * A Google Workspace administrator can restrict which third-party OAuth apps
 * may touch accounts in their domain. When ours is not on that allowlist,
 * Google refuses at ITS OWN consent step and shows ITS OWN page: the person
 * never comes back to the callback, so there is no error state for us to
 * render, no failure to log, and nothing that distinguishes it from someone
 * changing their mind. It cannot be detected after the fact, which leaves
 * saying which account to pick BEFORE the click as the only thing that works.
 *
 * Vendor-neutral on purpose. This is a public, self-hostable product: the
 * organisation blocking it is not knowable from here, and naming any single
 * one would be wrong for every other instance. "A work or school account can
 * be blocked by the organisation that owns it" is the general truth, and it is
 * the useful one.
 *
 * Guidance, not an alarm: muted body copy, action first ("use a personal
 * account"), caveat second. It deliberately carries no warning colour, no
 * icon and no `role="alert"` — nothing has gone wrong yet, and dressing a
 * setup hint as an error is how people conclude the app is broken.
 */
export const GOOGLE_ACCOUNT_HINT =
  "Use a personal Google account if you can — a work or school account can be blocked by the organisation that owns it.";

/**
 * Renders {@link GOOGLE_ACCOUNT_HINT} for a connect control to point at.
 *
 * A `<span>` rather than a `<p>`: the ▾ row menu's popup is a span-only tree
 * (see row-actions.tsx, where a `<div>`/`<p>` would be invalid phrasing
 * content), and this component has to render identically in all four connect
 * surfaces rather than sprouting an element-type prop.
 */
export function GoogleAccountHint({
  id,
  className,
}: {
  /**
   * Required, not optional: every use is the target of its control's
   * `aria-describedby`, so the guidance is part of that control's accessible
   * description instead of text that merely happens to sit beside it.
   */
  id: string;
  /** Per-surface sizing/spacing — the base class set is colour only. */
  className?: string;
}) {
  return (
    <span id={id} className={cn("text-muted-foreground block", className)}>
      {GOOGLE_ACCOUNT_HINT}
    </span>
  );
}
