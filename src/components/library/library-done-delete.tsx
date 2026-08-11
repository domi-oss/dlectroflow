"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn, touchTarget } from "@/lib/utils";
import { deleteBrainDumpItem } from "@/app/actions/braindump";
import { t, type Voice } from "@/lib/strings";

/**
 * The Done panel's heading — `library/page.tsx` renders it as the section's
 * `aria-labelledby` target and this component hands focus to it.
 *
 * Exported and shared rather than written twice, because the two halves are
 * load-bearing for each other: the heading needs `tabIndex={-1}` or it cannot
 * receive the hand-off at all, and this component needs the id to find it.
 * `library.test.tsx` asserts the page renders both, so dropping either one fails
 * a test rather than silently returning focus to `<body>`.
 */
export const LIB_PANEL_HEADING_ID = "lib-panel-heading";

/**
 * Delete, and only delete, for a row in the Library hub's Done tab (#251).
 *
 * ── Why not just render `<LibraryRows>` here ────────────────────────────────
 *
 * That was the obvious move — `plated`/`pantry` already use it and it carries a
 * delete. But it also carries **▶ Start focusing, ✓ Complete, an inline estimate
 * editor, an editable task note, a row number, an age label and select mode**,
 * and every one of those is meaningless on a closed to-do: there is nothing left
 * to focus, nothing to complete, and no estimate worth revising. Its `tab` prop
 * is typed `"plated" | "pantry"` precisely because those affordances are tied to
 * an in-flight row. So the narrow control goes in and the row stays the closure
 * view it is — one new affordance rather than eight, seven of which would then
 * need suppressing.
 *
 * That also keeps `LibraryRow` a **server** component. The Done tab renders the
 * whole pile uncapped, and turning every row into a client component to reach one
 * button would ship the row's markup twice for every finished to-do the user has.
 *
 * ── Two-step confirm, matching every other delete in the app ────────────────
 *
 * The first press arms; only the confirming press writes. Copied in shape from
 * `library-rows.tsx` and the Inbox's own `deleteControl` — not shared with them
 * because both of those close over a list-wide `confirmDeleteId` (they render the
 * same control twice per row, inline and in the ▾ menu, and keep the two in sync).
 * There is one control per row here and no menu, so the state is local and the
 * coupling is not worth buying.
 *
 * A completed to-do is the row a user is least likely to want back by accident
 * and least able to re-derive — the steps, the note and the estimate go with it
 * — so the confirm is not ceremony.
 *
 * ── Focus ───────────────────────────────────────────────────────────────────
 *
 * A confirmed delete withdraws the control that was pressed (the confirming
 * button unmounts with the state change below) and then the row itself, when the
 * refresh lands. Either is enough for the browser to put focus on `<body>`, which
 * is a WCAG 2.4.3 fault: a keyboard or screen-reader user is returned to the top
 * of the document with no announcement that anything happened.
 *
 * Focus goes to the panel heading, which survives both. It is the section's
 * accessible name, so a screen-reader user lands on the description of the panel
 * the row was just removed from rather than on nothing — and it is a `<p>` with
 * `tabIndex={-1}`, so it takes the hand-off without entering the tab order.
 *
 * **Repair, never steal.** The move is gated on focus having actually been lost:
 * a user who moved to the tab strip or another row while the write was in flight
 * stays where they are. Collapsing that condition is what made the Inbox's own
 * notice hand-off grabby before !306 (`inbox-view.tsx` carries the argument).
 *
 * No in-flight affordance, deliberately: the confirm has already collapsed and
 * the row is about to be removed, so there is nothing left for a spinner to sit
 * on, and a second press is a no-op the server action guards (`deleteMany`
 * matches nothing the second time — see `deleteBrainDumpItem`).
 */
export function LibraryDoneDelete({ id, voice }: { id: string; voice: Voice }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  const confirm = () => {
    setConfirming(false);
    startTransition(async () => {
      await deleteBrainDumpItem(id);
      // The hub re-reads live data on refresh; the action revalidates the routes
      // it knows about, not whichever one this press came from.
      router.refresh();
      if (document.activeElement === document.body)
        document.getElementById(LIB_PANEL_HEADING_ID)?.focus();
    });
  };

  if (confirming) {
    return (
      <span className="flex items-center gap-2">
        <button
          type="button"
          className={cn(
            touchTarget,
            "text-destructive rounded-md px-2.5 py-1 font-medium",
          )}
          onClick={confirm}
        >
          {t("action.delete", voice)}
        </button>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <button
          type="button"
          className={cn(
            touchTarget,
            "text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1",
          )}
          onClick={() => setConfirming(false)}
        >
          {t("action.cancel", voice)}
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      // The visible label is a glyph, so the `aria-label` is the whole
      // accessible name and `title` is the pointer user's half of the same fact
      // — the treatment the Inbox's end-cluster icons already use.
      aria-label={t("action.delete", voice)}
      title={t("action.delete", voice)}
      className={cn(
        touchTarget,
        "text-muted-foreground hover:bg-accent hover:text-destructive rounded-md px-2 py-1 text-sm",
      )}
      onClick={() => setConfirming(true)}
    >
      🗑
    </button>
  );
}
