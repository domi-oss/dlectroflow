"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateVoice } from "@/app/actions/settings";
import { CollapsibleSection } from "@/components/nav/collapsible-section";
import { type Voice } from "@/lib/strings";

/**
 * Plain or Playful — the voice every string in the app resolves through.
 *
 * #101 split this out of the old four-in-one `SettingsPanel`; the section nav has
 * listed it as its own section since #72.
 *
 * The optimistic `setCurrentVoice` matters: the whole page's copy re-renders from
 * the server after `router.refresh()`, and without it the toggle would show the
 * old choice for the length of that round trip.
 */
export function VoiceSection({
  voice,
  defaultExpanded,
}: {
  voice: Voice;
  defaultExpanded?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [currentVoice, setCurrentVoice] = useState<Voice>(voice);

  const saveVoice = (v: Voice) =>
    startTransition(async () => {
      setCurrentVoice(v);
      await updateVoice(v);
      router.refresh();
    });

  return (
    <CollapsibleSection
      id="settings-voice"
      voice={voice}
      defaultExpanded={defaultExpanded}
    >
      <div
        className="inline-flex rounded-md border"
        role="group"
        aria-label="Voice preference"
      >
        {(["plain", "playful"] as const).map((v) => (
          <button
            key={v}
            type="button"
            disabled={pending}
            onClick={() => saveVoice(v)}
            className={
              "px-3 py-1 text-sm first:rounded-l-md last:rounded-r-md transition-colors disabled:opacity-50 " +
              (currentVoice === v
                ? "bg-primary text-primary-foreground font-medium"
                : "bg-background text-muted-foreground hover:text-foreground")
            }
          >
            {v === "plain" ? "Plain" : "Playful"}
          </button>
        ))}
      </div>
    </CollapsibleSection>
  );
}
