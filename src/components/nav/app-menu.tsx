"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { t, type Voice } from "@/lib/strings";
import { cn } from "@/lib/utils";

const DESTINATIONS = [
  { key: "nav.inbox", href: "/" },
  { key: "nav.focusTimer", href: "/focus" },
  { key: "nav.everything", href: "/library" },
  { key: "nav.dashboard", href: "/dashboard" },
  { key: "nav.settings", href: "/settings" },
  { key: "nav.help", href: "/help" },
] as const;

export function AppMenu({ voice }: { voice: Voice }) {
  const pathname = usePathname();
  const menuRef = useRef<HTMLDivElement>(null);

  // #23 — "open" is stored as *the route the menu was opened on*, so closing on
  // navigation is derived during render instead of synced by an effect that
  // called setOpen(false) on every pathname change (react-hooks/
  // set-state-in-effect: that effect re-rendered the whole header twice per
  // navigation). Same behaviour: the popover never survives a route change, and
  // re-opening on the new route works because the key is the *current* path.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt !== null && openedAt === pathname;

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenedAt(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="relative" ref={menuRef}>
      {/* #40 Phase 3.6 — the menu trigger is a brand gradient avatar. The
          hamburger is an SVG (non-text) so it never trips the color-contrast
          gate; the accessible name stays the "Menu" aria-label. */}
      <button
        type="button"
        aria-label="Menu"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpenedAt(open ? null : pathname)}
        className="flex h-11 w-11 items-center justify-center rounded-full text-white outline-none [background-image:var(--gradient-brand)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="h-5 w-5"
        >
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
        </svg>
      </button>
      {open && (
        <nav
          aria-label="Main"
          className="absolute right-0 top-full z-10 flex min-w-[10rem] flex-col rounded-md border bg-background py-1 shadow-md"
        >
          {DESTINATIONS.map(({ key, href }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                // #117 — the focus indicator is an INSET RING, not just the
                // background swap this used to rely on. WCAG 2.4.11 Focus
                // Appearance is AA in WCAG 2.2 and axe does not implement it, so
                // nothing in the suite was ever going to catch this: --muted
                // against --background is 1.07:1 in light and 1.17:1 in dark,
                // against the 3:1 an indicator needs. --ring reads 5.09:1 on the
                // popup surface and 4.75:1 on the focused --muted in light,
                // 8.83:1 / 7.55:1 in dark — clear of 3:1 against BOTH adjacent
                // colours in both themes. Inset because these entries are flush
                // to the popup's edge; an outset ring would sit outside the
                // border. The background swap stays: it is the hover affordance,
                // and losing it would be a redesign. Kept identical to
                // account-menu.tsx's entries, which open inches away.
                className={cn(
                  "flex min-h-[44px] items-center px-4 py-2 text-sm outline-none hover:bg-muted hover:text-primary focus-visible:bg-muted focus-visible:text-primary focus-visible:inset-ring-2 focus-visible:inset-ring-ring",
                  active && "text-primary font-medium",
                )}
              >
                {t(key, voice)}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
