"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { t, type Voice } from "@/lib/strings";
import { cn } from "@/lib/utils";

const DESTINATIONS = [
  { key: "nav.inbox", href: "/inbox" },
  { key: "nav.focusTimer", href: "/focus" },
  { key: "nav.everything", href: "/library" },
  { key: "nav.dashboard", href: "/dashboard" },
  { key: "nav.settings", href: "/settings" },
  { key: "nav.help", href: "/help" },
] as const;

export function AppMenu({ voice }: { voice: Voice }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on route change.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
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
        onClick={() => setOpen((v) => !v)}
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
                className={cn(
                  "flex min-h-[44px] items-center px-4 py-2 text-sm outline-none hover:bg-muted hover:text-primary focus-visible:bg-muted focus-visible:text-primary",
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
