"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { t, type Voice } from "@/lib/strings";

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
      <button
        type="button"
        aria-label="Menu"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className="flex h-11 w-11 items-center justify-center text-xl leading-none"
      >
        ☰
      </button>
      {open && (
        <nav
          aria-label="Main"
          className="absolute right-0 top-full z-10 flex min-w-[10rem] flex-col rounded-md border bg-background py-1 shadow-md"
        >
          {DESTINATIONS.map(({ key, href }) => (
            <Link
              key={href}
              href={href}
              className="flex min-h-[44px] items-center px-4 py-2 text-sm hover:bg-muted"
            >
              {t(key, voice)}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
