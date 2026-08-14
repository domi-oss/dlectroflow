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
 * content), and this component has to render identically in **every** connect
 * surface rather than sprouting an element-type prop.
 *
 * ⚠️ This said "all four" and the number was wrong; it is now phrased without one,
 * on `strings.ts`'s precedent for exactly this failure ("phrased without a count on
 * purpose — this said 'all four' while five…"). A count in a comment is stale by
 * design because nobody re-reads a comment to check it.
 *
 * Re-derive instead:
 * `grep -rn 'GoogleAccountHint\|GOOGLE_ACCOUNT_HINT' src --include=*.tsx`, ignoring
 * test files. Today that is SIX surfaces — `breakdown/breakdown-chat.tsx` (three
 * states), `breakdown/task-schedule.tsx`, `settings/integrations-panel.tsx`, and
 * `inbox/row-actions.tsx`. The last one is why the grep has to match the CONSTANT
 * and not just this component: it renders the string directly as a
 * `title`/`aria-describedby` on its `icon` variant, so a component-keyed search
 * misses it — which is how the count came to be wrong in the first place.
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
