import Link from "next/link";
import { ShoppingCart, Timer } from "lucide-react";

import { t, type StringKey, type Voice } from "@/lib/strings";
import { cn, controlSurface, touchTarget } from "@/lib/utils";

/**
 * #252 — one-tap access to the two destinations that were only reachable by
 * opening the hamburger.
 *
 * ## Why icons in the bar and not more menu rows
 *
 * The menu is a complete index of the app; it is not a shortcut. Getting to the
 * shopping list mid-aisle, or to the timer when you have finally decided to
 * start, cost a tap to open the menu, a read of seven labels and a second tap.
 * For a tool whose users are ADHD, "the thing you are about to do is two taps
 * and a list away" is the failure mode, not an inconvenience — the moment of
 * intent is the thing being protected.
 *
 * ## A server component, deliberately
 *
 * Two `<Link>`s and two glyphs need no hooks and no state, so nothing here has
 * to ship to the browser. That also keeps the layout's promise intact: both
 * gates are already in `settings`, which the layout reads for the voice, so the
 * whole feature costs **no query and no client bundle**.
 *
 * The cost of that choice, stated because it is a real one: with no
 * `usePathname()` these links cannot carry `aria-current="page"` the way the
 * menu's entries do. That is WCAG 2.4.8 (Location), which is AAA and not part of
 * the AA bar this repo holds itself to, and the menu — which does mark it — is
 * still one tap away. Making the whole cluster a client component to add it
 * would trade a measured bundle cost for an advisory-level nicety.
 *
 * ## Failing closed
 *
 * Both props default to `false`, matching `AppMenu`'s `shoppingList = false` and
 * for the same reason: a caller that forgets one hides a feature rather than
 * advertising one the workspace did not ask for. `Settings.focusQuickAccess`
 * defaults to TRUE, but that decision belongs to the column — a component
 * default of `true` would mean a forgotten prop overrides what the workspace
 * actually stored.
 *
 * Hiding a link is presentation, never a gate. `/shopping` answers `notFound()`
 * when shopping-list mode is off and every shopping server action re-checks
 * (#199); `/focus` is not gated at all, because `focusQuickAccess` is about the
 * ICON and not about the route — the menu still lists the timer unconditionally,
 * so turning the icon off must not take the feature away.
 */

/** One quick-access destination: the same button, three times over. */
function QuickAccessLink({
  href,
  labelKey,
  voice,
  Icon,
}: {
  href: string;
  labelKey: StringKey;
  voice: Voice;
  Icon: typeof Timer;
}) {
  // Dropping the visible words drops the accessible name with them, so it is
  // spelled out — and `title` gives a pointer user the same string on hover.
  // Exactly the theme toggle's convention (#103), which is the control these
  // sit beside.
  const label = t(labelKey, voice);
  return (
    <Link
      href={href}
      // `controlSurface` is the theme toggle's own class string, imported rather
      // than copied: three bordered icon buttons in one cluster have to read as
      // one set, and #117 is what happens when two of a set keep private copies.
      // `touchTarget` squares a 20px glyph up to the 44px WCAG 2.5.5 minimum.
      className={cn(controlSurface, touchTarget)}
      aria-label={label}
      title={label}
    >
      <Icon aria-hidden="true" className="h-5 w-5" />
    </Link>
  );
}

export function QuickAccess({
  voice,
  shoppingList = false,
  focusQuickAccess = false,
}: {
  voice: Voice;
  /** #199's existing gate — `Settings.shoppingList`. */
  shoppingList?: boolean;
  /** #252's new one — `Settings.focusQuickAccess`, which defaults ON in the DB. */
  focusQuickAccess?: boolean;
}) {
  return (
    <>
      {/* Focus first, then shopping: the order the hamburger already lists them
          in, and the order of the core loop. Each renders exactly ONE element
          into the header's flex row, the convention auth-actions.tsx states. */}
      {focusQuickAccess && (
        <QuickAccessLink
          href="/focus"
          labelKey="nav.focusQuickAccess"
          voice={voice}
          Icon={Timer}
        />
      )}
      {shoppingList && (
        <QuickAccessLink
          href="/shopping"
          labelKey="nav.shoppingQuickAccess"
          voice={voice}
          Icon={ShoppingCart}
        />
      )}
    </>
  );
}
