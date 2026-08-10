"use client";

import { useState, useTransition } from "react";
import { updateFirstRunPreview } from "@/app/actions/settings";
import { CollapsibleSection } from "@/components/nav/collapsible-section";
import {
  useSaveStatus,
  SaveIndicator,
} from "@/components/settings/use-save-status";
import { type Voice } from "@/lib/strings";

/**
 * Demo overrides — niche, but this project does get demoed, so the first-run
 * preview lives on the settings page rather than behind a flag.
 *
 * #101 split this out of the old four-in-one `SettingsPanel`.
 *
 * ## A failed save both speaks and steps back (#227)
 *
 * `toggleFirstRun` set `firstRun` optimistically and awaited the write inside a
 * transition with no `try`/`catch`, and this was the ONE settings section that
 * did not use `useSaveStatus` at all. So a rejection had nowhere to go — it
 * became an unhandled rejection inside the transition — and the checkbox went
 * on showing the value the server had refused, with nothing on screen saying
 * so, until the next server render.
 *
 * Both halves are needed and the second is the one that is easy to skip.
 * Reporting alone would leave "couldn't save" beside a checkbox still reading
 * "on", which is a worse lie than the silent one: it asks the user to choose
 * between two things the page is telling them, and the control looks more
 * authoritative than the message.
 *
 * The feedback is `useSaveStatus` / `SaveIndicator`, the auto-save vocabulary
 * the other five sections share — deliberately NOT the shopping page's failure
 * notice, which quotes the words at stake and offers a Retry, neither of which
 * means anything for a boolean.
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
  const { status, markSaving, markSaved, markError } = useSaveStatus();

  const toggleFirstRun = (v: boolean) => {
    setFirstRun(v);
    // Async transition callback so `pending` stays true for the whole write (a
    // sync callback returning an unawaited promise drops pending immediately,
    // leaving the checkbox re-clickable mid-request).
    startTransition(async () => {
      markSaving();
      try {
        await updateFirstRunPreview(v);
        markSaved();
      } catch {
        // #227 — back to what the server still holds. A functional updater,
        // guarded on the value this attempt set, so a rollback can only undo its
        // own optimistic write. `disabled={pending}` means two attempts cannot
        // interleave here today, but the guard does not depend on that prop
        // staying: a rollback that trusts its closure is the bug that replaces
        // this one the moment the control stops being serialised.
        setFirstRun((current) => (current === v ? !v : current));
        markError();
      }
    });
  };

  return (
    <CollapsibleSection
      id="settings-demo"
      voice={voice}
      defaultExpanded={defaultExpanded}
      headingExtras={<SaveIndicator status={status} voice={voice} />}
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
