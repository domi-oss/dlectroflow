"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { disconnectGoogleTasks } from "@/app/actions/google-schedule";
import { t, type Voice } from "@/lib/strings";
import { CollapsibleSection } from "@/components/nav/collapsible-section";
import { GoogleAccountHint } from "@/components/integrations/google-account-hint";
import { cn, touchTarget } from "@/lib/utils";

type GoogleStatus = {
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
};

// Shared copy so the panel and the signed-out shell never drift.
const GOOGLE_NAME = "Google Tasks";
// #118 Phase C — "your own", not the instance's. A member reading about "the
// owner's Google account" would reasonably assume Disconnect affects somebody
// else's connection, which is the opposite of true: the credential is keyed on
// the acting user, so this card is only ever about the reader's own connection.
const GOOGLE_DESCRIPTION =
  "Schedule your steps and tasks into your own Google Tasks — a Reclaim-synced list is scheduled automatically.";

/** Descriptor list = the extension point: future integrations add an entry here. */
function googleDescriptor(g: GoogleStatus) {
  const pill = !g.configured
    ? { label: "Not configured", tone: "muted" as const }
    : g.needsReconnect
      ? { label: "Reconnect needed", tone: "warn" as const }
      : g.connected
        ? { label: "Connected", tone: "ok" as const }
        : { label: "Not connected", tone: "muted" as const };
  return {
    id: "google",
    name: GOOGLE_NAME,
    description: GOOGLE_DESCRIPTION,
    pill,
    connectHref:
      g.configured && !g.connected ? "/api/google/oauth/start" : null,
    connectLabel: g.needsReconnect ? "Reconnect Google →" : "Connect Google →",
    canDisconnect: g.connected,
  };
}

export function IntegrationsPanel({
  google,
  readOnly = false,
  voice = "plain",
  defaultExpanded,
}: {
  /** The ACTING account's own status (#118). `null` in the signed-out read-only
   *  shell, where no status is fetched at all. */
  google: GoogleStatus | null;
  /** #11 — signed-out read-only presentation: show the shell, never real
   *  status. #118 changed WHO gets it (a caller with no account, not any
   *  non-owner), not what it withholds. */
  readOnly?: boolean;
  voice?: Voice;
  defaultExpanded?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  // #126 — set when the disconnect completed here but Google did not accept the
  // revoke. Not an error state: the tokens are gone. It is the one step left,
  // and it is the account holder's to take.
  const [grantUnrevoked, setGrantUnrevoked] = useState(false);
  const [pending, startTransition] = useTransition();
  // Stable id so the destructive button can point at the confirmation question
  // it is answering (aria-describedby) rather than merely sitting beside it.
  const confirmId = useId();
  // #128 — same treatment for the "which Google account" hint: the Connect
  // link is described by it, not merely followed by it.
  const accountHintId = useId();
  // Focus must not fall to <body> when the confirmation row unmounts — the
  // control that had focus is gone, and a keyboard user is left with no position
  // on the page and a Tab that restarts from the top. Returning focus to
  // Disconnect is the standard "dismissing returns you to the trigger"
  // behaviour, and it covers both exits (Cancel, and a completed disconnect).
  const disconnectRef = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!confirming && returnFocus.current) {
      returnFocus.current = false;
      disconnectRef.current?.focus();
    }
  }, [confirming]);

  // Signed-out view: a disabled shell so a visitor can see the integration
  // EXISTS, labelled "Sign in". Deliberately renders no real connection status
  // and no connect/disconnect affordances — nothing about anyone's account
  // leaks. Gated on the explicit `readOnly` flag alone (not `!google`) so a
  // future caller can't accidentally get the signed-out UI by passing a null
  // status.
  if (readOnly) {
    return (
      <CollapsibleSection
        id="settings-integrations"
        voice={voice}
        defaultExpanded={defaultExpanded}
        headingExtras={
          <span className="border-input text-muted-foreground rounded-full border px-2 py-0.5 text-xs font-medium">
            🔒 {t("settings.integrationsSignedOut", voice)}
          </span>
        }
      >
        {/* #90 — this card used to be dimmed with `opacity-70`, which is the
            exact mechanism #56 fixed on the saved-for-later row: compositing a
            70% wash over `text-muted-foreground` dropped the description and
            the owner-only hint to 2.88:1 and the pill to 2.74:1 in light /
            4.42:1 in dark, all under AA-normal 4.5:1. Nothing caught it because
            nothing scanned guest UI — see e2e/a11y/axe-guest-surfaces.spec.ts.
            The "you cannot act on this" read is carried by the two 🔒
            Sign-in labels, the muted copy and the absence of any control,
            which is also the only part of it a screen reader can perceive. */}
        <div className="rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <p className="font-medium">{GOOGLE_NAME}</p>
              <p className="text-muted-foreground text-sm">
                {GOOGLE_DESCRIPTION}
              </p>
            </div>
            <span className="bg-muted text-muted-foreground rounded-full px-2.5 py-0.5 text-xs font-medium">
              {t("settings.integrationsSignedOut", voice)}
            </span>
          </div>
          <p className="text-muted-foreground mt-3 text-sm">
            {t("settings.integrationsSignInHint", voice)}
          </p>
        </div>
      </CollapsibleSection>
    );
  }

  // Signed-in path: a real status object is required. If it's somehow missing,
  // render nothing rather than silently falling back to the signed-out shell —
  // showing a member "Sign in" while they are signed in is worse than showing
  // them nothing.
  if (!google) return null;

  const d = googleDescriptor(google);
  const pillClass =
    d.pill.tone === "ok"
      ? "bg-green-100 text-green-800"
      : d.pill.tone === "warn"
        ? "bg-red-100 text-red-700"
        : "bg-muted text-muted-foreground";

  return (
    <CollapsibleSection
      id="settings-integrations"
      voice={voice}
      defaultExpanded={defaultExpanded}
    >
      <div className="rounded-lg border p-4">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="font-medium">{d.name}</p>
            <p className="text-muted-foreground text-sm">{d.description}</p>
          </div>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${pillClass}`}
          >
            {d.pill.label}
          </span>
        </div>
        {!google.configured && (
          <p className="text-muted-foreground mt-3 text-sm">
            Set <code>GOOGLE_CLIENT_ID</code> /{" "}
            <code>GOOGLE_CLIENT_SECRET</code> to enable (see the README).
          </p>
        )}
        {/* #128 — above the button, not below it: a work/managed Google account
            can be refused by its own administrator at Google's consent step,
            and since the person never returns to our callback there is no
            error we could show afterwards. Deliberately the same muted
            treatment as the not-configured note above rather than a warning
            banner — nothing has gone wrong, this is which account to pick. */}
        {d.connectHref && (
          <GoogleAccountHint id={accountHintId} className="mt-3 text-sm" />
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {d.connectHref && (
            <a
              href={d.connectHref}
              aria-describedby={accountHintId}
              className="bg-primary text-primary-foreground rounded-md px-3 py-2 text-sm font-medium"
            >
              {d.connectLabel}
            </a>
          )}
          {d.canDisconnect && !confirming && (
            <button
              type="button"
              ref={disconnectRef}
              className={cn(
                "text-destructive rounded-md border px-3 py-2 text-sm font-medium",
                touchTarget,
              )}
              onClick={() => {
                returnFocus.current = true;
                setConfirming(true);
              }}
            >
              Disconnect
            </button>
          )}
          {d.canDisconnect && confirming && (
            <>
              {/* role="status" so a screen-reader user learns the confirmation
                  appeared at all — a destructive step that materialises
                  silently is one they never hear. The visible text stays; it is
                  not replaced by an aria-label, so sighted and non-sighted
                  users read the same question. */}
              {/* `basis-full` so the question takes its own line and the two
                  buttons wrap beneath it. At 390px all three in one row squeezed
                  "Yes, disconnect" into a two-line label breaking mid-phrase —
                  legible, but not what a destructive confirmation should read
                  like on the device most of this app is used on. */}
              <span className="basis-full text-sm" role="status" id={confirmId}>
                Remove access to your Google account and delete the tokens
                stored for you?
              </span>
              <button
                type="button"
                disabled={pending}
                aria-describedby={confirmId}
                className={cn(
                  "bg-destructive text-destructive-foreground rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50",
                  touchTarget,
                )}
                onClick={() =>
                  startTransition(async () => {
                    const { revoked } = await disconnectGoogleTasks();
                    setGrantUnrevoked(!revoked);
                    setConfirming(false);
                  })
                }
              >
                Yes, disconnect
              </button>
              <button
                type="button"
                className={cn(
                  "rounded-md border px-3 py-2 text-sm",
                  touchTarget,
                )}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </>
          )}
        </div>
        {/* #126 — the disconnect happened here, but Google refused the revoke,
            so this app is probably still listed in their Google account and
            there is no token left at this end to try again with. Told plainly,
            because it is THEIR connection (nothing to withhold, unlike the
            People panel) and because the remaining step is one only they can
            take. `role="status"` and muted copy, not an alert: nothing has gone
            wrong — the tokens are gone, one thing is outstanding. Wording
            tracks /privacy's "that call can fail" paragraph deliberately. */}
        {grantUnrevoked && (
          <p className="text-muted-foreground mt-3 text-sm" role="status">
            Disconnected — the tokens stored here are deleted. Google did not
            confirm the revoke, so dlectroflow may still be listed in your
            Google account. You can remove it from your{" "}
            {/* No `target="_blank"`, matching the legal footer's rule and for
                the same reason: nothing here is lost by navigating away, so
                forcing a new tab only takes the choice away and adds an "opens
                in a new tab" announcement. `rel="noreferrer"` stays — it costs
                nothing and keeps this instance's URL out of the Referer sent
                to Google. */}
            <a
              href="https://myaccount.google.com/permissions"
              rel="noreferrer"
              className="hover:text-primary focus-visible:text-primary focus-visible:ring-ring rounded underline outline-none focus-visible:ring-2"
            >
              Google account&rsquo;s permissions page
            </a>
            .
          </p>
        )}
      </div>
    </CollapsibleSection>
  );
}
