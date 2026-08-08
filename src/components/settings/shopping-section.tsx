"use client";

import { useState, useTransition } from "react";
import { updateShoppingList } from "@/app/actions/settings";
import { CollapsibleSection } from "@/components/nav/collapsible-section";
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

  const toggle = (next: boolean) => {
    setEnabled(next);
    startTransition(async () => {
      await updateShoppingList(next);
    });
  };

  return (
    <CollapsibleSection
      id="settings-shopping"
      voice={voice}
      defaultExpanded={defaultExpanded}
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
