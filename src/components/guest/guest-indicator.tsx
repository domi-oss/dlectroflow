"use client";

import { useEffect, useState } from "react";

const BANNER =
  "👋 You're in guest mode — a private sandbox just for this browser session. You get 5 AI-powered task breakdowns per session (on a speedy model), plus the focus timer, rewards, and one-click calendar export — all yours. Live integrations (Google Tasks) are owner-only for now. Self-hosted option and BYOK coming soon.";

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
}: {
  remaining: number;
  quota: number;
  expiresAt: string;
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

  if (!dismissed) {
    return (
      <div className="border-b bg-amber-500/10 px-4 py-2 text-sm text-amber-800">
        <div className="mx-auto flex max-w-3xl items-start gap-3">
          <p className="flex-1">{BANNER}</p>
          <button
            onClick={dismiss}
            aria-label="Dismiss"
            className="shrink-0 font-medium"
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
      className="border-b bg-amber-500/5 px-4 py-1 text-xs text-amber-800 hover:bg-amber-500/10"
    >
      <span className="mx-auto flex max-w-3xl items-center gap-3">
        🎫 Guest · ⚡ {remaining}/{quota} breakdowns · ⏳ {left} left
      </span>
    </button>
  );
}
