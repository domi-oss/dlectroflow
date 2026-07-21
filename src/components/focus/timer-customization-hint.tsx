import Link from "next/link";
import { t, type Voice } from "@/lib/strings";

/**
 * One-time, dismissible nudge that customization options exist (spec Design B).
 * Gated by focusTimerTipDismissedAt: the parent renders it only when unset, and
 * both the ✕ and tapping through to /settings call onDismiss (which fires
 * dismissFocusTimerTip). The ✕ carries a text accessible name (action.dismiss).
 */
export function TimerCustomizationHint({
  voice,
  onDismiss,
}: {
  voice: Voice;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-50 p-3 text-sm dark:bg-amber-950/20">
      <p className="flex-1">
        {t("focus.tip.body", voice)}{" "}
        <Link href="/settings" onClick={onDismiss} className="font-medium underline">
          {t("focus.tip.cta", voice)}
        </Link>
      </p>
      <button
        type="button"
        aria-label={t("action.dismiss", voice)}
        title={t("action.dismiss", voice)}
        onClick={onDismiss}
        className="hover:bg-accent inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md"
      >
        ✕
      </button>
    </div>
  );
}
