"use client";

import { useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { TriangleAlert } from "lucide-react";
import { deleteOwnAccount } from "@/app/actions/account";
import { cn, touchTarget } from "@/lib/utils";

/**
 * #153 — delete your own account, from your own settings page.
 *
 * The machinery was already there and the entry point was not: `deleteAccount`
 * and the `revokedAt`/`purgeAfter` freeze both shipped, but the only control
 * that reached either of them was owner-gated (`revokePerson`). So an erasure
 * request was served by asking the owner to run it on your behalf — fine while
 * everyone knows each other, and not an answer to UK GDPR Art. 17 the moment
 * that stops being true.
 *
 * ── Why a real dialog, and not the panel's inline confirm ────────────────────
 *
 * Every other destructive control in Settings (Remove key, Disconnect, Revoke)
 * confirms with an inline row: a question and two buttons that replace the
 * trigger. That is the right weight for those, and the wrong weight for this
 * one. An inline row can be answered by the same click that opened it landing
 * one row lower, it does not stop the page underneath from being interacted
 * with, and it carries no way to require a second, different kind of act.
 *
 * `AlertDialog` from `@base-ui/react` — already a dependency, and the same
 * library the row-action popups use — brings the three properties that matter
 * and that a hand-rolled panel would have to re-earn: it is MODAL (the page
 * behind it is inert), it TRAPS AND RESTORES FOCUS (Escape and Cancel both
 * return you to the trigger, so a keyboard user is never dropped onto `<body>`),
 * and it is `role="alertdialog"`, which is what tells a screen reader this is
 * an interruption rather than a region that happened to appear. `confirm()`
 * would have satisfied "a confirmation step" and none of it — no styling, no
 * copy, and a string of unformatted text where a legally load-bearing
 * explanation needs to be.
 *
 * ── Two deliberate acts ──────────────────────────────────────────────────────
 *
 * Opening the dialog is the first; typing the word is the second. The typed
 * confirmation is not theatre — the cost of the accidental version of this is
 * somebody's account, and a dialog whose primary button is one Enter away from
 * the trigger that opened it is a dialog that gets dismissed by reflex. It is
 * matched case-insensitively after trimming, because a confirmation that fails
 * because the on-screen keyboard capitalised the first letter is a
 * confirmation that teaches people to distrust it.
 *
 * ── The copy ─────────────────────────────────────────────────────────────────
 *
 * Deliberately VOICE-NEUTRAL — no `t(key, voice)`. Settings speaks the app's
 * Plain/Playful voice everywhere else, and the Help page is already the
 * precedent for the exception: copy that is *about* the app rather than part of
 * it does not get a playful skin. A snack-themed sentence about erasing
 * somebody's data would be the single worst place in this product for one.
 *
 * And it is worded against what the app ACTUALLY DOES. `User.purgeAfter` is
 * written by `freezeAccount` and read by nothing — `prisma/scheduled-purge.ts`
 * sweeps guest workspaces and guest counters only — so the final deletion is a
 * hand operation today. /privacy has said exactly this since #123 ("Being
 * honest about a gap"), and this dialog says it too rather than quietly
 * upgrading a 30-day window into a promise of an automatic purge.
 */

/** Plain-language outcomes. An error the person cannot read is not a report. */
const ERROR_COPY = {
  owner_cannot_delete:
    "The instance owner’s account cannot be deleted here — it is the only account that can manage this instance.",
  not_signed_in: "You are no longer signed in. Reload the page and try again.",
} as const;

/** Anything the action threw rather than reported: a network drop, a 500. */
const REQUEST_FAILED =
  "That did not go through. Check your connection and try again.";

/**
 * The word that has to be typed. Lower case here because the comparison
 * lower-cases the input too — see the docblock on autocapitalisation.
 */
const CONFIRM_WORD = "delete";

export function DeleteAccount({
  isOwner,
  purgeGraceDays,
}: {
  /**
   * Resolved server-side from `currentUser()`. The action refuses the owner
   * itself — this only decides whether they are shown a control that could
   * never succeed, or the sentence explaining why there isn't one.
   */
  isOwner: boolean;
  /**
   * `PURGE_GRACE_DAYS` from `@/lib/account-lifecycle`, threaded as a prop
   * rather than imported: that module pulls in Prisma, which has no business in
   * a client bundle. Same reason `activeModelName` arrives as a prop.
   */
  purgeGraceDays: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fieldId = useId();
  // `HTMLDivElement` is required, not incidental. Review on !237 suggested
  // widening this to `HTMLElement` as the more defensive choice; it does not
  // compile. `AlertDialog.Popup` renders a div and types `initialFocus` as
  // `Ref<HTMLDivElement>`, and `RefObject` is invariant in its parameter, so the
  // WIDER type is the one TypeScript rejects — "Property 'align' is missing in
  // type 'HTMLElement'". Narrow it to whatever the popup actually renders.
  const popupRef = useRef<HTMLDivElement | null>(null);

  if (isOwner) {
    // The People panel's own wording for the mirror-image refusal, so the two
    // places that decline the same thing decline it in the same words.
    return (
      <p className="text-muted-foreground text-sm">
        This is you — the instance owner. Yours is the only account that can
        manage this instance, so it cannot be deleted from here; an instance
        with no owner has no way back through the UI. Shutting the whole thing
        down is a deployment question, not a settings one.
      </p>
    );
  }

  const confirmed = typed.trim().toLowerCase() === CONFIRM_WORD;

  const submit = () => {
    // Both guards live HERE rather than only on the button, because there are
    // two ways in and `disabled` only closes one of them. `pending` in
    // particular: a second delete started while the first is in flight arrives
    // after the session cookie has already gone, comes back `not_signed_in`,
    // and paints that error over a deletion that actually succeeded. Duo caught
    // the keyboard path on !237; keeping the condition in one place is what
    // stops the next call site reintroducing it.
    if (!confirmed || pending) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await deleteOwnAccount();
        if (!res.ok) {
          setError(ERROR_COPY[res.error]);
          return;
        }
        // A hard-ish exit, in two steps. `replace` rather than `push` so Back
        // cannot return to a settings page belonging to an account that no
        // longer exists, and `refresh` because the action deleted the session
        // cookie server-side: without it the client Router Cache can still hold
        // an RSC payload rendered for the signed-in account.
        router.replace("/");
        router.refresh();
      } catch {
        setError(REQUEST_FAILED);
      }
    });
  };

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reset on close, both ways out. Reopening must not find the word
        // already typed from the last time — that would silently collapse the
        // two deliberate acts back into one.
        if (!next) {
          setTyped("");
          setError(null);
        }
      }}
    >
      <AlertDialog.Trigger
        className={cn(
          "text-destructive rounded-md border px-3 py-2 text-sm font-medium",
          touchTarget,
        )}
      >
        Delete my account
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        {/* Not dismissible by clicking it — an alert dialog never is, which is
            the point of choosing one. It is here to dim and to cover, so it is
            inert and unlabelled. */}
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/50" />
        <AlertDialog.Popup
          ref={popupRef}
          tabIndex={-1}
          // Focus the POPUP, not the first tabbable control inside it. The
          // default would land on the text field, and a screen-reader user
          // arriving on an input hears the field's label — not the four
          // paragraphs above it explaining what they are about to lose, which
          // in this dialog are the entire reason it exists. From here, Tab
          // reaches the field, then Cancel, then the destructive button.
          initialFocus={popupRef}
          className={cn(
            "bg-background fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-md border p-4 shadow-md",
            // A long dialog on a 390×844 phone must scroll inside itself rather
            // than run off the bottom with its buttons out of reach.
            "max-h-[calc(100dvh-2rem)] space-y-3 overflow-y-auto",
          )}
        >
          <AlertDialog.Title className="text-base font-semibold">
            Delete your account?
          </AlertDialog.Title>

          {/* WCAG 1.4.1 — the destructive read must survive without colour.
              The WORD carries it; the icon is decorative and the red is
              decoration on top of both. */}
          <p className="flex items-start gap-2 text-sm font-medium">
            <TriangleAlert
              aria-hidden="true"
              className="text-destructive mt-0.5 h-4 w-4 shrink-0"
            />
            <span>
              Permanent from here. You cannot undo this yourself, and you will
              not be able to sign back in.
            </span>
          </p>

          <AlertDialog.Description className="sr-only">
            Deleting your account signs you out, ends your Google connection,
            and starts the retention window described below.
          </AlertDialog.Description>

          <div className="space-y-1">
            <h3 className="text-sm font-semibold">
              What happens straight away
            </h3>
            <ul className="text-muted-foreground ml-5 list-disc space-y-1 text-sm">
              <li>You are signed out, and you cannot sign back in.</li>
              {/* #126 — worded as the People panel and /privacy word it, and
                  for the same reason: the tokens stored here are always
                  deleted, but the revoke at Google's end is a request that can
                  be refused, so "asks" is the honest verb. */}
              <li>
                Your Google Tasks connection is removed here, and dlectroflow
                asks Google to revoke the grant. Nothing inside your Google
                account is deleted.
              </li>
            </ul>
          </div>

          <div className="space-y-1">
            <h3 className="text-sm font-semibold">
              What is kept, and for how long
            </h3>
            <ul className="text-muted-foreground ml-5 list-disc space-y-1 text-sm">
              {/* One JS string around the interpolation, deliberately: written
                  as JSX text, this Next version's transform eats the space at
                  the start of the line after `{purgeGraceDays}` and renders
                  "30days" in the production build while the jsdom suite shows
                  it intact. The People panel hit exactly this (see its
                  windowLabel note). */}
              <li>
                {`Your tasks, steps, notes and settings are kept for ${purgeGraceDays} days, so an accident can be undone — ask whoever runs this instance within that window. After that they are deleted. Being honest about a gap: that last step is done by hand today, not by a scheduled job.`}
              </li>
              <li>
                Your invitation stays on record. It is how your account got
                here, and it holds none of your content.
              </li>
              <li>
                Backups are deleted on their own schedule — the{" "}
                {/* No target="_blank", matching the legal footer's rule: the
                    dialog's state is disposable, so forcing a new tab only
                    takes the choice away. */}
                <Link
                  href="/privacy#retention"
                  className="hover:text-primary focus-visible:text-primary focus-visible:ring-ring rounded underline outline-none focus-visible:ring-2"
                >
                  Privacy Policy
                </Link>{" "}
                has the number.
              </li>
            </ul>
          </div>

          <div className="space-y-2">
            <label htmlFor={fieldId} className="block text-sm font-medium">
              {`Type ${CONFIRM_WORD} to confirm`}
            </label>
            <input
              id={fieldId}
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              // A confirmation word is not a name, an email or a password:
              // autofill, spellcheck and autocorrect can only get in its way.
              // `autoCapitalize` is off as well — the comparison lower-cases
              // anyway, but a field that visibly disagrees with the instruction
              // above it reads as broken.
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="border-input min-h-11 w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>

          {/* `role="alert"` rather than the panel's polite status region: this
              only ever appears in place of an account being deleted, which is
              not something to mention when the reader gets round to it. */}
          {error && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            {/* Cancel first in the DOM, so Tab reaches the way out before the
                way through. */}
            <AlertDialog.Close
              className={cn("rounded-md border px-3 py-2 text-sm", touchTarget)}
            >
              Cancel
            </AlertDialog.Close>
            {/* NOT an AlertDialog.Close: closing on click would tear the dialog
                down before the action resolves, taking the error message with
                it. The dialog closes when the navigation happens instead. */}
            <button
              type="button"
              disabled={!confirmed || pending}
              onClick={submit}
              className={cn(
                "bg-destructive text-destructive-foreground rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50",
                touchTarget,
              )}
            >
              {pending ? "Deleting…" : "Delete my account"}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
