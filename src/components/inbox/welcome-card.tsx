"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { dismissWelcome, updateVoice } from "@/app/actions/settings";
import { t, type Voice } from "@/lib/strings";

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
      className="rounded-xl border border-green-700/40 bg-green-50 p-4 dark:bg-green-950/20"
    >
      <h2 className="text-sm font-semibold">{t("welcome.title", voice)}</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        {t("welcome.body", voice)}
      </p>
      {/* Quick links — speak the same section vocabulary as the ☰ menu:
       * nav.everything → /library, nav.focusTimer → /focus, plus Help. */}
      <nav
        aria-label="Where to next"
        className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
      >
        <Link
          href="/library"
          className="text-green-800 hover:underline dark:text-green-300"
        >
          {t("nav.everything", voice)}
        </Link>
        <Link
          href="/focus"
          className="text-green-800 hover:underline dark:text-green-300"
        >
          {t("nav.focusTimer", voice)}
        </Link>
        <Link
          href="/help"
          className="text-green-800 hover:underline dark:text-green-300"
        >
          {t("welcome.help", voice)}
        </Link>
      </nav>
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
