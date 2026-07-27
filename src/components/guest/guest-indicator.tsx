"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { t, type Voice } from "@/lib/strings";

const DISMISS_KEY = "df-guest-banner";

// #23 — the dismissal lives in sessionStorage, so read it as an external store
// instead of copying it into state from a mount effect
// (react-hooks/set-state-in-effect). sessionStorage emits no event of its own,
// so dismiss() notifies these listeners directly. There is deliberately no
// "storage" listener: each tab has its OWN sessionStorage area, so there is
// nothing to sync across tabs (Duo review, !160).
const dismissListeners = new Set<() => void>();

/** Exported for the teardown test — the component subscribes via
 *  useSyncExternalStore, which needs a stable module-level function. */
export function subscribeDismissed(listener: () => void): () => void {
  dismissListeners.add(listener);
  return () => {
    dismissListeners.delete(listener);
  };
}

// Fallback for browsers that block storage outright (Safari private mode):
// reading or writing sessionStorage throws there, and an unguarded read used to
// take the whole app layout down for guests. Remember the dismissal in memory
// instead — ✕ still works, it just won't survive a page load.
let dismissedInMemory = false;

/** True once this browser session has dismissed the banner. */
function getDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return dismissedInMemory;
  }
}

/** Server / pre-hydration snapshot — collapsed, so the banner can't flash in
 *  and out for a guest who already dismissed it. */
function getServerDismissed(): boolean {
  return true;
}

// #73 — owner-authored copy, deliberately NOT voice-aware: the same wording
// persists across plain and playful. Only the breakdown allowance is
// interpolated, from the live `quota` prop, so it can't drift from the enforced
// cap. (The "New here?" nudge below it keeps #11's voice-aware strings.)
const bannerText = (quota: number) =>
  `👋 You're in guest mode - a private sandbox just for this browser session, ` +
  `where you get ${quota} AI assisted task breakdowns on a fast model, visual ` +
  `focus timer with lofi music, streaks and activity rewards, and one-click ` +
  `calendar export via .ics - account owners get access to Google Tasks sync, ` +
  `and further customisations.`;

const SELF_HOST =
  "Want it permanent? dlectroflow is open source (AGPL) — self-host it and bring your own LLM key.";

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
  const persistedDismissed = useSyncExternalStore(
    subscribeDismissed,
    getDismissed,
    getServerDismissed,
  );
  // Clicking the collapsed pill re-opens the banner for this page view only —
  // the dismissal stays recorded, so the next mount is collapsed again.
  const [reopened, setReopened] = useState(false);
  const dismissed = persistedDismissed && !reopened;
  const left = useCountdown(expiresAt);

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      dismissedInMemory = true;
    }
    setReopened(false);
    dismissListeners.forEach((listener) => listener());
  };

  // #73 — amber-800 alone lands at 2.44:1 on the dark page background, so both
  // states pair it with the AA-tuned dark tier already used by the aging rows
  // (inbox-view) and status-pill.
  if (!dismissed) {
    return (
      <div className="border-b bg-amber-500/10 px-4 py-2 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
        <div className="mx-auto flex max-w-3xl items-start gap-3">
          <div className="flex-1 space-y-1">
            <p>{bannerText(quota)}</p>
            <p>{SELF_HOST}</p>
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
      onClick={() => setReopened(true)}
      title="Guest mode — click for details"
      className="border-b bg-amber-500/5 px-4 py-1 text-xs text-amber-800 hover:bg-amber-500/10 dark:bg-amber-950/10 dark:text-amber-300 dark:hover:bg-amber-950/20"
    >
      <span className="mx-auto flex max-w-3xl items-center gap-3">
        🎫 Guest · ⚡ {remaining}/{quota} breakdowns · ⏳ {left} left
      </span>
    </button>
  );
}
