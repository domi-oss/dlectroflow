"use client";

import { Zap } from "lucide-react";
import { useHyperFocus } from "@/lib/use-hyper-focus";
import { t, type Voice } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * #142 — the "hyper focus mode" switch, named in the UI exactly as the issue
 * names it.
 *
 * It lives on the /focus launcher rather than in Settings because the mode is
 * about *this* session's appetite, and the launcher is where you decide what
 * that appetite is. It is also the only surface where turning it back OFF is
 * reachable without first finishing something, which matters: the completion
 * screen can offer to turn it on, and an on-switch with no matching off-switch
 * in the same place you found it is a trap.
 *
 * `aria-pressed` on a plain button, matching the duration chips on the focus
 * timer's setup screen, so the whole app has one toggle idiom. The state is
 * spelled out in text ("on" / "off") as well as in the pressed state and the
 * tint — WCAG 1.4.1: colour is never the only carrier.
 */
export function HyperFocusToggle({ voice }: { voice: Voice }) {
  const [on, setOn] = useHyperFocus();

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-pressed={on}
        onClick={() => setOn(!on)}
        className={cn(
          "inline-flex min-h-[44px] w-fit items-center gap-2 rounded-full border px-4 text-sm font-semibold transition-colors",
          on
            ? // The same token pair the timer's selected duration chip uses;
              // designed to clear AA in both themes.
              "border-primary bg-accent text-accent-foreground"
            : "border-border text-foreground hover:bg-muted",
        )}
      >
        <Zap aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span>{t("focus.hyper.name", voice)}</span>
        <span className="text-muted-foreground font-normal">
          {t(on ? "focus.hyper.on" : "focus.hyper.off", voice)}
        </span>
      </button>
      <p className="text-muted-foreground text-xs">
        {t("focus.hyper.help", voice)}
      </p>
    </div>
  );
}
