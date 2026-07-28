"use client";

import { useState, useTransition } from "react";
import { updateFirstRunPreview } from "@/app/actions/settings";
import { CollapsibleSection } from "@/components/nav/collapsible-section";
import { type Voice } from "@/lib/strings";

/**
 * Demo overrides — niche, but this project does get demoed, so the first-run
 * preview lives on the settings page rather than behind a flag.
 *
 * #101 split this out of the old four-in-one `SettingsPanel`.
 */
export function DemoSection({
  firstRunPreview,
  voice,
  defaultExpanded,
}: {
  firstRunPreview: boolean;
  voice: Voice;
  defaultExpanded?: boolean;
}) {
  const [firstRun, setFirstRun] = useState(firstRunPreview);
  const [pending, startTransition] = useTransition();

  const toggleFirstRun = (v: boolean) => {
    setFirstRun(v);
    // Async transition callback so `pending` stays true for the whole write (a
    // sync callback returning an unawaited promise drops pending immediately,
    // leaving the checkbox re-clickable mid-request).
    startTransition(async () => {
      await updateFirstRunPreview(v);
    });
  };

  return (
    <CollapsibleSection
      id="settings-demo"
      voice={voice}
      defaultExpanded={defaultExpanded}
    >
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={firstRun}
          disabled={pending}
          onChange={(e) => toggleFirstRun(e.target.checked)}
          className="mt-1"
        />
        <span>
          <span className="font-medium">First-run preview</span>
          <br />
          <span className="text-muted-foreground">
            Show the app as a brand-new user sees it — welcome card + empty
            Inbox. Non-destructive.
          </span>
        </span>
      </label>
    </CollapsibleSection>
  );
}
