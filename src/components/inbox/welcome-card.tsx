"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { dismissWelcome, updateVoice } from "@/app/actions/settings";
import { t, type Voice } from "@/lib/strings";
import { cn, touchTarget } from "@/lib/utils";

// Inline links sit inside the welcome sentences — underline so they read as
// links in running prose (not colour-only). Brand-coloured via --primary (AA
// text magenta on the card) for the first-run brand moment (#40 Phase 3.5).
//
// #205 — these three stay UNSIZED, deliberately. They are links inside a
// sentence, which is the case both target-size criteria carve an explicit inline
// exception for, and squaring them to 44px would break the line box of the
// paragraph they read as part of. The card's three BUTTONS below are the
// controls, and they get the floor.
const welcomeLinkClass =
  "text-primary underline underline-offset-2 hover:opacity-80";

/** Phase 5 (#8) — first-run welcome card shown above the capture box until
 * the workspace dismisses it. Lets a brand-new user pick their voice, learn
 * how the app works, and dismiss without leaving the Inbox.
 *
 * #205 (folded into #253) — all three buttons carry `touchTarget`. This was one
 * of two files that audit found with **zero** `touchTarget` in it, and it is the
 * worst of the set to leave short: on first run these three are the only
 * controls on the screen bar the capture box, and the user meeting them has
 * never seen the app before.
 *
 * 44x44 is **2.5.5 Target Size (Enhanced), AAA** — **2.5.8 (Minimum) is the AA
 * one and asks for 24x24**, which `py-1` already met. So this is the app
 * exceeding its own AA bar on purpose, a house convention rather than a
 * conformance fix; calling it "2.5.8" would make a voluntary 44px read as
 * mandatory, which is the error `breakdown/note-field.tsx` records having had to
 * undo. The product reason is #184's: mostly-phone use by people with ADHD,
 * where a mis-tap costs the thread you were holding. */
export function WelcomeCard({ voice }: { voice: Voice }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const setVoice = (v: Voice) =>
    start(async () => {
      await updateVoice(v);
      router.refresh();
    });

  const dismiss = () =>
    start(async () => {
      await dismissWelcome();
      router.refresh();
    });

  return (
    <section
      aria-label="Welcome"
      className="border-primary/20 bg-card rounded-xl border p-4"
    >
      {/* First-run brand moment (#40 Phase 3.5): a subtle gradient accent
          hairline — warm and encouraging, not overstimulating. The app icon
          lives in the header; repeating it here was superfluous (owner call). */}
      <div
        aria-hidden="true"
        className="mb-3 h-1 w-16 rounded-full [background-image:var(--gradient-brand)]"
      />
      {/* Body copy with the Focus Timer / Library / Help links embedded INLINE
       * in the sentences (owner direction). The 👋 greeting opens the body — the
       * separate title heading was dropped. Composed from welcome.* fragments so
       * the copy stays voice-aware in strings.ts. */}
      <p className="text-muted-foreground text-sm">
        {t("welcome.lead", voice)}
        <Link href="/focus" className={welcomeLinkClass}>
          {t("welcome.focusLink", voice)}
        </Link>
        {t("welcome.afterFocus", voice)}
        <Link href="/library" className={welcomeLinkClass}>
          {t("welcome.libraryLink", voice)}
        </Link>
        {t("welcome.afterLibrary", voice)}
        <Link href="/help" className={welcomeLinkClass}>
          {t("welcome.helpLink", voice)}
        </Link>
        {t("welcome.afterHelp", voice)}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <div
          className="inline-flex rounded-md border"
          role="group"
          aria-label="Voice preference"
        >
          {(["plain", "playful"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={voice === v}
              disabled={pending}
              onClick={() => setVoice(v)}
              // #205 — the 44px floor goes on each BUTTON, not on the bordered
              // group around them: sizing the group would leave a 24px hit area
              // centred in a 44px box, which is the shape that makes a
              // target-size fix look done and still measure wrong.
              className={cn(
                touchTarget,
                "px-3 py-1 text-sm first:rounded-l-md last:rounded-r-md transition-colors disabled:opacity-50",
                voice === v
                  ? "bg-primary text-primary-foreground font-medium"
                  : "bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              {v === "plain" ? "Plain" : "Playful"}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button
          type="button"
          onClick={dismiss}
          disabled={pending}
          className={cn(
            touchTarget,
            "hover:bg-accent rounded-md border px-3 py-1",
          )}
        >
          {t("welcome.dismiss", voice)}
        </button>
      </div>
    </section>
  );
}
