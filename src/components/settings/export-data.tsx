"use client";

import { useId, useState } from "react";
import { Download } from "lucide-react";
import { downloadBlob } from "@/lib/download-file";
import { cn, touchTarget } from "@/lib/utils";

/**
 * #129 — download everything in this account, from the account's own settings.
 *
 * ## Why this is an anchor and not a button
 *
 * `/api/export` is a real GET that returns a real file with a real
 * `Content-Disposition`, so an `<a href>` is what it is: with JavaScript off, or
 * before hydration, or if this component throws, the link still works and the
 * browser still downloads the archive. A `<button>` would have made the feature
 * depend on a bundle loading, for a feature whose entire purpose is that somebody
 * can get their data out.
 *
 * The click handler is therefore an ENHANCEMENT rather than the mechanism. It
 * exists for one reason the plain navigation cannot serve: the endpoint can answer
 * 429 (an export was already prepared moments ago) or 401 (the session lapsed
 * while the page sat open), and a plain anchor with `download` shows the reader
 * either nothing at all or a text file containing an error message. Fetching lets
 * those become a sentence next to the control.
 *
 * ## Accessibility
 *
 * - **Keyboard reachable by construction** — it is a link with an href, so it is
 *   in the tab order without `tabIndex`, and Enter activates it.
 * - **The focus indicator is a RING, not a background change** (WCAG 1.4.11 /
 *   2.4.7): `focus-visible:ring-2` draws a visible outline that survives forced
 *   colours and does not rely on hue. Several controls in this app were fixed for
 *   exactly this in #109/#117, so it is not repeated here by accident.
 * - **The accessible name is the visible text**, and it says what the thing is —
 *   "Download my data (.zip)". The icon is `aria-hidden`, so a screen reader is
 *   not told about a decorative glyph.
 * - **Progress and errors are announced**: one `role="status"` region with
 *   `aria-live="polite"` for "Preparing…", and `role="alert"` for a failure, which
 *   is the pair the rest of Settings uses (see `account-panel.tsx`). The button is
 *   `aria-describedby` the status region, so the message is associated with the
 *   control rather than merely near it.
 * - **`aria-busy`** while the request is in flight, together with the live region,
 *   so progress is exposed WITHOUT the control's accessible name changing under
 *   somebody who is navigating by it.
 *
 * The copy is voice-neutral — no `t(key, voice)`. Same rule `delete-account.tsx`
 * states: copy that is *about* the app rather than part of it does not get a
 * playful skin, and "here is everything we hold about you" is squarely that.
 */

/** Fallback filename, used only if the response carries no Content-Disposition
 *  (which cannot happen through our own route — but a proxy can strip a header,
 *  and a download called "download" is better than one called "undefined"). */
const FALLBACK_FILENAME = "dlectroflow-export.zip";

const GENERIC_FAILURE =
  "That did not go through. Check your connection and try again.";

/** Pull the server's filename out of `Content-Disposition`. Only the plain
 *  `filename="…"` form is handled, because that is the only form our route emits
 *  (the name is an ASCII slug — see `src/lib/export/bundle.ts`). */
function filenameFromDisposition(header: string | null): string {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? FALLBACK_FILENAME;
}

export function ExportData() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const statusId = useId();

  const run = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    // Let a modified click (new tab, save-as) do what the person asked, and let
    // the plain navigation happen if anything about this handler is unavailable.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    if (pending) return;
    setError(null);
    setDone(false);
    setPending(true);
    try {
      const res = await fetch("/api/export", {
        // `same-origin` credentials are the default, but stated: the route
        // authorises from the session cookie and nothing else.
        credentials: "same-origin",
        headers: { Accept: "application/zip" },
      });
      if (res.status === 429) {
        const retry = Number(res.headers.get("Retry-After") ?? 60);
        setError(
          `An export was prepared for this account moments ago. Try again in ${Number.isFinite(retry) ? retry : 60} seconds.`,
        );
        return;
      }
      if (res.status === 401) {
        setError("You are no longer signed in. Reload the page and try again.");
        return;
      }
      if (!res.ok) {
        setError(GENERIC_FAILURE);
        return;
      }
      downloadBlob(
        await res.blob(),
        filenameFromDisposition(res.headers.get("Content-Disposition")),
      );
      setDone(true);
    } catch {
      setError(GENERIC_FAILURE);
    } finally {
      setPending(false);
    }
  };

  const status = pending
    ? "Preparing your archive…"
    : done
      ? "Downloaded. Check your browser’s downloads."
      : "";

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-sm">
        A single .zip with everything in this account: your tasks and their
        steps, your brain-dump inbox, the coaching conversations, your settings,
        and your scheduled work as a calendar file. It includes a README
        explaining each file and what is deliberately not in it — your Google
        connection and any API key you have stored are never exported.
      </p>

      <a
        href="/api/export"
        // Kept even though the handler intercepts: with the handler bypassed the
        // browser must still name the file, and this is what a middle-click or a
        // "Save link as" uses.
        download
        onClick={run}
        aria-describedby={statusId}
        aria-busy={pending}
        className={cn(
          "rounded-md border px-3 py-2 text-sm font-medium",
          // WCAG 2.4.7 — a RING, not a background-colour change, so the focus
          // indicator survives forced-colours mode and does not rely on hue.
          "focus-visible:ring-ring outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
          "gap-2",
          touchTarget,
          pending && "opacity-70",
        )}
      >
        <Download aria-hidden="true" className="h-4 w-4 shrink-0" />
        {/* The label does NOT change while the request is in flight. A control
            whose accessible name mutates under the reader is disorienting for
            anyone navigating by name, and progress is already carried properly by
            `aria-busy` and the live region below. */}
        Download my data (.zip)
      </a>

      {/* Polite: progress and success are worth announcing when the reader gets
          to them, and must not interrupt. `min-h-5` reserves the line so the
          layout does not jump when it fills. */}
      <p
        role="status"
        id={statusId}
        aria-live="polite"
        className="text-muted-foreground min-h-5 text-sm"
      >
        {status}
      </p>

      {/* Assertive, and a separate element: a failure means the person did not
          get their data, which is not something to mention in passing. */}
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
