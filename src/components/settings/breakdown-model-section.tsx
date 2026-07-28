"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateBreakdownModel } from "@/app/actions/settings";
import { OWNER_BREAKDOWN_MODEL_DEFAULT } from "@/lib/constants";
import { FABLE_LINES } from "@/lib/fable-lines";
import { CollapsibleSection } from "@/components/nav/collapsible-section";
import { t, type Voice } from "@/lib/strings";

/**
 * Which model does a breakdown (#6). Shown to guests too (#11) but read-only:
 * the picker is an owner-only control, so guests see WHAT the app offers without
 * the owner's actual choice (never pre-selected for guests) and without being
 * able to change it. Server-side, `updateBreakdownModel` already rejects
 * non-owners — this is the matching UI.
 *
 * #101 split this out of the old four-in-one `SettingsPanel`.
 */
export function BreakdownModelSection({
  isOwner,
  breakdownModel,
  modelChoices,
  activeModelName,
  voice,
  defaultExpanded,
  fable = FABLE_LINES[0],
}: {
  isOwner: boolean;
  breakdownModel: string | null;
  /**
   * Provider-scoped model choices, computed server-side via
   * `modelChoicesForProvider()` (#59) — `null` when the active `LLM_PROVIDER`
   * exposes no user-facing choice (e.g. a single-model openai-compatible
   * deploy). Must be resolved by the server (env vars aren't available in this
   * client component's browser bundle) and passed in as a prop so
   * server-rendered HTML and client hydration agree.
   */
  modelChoices: { id: string; label: string }[] | null;
  /** The single configured model name, shown read-only when `modelChoices` is null. */
  activeModelName?: string | null;
  voice: Voice;
  defaultExpanded?: boolean;
  /**
   * The decoy model's flavour line, rolled server-side so SSR and hydration
   * agree (see randomFableLine). Defaults to the first line, keeping tests and
   * any other caller deterministic.
   */
  fable?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [model, setModel] = useState<string>(
    breakdownModel ?? OWNER_BREAKDOWN_MODEL_DEFAULT,
  );

  const saveModel = (m: string) =>
    startTransition(async () => {
      setModel(m);
      await updateBreakdownModel(m);
      router.refresh();
    });

  return (
    <CollapsibleSection
      id="settings-breakdown-model"
      voice={voice}
      defaultExpanded={defaultExpanded}
      headingExtras={
        !isOwner && (
          <span className="border-input text-muted-foreground rounded-full border px-2 py-0.5 text-xs font-normal">
            🔒 {t("settings.ownerOnly", voice)}
          </span>
        )
      }
    >
      {modelChoices ? (
        <>
          <div
            className="flex flex-col gap-1"
            role="radiogroup"
            aria-label="Breakdown model"
            aria-describedby={
              isOwner ? undefined : "breakdown-model-owner-hint"
            }
          >
            {modelChoices.map(({ id, label }) => (
              <label
                key={id}
                className={
                  "flex items-center gap-2 text-sm" +
                  (isOwner ? "" : " opacity-50")
                }
              >
                <input
                  type="radio"
                  name="breakdown-model"
                  // Guests never see the owner's stored choice reflected.
                  checked={isOwner && model === id}
                  disabled={!isOwner || pending}
                  onChange={() => saveModel(id)}
                />
                {label}
              </label>
            ))}
            {/* Decoy is anthropic-only: it rides along with the anthropic
                tier list (the only provider with a choice today). */}
            <label
              className="flex items-center gap-2 text-sm opacity-50"
              title={fable}
            >
              <input type="radio" name="breakdown-model" disabled />
              🔒 Fable 5 — {fable}
            </label>
          </div>
          {!isOwner && (
            <p
              id="breakdown-model-owner-hint"
              className="text-muted-foreground text-xs"
            >
              {t("settings.modelOwnerHint", voice)}
            </p>
          )}
        </>
      ) : (
        // Single-model deploy (e.g. openai-compatible with no owner/guest
        // split) — nothing to pick, so show what's configured instead of a
        // picker nobody can act on.
        <p className="text-muted-foreground text-xs">
          Using model: <code>{activeModelName ?? "unknown"}</code>
        </p>
      )}
    </CollapsibleSection>
  );
}
