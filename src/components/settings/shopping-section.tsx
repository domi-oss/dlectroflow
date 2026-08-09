"use client";

import { useState, useTransition } from "react";
import { updateShoppingList } from "@/app/actions/settings";
import { CollapsibleSection } from "@/components/nav/collapsible-section";
import {
  useSaveStatus,
  SaveIndicator,
} from "@/components/settings/use-save-status";
import { t, type Voice } from "@/lib/strings";

/**
 * #199 — shopping-list mode's on/off switch.
 *
 * Its own section rather than a checkbox borrowed from an existing one: this is a
 * FEATURE switch that adds a destination to the menu, and none of the existing
 * headings describe it (Appearance is theme, typeface and completion style;
 * Notifications is per-type delivery; Aging is thresholds). A switch filed under a
 * heading that does not name it is a switch nobody finds. The registry entry in
 * `src/lib/section-nav.ts` carries the placement reasoning.
 *
 * Auto-saves on change, like `DemoSection` — the async transition callback keeps
 * `pending` true for the whole write, so the checkbox is not re-clickable
 * mid-request (a sync callback returning an unawaited promise drops it
 * immediately).
 *
 * The hint says turning it OFF is not destructive, and that sentence is asserted
 * in the test: from the checkbox alone, "hide the list" and "delete the list" look
 * identical, and only one of them is recoverable.
 *
 * ## A failed save both speaks and steps back
 *
 * Duo review round 5, !294. `toggle()` set `enabled` optimistically and awaited
 * the write with no `catch`, so a rejection left the checkbox showing the value
 * the user picked while the database still held the other one. This is not a
 * taste setting — it gates the `/shopping` route and the menu entry, both
 * server-rendered — so the page then disagreed with itself until a full reload.
 *
 * The fix has to be both halves. Reporting alone would leave "couldn't save"
 * sitting beside a checkbox that still reads "on", which is a worse lie than the
 * silent one: it asks the user to choose between two things the page is telling
 * them, and the wrong one looks more authoritative.
 *
 * The feedback is `useSaveStatus` / `SaveIndicator` — the auto-save vocabulary
 * `AppearanceSection`, `NotificationsSection`, `FocusTimerSection` and
 * `AgingSection` already share — and NOT the shopping list page's own failure
 * notice from round 4. That notice quotes the words at stake and offers a Retry,
 * neither of which means anything for a boolean; a settings section reporting a
 * failed auto-save in a second shape is the divergence this branch has spent
 * four rounds closing everywhere else.
 *
 * **What it deliberately does not cover:** an action that never answers at all.
 * `withActionTimeout` bounds that on the two capture surfaces, but `SaveStatus`
 * has no "we do not know" state, and inventing one here would change shared
 * machinery five sections render. Raised as a follow-up for the settings surface
 * as a whole rather than answered once, differently, in this corner of it.
 */
export function ShoppingSection({
  shoppingList,
  voice,
  defaultExpanded,
}: {
  shoppingList: boolean;
  voice: Voice;
  defaultExpanded?: boolean;
}) {
  const [enabled, setEnabled] = useState(shoppingList);
  const [pending, startTransition] = useTransition();
  const { status, markSaving, markSaved, markError } = useSaveStatus();

  const toggle = (next: boolean) => {
    setEnabled(next);
    startTransition(async () => {
      markSaving();
      try {
        await updateShoppingList(next);
        markSaved();
      } catch {
        // Back to what the server still holds. A functional updater, and guarded
        // on the value this attempt set, so a rollback can only undo its own
        // optimistic write — the same "only the record this attempt owns" rule
        // the shopping list applies to its in-flight retries.
        setEnabled((current) => (current === next ? !next : current));
        markError();
      }
    });
  };

  return (
    <CollapsibleSection
      id="settings-shopping"
      voice={voice}
      defaultExpanded={defaultExpanded}
      headingExtras={<SaveIndicator status={status} voice={voice} />}
    >
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={pending}
          onChange={(e) => toggle(e.target.checked)}
          className="mt-1"
        />
        <span>
          <span className="font-medium">
            {t("shopping.settingsToggle", voice)}
          </span>
          <br />
          <span className="text-muted-foreground">
            {t("shopping.settingsHint", voice)}
          </span>
        </span>
      </label>
    </CollapsibleSection>
  );
}
