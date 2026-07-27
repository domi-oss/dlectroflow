"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { t, type Voice } from "@/lib/strings";

function useCountdown(expiresAtIso: string): string {
  const [label, setLabel] = useState("");
  useEffect(() => {
    const tick = () => {
      const ms = new Date(expiresAtIso).getTime() - Date.now();
      if (ms <= 0) return setLabel("expiring…");
      const h = Math.floor(ms / 3600_000);
      const m = Math.floor((ms % 3600_000) / 60_000);
      setLabel(h > 0 ? `${h}h ${m}m` : `${m}m`);
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [expiresAtIso]);
  return label;
}

export function GuestIndicator({
  remaining,
  quota,
  expiresAt,
  voice,
}: {
  remaining: number;
  quota: number;
  expiresAt: string;
  voice: Voice;
}) {
  const [dismissed, setDismissed] = useState(true); // start collapsed to avoid flash
  const left = useCountdown(expiresAt);

  useEffect(() => {
    setDismissed(sessionStorage.getItem("df-guest-banner") === "1");
  }, []);

  const dismiss = () => {
    sessionStorage.setItem("df-guest-banner", "1");
    setDismissed(true);
  };

  // #73 — amber-800 alone lands at 2.44:1 on the dark page background, so both
  // states pair it with the AA-tuned dark tier already used by the aging rows
  // (inbox-view) and status-pill.
  if (!dismissed) {
    return (
      <div className="border-b bg-amber-500/10 px-4 py-2 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
        <div className="mx-auto flex max-w-3xl items-start gap-3">
          <div className="flex-1 space-y-1">
            <p>{t("guest.bannerIntro", voice)}</p>
            <p>{t("guest.bannerPerksLead", voice)}</p>
            <ul className="ml-5 list-disc">
              <li>
                {quota} {t("guest.perkBreakdowns", voice)}
              </li>
              <li>{t("guest.perkFocus", voice)}</li>
              <li>{t("guest.perkRewards", voice)}</li>
              <li>{t("guest.perkExport", voice)}</li>
            </ul>
            <p>{t("guest.bannerOwnerOnly", voice)}</p>
            <p>{t("guest.bannerSelfHost", voice)}</p>
            {/* #11 — onboarding nudge to the in-app /help docs (voice-aware). */}
            <p>
              <span className="font-medium">{t("guest.newHere", voice)}</span>{" "}
              <Link href="/help" className="font-medium underline">
                {t("guest.helpCta", voice)}
              </Link>
            </p>
          </div>
          {/* #73 — 44×44 hit box (WCAG 2.2 target size); the glyph itself is
              only ~11×20px, and on mobile dismissing is the first thing a
              guest reaches for. `-my-2 -mr-2` keeps the banner from growing. */}
          <button
            onClick={dismiss}
            aria-label="Dismiss"
            className="-my-2 -mr-2 flex h-11 w-11 shrink-0 items-center justify-center font-medium"
          >
            ✕
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={() => setDismissed(false)}
      title="Guest mode — click for details"
      className="border-b bg-amber-500/5 px-4 py-1 text-xs text-amber-800 hover:bg-amber-500/10 dark:bg-amber-950/10 dark:text-amber-300 dark:hover:bg-amber-950/20"
    >
      <span className="mx-auto flex max-w-3xl items-center gap-3">
        🎫 Guest · ⚡ {remaining}/{quota} breakdowns · ⏳ {left} left
      </span>
    </button>
  );
}
