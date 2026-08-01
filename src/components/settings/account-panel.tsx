"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveOwnLlmKey, removeOwnLlmKey } from "@/app/actions/account";
import { CollapsibleSection } from "@/components/nav/collapsible-section";
import { DeleteAccount } from "@/components/settings/delete-account";
import { t, type Voice } from "@/lib/strings";
import { cn, touchTarget } from "@/lib/utils";

/**
 * #35 Phase C (#118) — your own account: who you are signed in as, and your own
 * LLM API key.
 *
 * Presentational by construction. It is told a BOOLEAN (`keyPresent`) and never
 * the key or its ciphertext, so there is no "reveal my key" affordance to add and
 * nothing for an RSC payload to carry. What it does own is the copy explaining
 * the one thing a user cannot discover: a stored key pays for that account's own
 * breakdowns, which is why no instance usage limit applies to it
 * (`consumeUserBreakdown`'s first resolution rule, in plain words).
 *
 * There is deliberately NO provider or base-URL field. `LLMCredentials` has no
 * `baseUrl` because letting a per-user value choose the endpoint would turn a
 * settings field into an SSRF primitive (see src/lib/llm/types.ts); a user's key
 * is for the instance's configured provider, and `activeModelName` says which.
 */
type Outcome = "saved" | "removed" | "rejected" | "signed_out" | null;

export function AccountPanel({
  handle,
  provider,
  keyPresent,
  activeModelName,
  isOwner,
  purgeGraceDays,
  voice = "plain",
  defaultExpanded,
}: {
  /** Provider username, lowercased at the boundary; `null` when the provider
   *  withheld one (`AuthProfile.username` is optional). */
  handle: string | null;
  /** The provider this account was PROVISIONED under (#74 requires it to be
   *  stated wherever identity is shown) — not the current AUTH_PROVIDER. */
  provider: string;
  /** Presence only. Never the key, never its ciphertext. */
  keyPresent: boolean;
  /** The model a breakdown paid for with this key actually resolves to (#96's
   *  own-key tier), resolved server-side because env is not readable from this
   *  client bundle. Shown read-only: there is nothing per-user to choose. */
  activeModelName: string;
  /** #153 — the owner cannot delete their own account, so they get the sentence
   *  explaining why instead of a control that could only fail. */
  isOwner: boolean;
  /** #153 — `PURGE_GRACE_DAYS`, resolved server-side: the module that owns it
   *  imports Prisma, which has no business in a client bundle. */
  purgeGraceDays: number;
  voice?: Voice;
  defaultExpanded?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [key, setKey] = useState("");
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [confirming, setConfirming] = useState(false);
  const fieldId = useId();
  const statusId = useId();

  // Focus must not fall to <body> when the confirmation row unmounts — the
  // control that had it is gone. Same reasoning, and the same shape, as the
  // Disconnect confirmation in integrations-panel.tsx.
  const removeRef = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!confirming && returnFocus.current) {
      returnFocus.current = false;
      removeRef.current?.focus();
    }
  }, [confirming]);

  const save = () => {
    // Client-side guard on the empty field only: the action re-validates length
    // and control characters, because a server action is a public POST endpoint
    // and this component is not the gate.
    if (!key.trim()) return;
    startTransition(async () => {
      const res = await saveOwnLlmKey(key);
      if (res.ok) {
        // Cleared on success: a stored secret sitting in a mounted input is a
        // shoulder-surfing and screenshot problem for no benefit. KEPT on
        // failure, because clearing a rejected value forces a re-paste.
        setKey("");
        setOutcome("saved");
        router.refresh();
        return;
      }
      setOutcome(res.error === "not_signed_in" ? "signed_out" : "rejected");
    });
  };

  const remove = () =>
    startTransition(async () => {
      const res = await removeOwnLlmKey();
      setConfirming(false);
      if (res.ok) {
        setOutcome("removed");
        router.refresh();
        return;
      }
      setOutcome(res.error === "not_signed_in" ? "signed_out" : "rejected");
    });

  // ONE live region for every outcome, and it is also what the confirmation
  // question is announced through — a destructive step that appears silently is
  // one a screen-reader user never learns about.
  const message = confirming
    ? t("settings.accountKeyRemoveConfirm", voice)
    : outcome === "saved"
      ? t("settings.accountKeySaved", voice)
      : outcome === "removed"
        ? t("settings.accountKeyRemoved", voice)
        : outcome === "rejected"
          ? t("settings.accountKeyRejected", voice)
          : outcome === "signed_out"
            ? t("settings.accountKeySignedOut", voice)
            : null;

  return (
    <CollapsibleSection
      id="settings-account"
      voice={voice}
      defaultExpanded={defaultExpanded}
    >
      <div className="space-y-4 rounded-lg border p-4">
        {/* Identity. The provider is named alongside the handle (#74): it is the
            provider this account was provisioned under, which is not necessarily
            the one a new sign-in would use. */}
        <p className="text-sm">
          Signed in as{" "}
          <span className="font-medium">{handle ?? "your account"}</span>{" "}
          <span className="text-muted-foreground">via {provider}</span>
        </p>

        <div className="space-y-2">
          <label htmlFor={fieldId} className="block text-sm font-medium">
            {t("settings.accountKeyLabel", voice)}
          </label>
          <p className="text-muted-foreground text-sm">
            {t("settings.accountKeyHint", voice)}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              id={fieldId}
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  save();
                }
              }}
              // All of it off: a secret must not land in a browser's autofill
              // store, be spell-corrected, or be auto-capitalised.
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="border-input min-h-11 flex-1 rounded-md border px-3 py-2 text-sm"
              placeholder="sk-…"
            />
            <button
              type="button"
              disabled={pending}
              onClick={save}
              className={cn(
                "bg-primary text-primary-foreground rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50",
                touchTarget,
              )}
            >
              {pending ? "Saving…" : "Save key"}
            </button>
          </div>
          {/* Read-only, because there is no per-user provider or base URL to
              choose — only the instance's (a per-user endpoint would be an SSRF
              primitive; see src/lib/llm/types.ts). */}
          <p className="text-muted-foreground text-sm">
            Your key pays for your AI breakdowns, on this instance&apos;s
            configured provider, with the model <code>{activeModelName}</code>.
          </p>
        </div>

        {keyPresent && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-sm font-medium">
              {t("settings.accountKeyInUse", voice)}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              {!confirming ? (
                <button
                  type="button"
                  ref={removeRef}
                  onClick={() => {
                    returnFocus.current = true;
                    setOutcome(null);
                    setConfirming(true);
                  }}
                  className={cn(
                    "text-destructive rounded-md border px-3 py-2 text-sm font-medium",
                    touchTarget,
                  )}
                >
                  Remove key
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={pending}
                    aria-describedby={statusId}
                    onClick={remove}
                    className={cn(
                      "bg-destructive text-destructive-foreground rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50",
                      touchTarget,
                    )}
                  >
                    Yes, remove
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className={cn(
                      "rounded-md border px-3 py-2 text-sm",
                      touchTarget,
                    )}
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Never echoes the key — every branch of `message` is fixed copy. */}
        <p
          role="status"
          id={statusId}
          aria-live="polite"
          className="text-muted-foreground min-h-5 text-sm"
        >
          {message}
        </p>
      </div>

      {/* #153 — leaving. Its own bordered block at the FOOT of the section, and
          deliberately not folded in with the key controls above: the panel's
          other affordances are things you tune, and this one ends the account.
          Same reasoning as People closing the settings page (#101) — the
          irreversible thing does not greet you. */}
      <div className="space-y-2 rounded-lg border p-4">
        <h3 className="text-sm font-medium">Delete your account</h3>
        <DeleteAccount isOwner={isOwner} purgeGraceDays={purgeGraceDays} />
      </div>
    </CollapsibleSection>
  );
}
