"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { dismissWelcome, updateVoice } from "@/app/actions/settings";
import { t, type Voice } from "@/lib/strings";
import { BrandMark } from "@/components/brand/brand-mark";

// Inline links sit inside the welcome sentences — underline so they read as
// links in running prose (not colour-only). Brand-coloured via --primary (AA
// text magenta on the card) for the first-run brand moment (#40 Phase 3.5).
const welcomeLinkClass =
  "text-primary underline underline-offset-2 hover:opacity-80";

/** Phase 5 (#8) — first-run welcome card shown above the capture box until
 * the workspace dismisses it. Lets a brand-new user pick their voice, learn
 * how the app works, and dismiss without leaving the Inbox. */
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
      {/* First-run brand moment (#40 Phase 3.5): the app-icon mark + a subtle
          gradient accent hairline — warm and encouraging, not overstimulating. */}
      <div className="mb-3 flex items-center gap-2">
        <BrandMark
          className="h-7 w-7 shrink-0"
          gradientId="df-brand-mark-welcome"
        />
        <span
          aria-hidden="true"
          className="h-1 w-16 rounded-full [background-image:var(--gradient-brand)]"
        />
      </div>
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
              className={
                "px-3 py-1 text-sm first:rounded-l-md last:rounded-r-md transition-colors disabled:opacity-50 " +
                (voice === v
                  ? "bg-primary text-primary-foreground font-medium"
                  : "bg-background text-muted-foreground hover:text-foreground")
              }
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
          className="hover:bg-accent rounded-md border px-3 py-1"
        >
          {t("welcome.dismiss", voice)}
        </button>
      </div>
    </section>
  );
}
