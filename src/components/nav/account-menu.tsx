"use client";

import { useRef } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { cn, touchTarget } from "@/lib/utils";
import {
  ANCHORED_POSITIONER,
  popupSurface,
} from "@/components/ui/anchored-popup";
import { identityLine, type AccountIdentity } from "@/lib/identity";

// Popup entries: full-width rows at the 44px minimum (WCAG 2.5.5), matching
// the app menu's entries directly above them in the same corner.
//
// At module scope: it depends on nothing, so there is no reason to re-bind it per
// render (Duo review, !250), and app-menu.tsx hoists its own the same way — #117
// is about the two menus agreeing, so keeping them structurally identical is the
// point rather than a nicety.
//
// #117 — the focus indicator is an INSET RING, not just the background swap
// this used to rely on. WCAG 2.4.11 Focus Appearance is AA in WCAG 2.2 and axe
// does not implement it, so the whole a11y suite was structurally blind to it:
// --accent against the popup's --background surface is 1.09:1 in light and
// 1.24:1 in dark, against the 3:1 an indicator needs. --ring reads 5.09:1 on
// that surface and 4.65:1 on the focused --accent in light, 8.83:1 / 7.14:1 in
// dark — clear of 3:1 against BOTH adjacent colours in both themes. Inset so
// the ring follows the entry's own rounded box rather than spilling into the
// popup's 4px padding. Identical to app-menu.tsx's entries by design: the two
// popups open inches apart and #117 was declined inside !192 precisely because
// fixing one would make them behave differently.
const ENTRY =
  "hover:bg-accent hover:text-primary focus-visible:bg-accent focus-visible:text-primary focus-visible:inset-ring-2 focus-visible:inset-ring-ring flex min-h-11 w-full items-center rounded-md px-3 text-left outline-none";

/**
 * #100 — who you are signed in as, in the header.
 *
 * THE DESIGN CALL. The handle is visible at rest and IS the trigger for a
 * popover holding the provider, the role, and the two controls it replaced
 * ("Account" and "Sign out"). Three reasons it is shaped this way rather than as
 * a sixth item in the bar:
 *
 *  1. The header had no room. It already carries the brand, the theme toggle,
 *     Account, Sign out and the menu button, and at 390px that cluster measured
 *     wider than the viewport before this change. Replacing two text controls
 *     with one leaves the signed-in bar exactly as wide as a guest's.
 *  2. #74's obligation needs a sentence, not a word. "Owner · signed in with
 *     GitLab" cannot go in the bar at any width — but it has to be reachable
 *     from EVERY page, because the alarming moment it exists for (an empty
 *     workspace that looks like data loss) happens on the inbox, not in
 *     Settings.
 *  3. Sign out stops sitting one mis-tap away from Account on a phone. For a
 *     tool people use when their attention is already thin, that is a feature.
 *
 * Rejected: an avatar or initial. The header's menu trigger is ALREADY a
 * brand-gradient circle (#40 Phase 3.6), so a second circle beside it would read
 * as two menus, and an initial answers "who?" with one character when the owner
 * asked to see a name. Rejected: showing the email. Nothing in this app displays
 * an email (people.ts states the rule), a header is read over shoulders, and the
 * handle plus the provider already answer the only question being asked.
 *
 * The popover is the row-actions idiom (`ANCHORED_POSITIONER` + `popupSurface`),
 * not a second one: those primitives are what keep a popup from being clipped
 * past a viewport edge (#92), and this one is anchored to the rightmost text
 * control in the bar.
 */
export function AccountMenu({ identity }: { identity: AccountIdentity }) {
  const rootRef = useRef<HTMLDivElement>(null);

  // Names the ACCOUNT, and contains the visible handle so voice control can
  // address what it can see (WCAG 2.5.3, Label in Name).
  const triggerLabel = `Account: ${identity.label}`;
  // A pointer user gets the provider — and the untruncated handle — on hover,
  // without opening anything. Same convention as the theme toggle (#103).
  const triggerTitle = `Signed in as ${identity.label} (${identity.provider})`;

  return (
    <div ref={rootRef} className="relative">
      <Popover.Root>
        <Popover.Trigger
          aria-label={triggerLabel}
          title={triggerTitle}
          className={cn(
            "hover:bg-accent hover:text-primary gap-1 rounded-md px-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            touchTarget,
          )}
        >
          {/* Capped, not wrapped: a long label must not be able to widen the bar
              past the viewport. Tighter on a phone than on a desktop, because
              that is where the collisions are (#72, #103).

              #252 tightened the phone cap from `max-w-20` (80px) to `max-w-16`
              (64px), and the 16px is not cosmetic — it is the margin. Measured at
              360px, where the row has 328px of content width: three 44px icon
              controls, this trigger at its cap, the 44px menu trigger and four
              4px gaps come to 330px with an 80px cap and 314px with a 64px one.
              The first overflows; the second leaves 14px. The uncapped case is
              not the worst case, because `truncate` means the cap IS the width a
              long label renders at.

              Nothing is lost that was not already truncated: the popup below and
              the `title` above both carry the label in full, and above `sm` the
              cap is unchanged at 160px. */}
          <span className="max-w-16 truncate sm:max-w-40">
            {identity.label}
          </span>
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        </Popover.Trigger>
        <Popover.Portal container={rootRef}>
          <Popover.Positioner {...ANCHORED_POSITIONER}>
            <Popover.Popup
              // The dialog's accessible name (axe aria-dialog-name). There is a
              // visible handle inside, but naming the dialog after the account
              // would announce the handle twice — on the trigger and again on
              // the popup it opened.
              aria-label="Account"
              className={popupSurface("min-w-56 p-1 text-xs")}
            >
              <div className="px-3 py-2">
                {/* Uncapped and breakable here: this is the copy someone reads
                    when they are asking "is this the right account?", so it must
                    never be the truncated version. */}
                <p
                  data-account-label
                  className="text-foreground text-sm font-medium break-all"
                >
                  {identity.label}
                </p>
                {/* One pre-composed string — see identityLine() for why the
                    spaces are not JSX text. */}
                <p className="text-muted-foreground">
                  {identityLine(identity)}
                </p>
              </div>
              <div className="my-1 border-t" />
              {/* The deep link the header used to hold. The Account group itself
                  lands in #35 Phase C; until then this resolves to /settings and
                  the fragment is inert. */}
              <Link href="/settings#account" className={ENTRY}>
                Account settings
              </Link>
              {/* Logout is a state change → POST-only (CSRF-safe), so it stays a
                  form/button rather than becoming a link now that it lives in a
                  popup. See #21 (P5 batch B). */}
              <form action="/api/auth/logout" method="post" className="flex">
                <button type="submit" className={ENTRY}>
                  Sign out
                </button>
              </form>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
