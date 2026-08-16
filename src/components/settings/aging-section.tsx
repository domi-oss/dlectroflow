"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { updateAgingSettings } from "@/app/actions/settings";
import type { AgingSettings } from "@/lib/aging";
import { CollapsibleSection } from "@/components/nav/collapsible-section";
import { t, type Voice } from "@/lib/strings";
import {
  useSaveStatus,
  SaveIndicator,
} from "@/components/settings/use-save-status";

/**
 * The freshness thresholds: how long an inbox item sits before it is called
 * aging, overdue or way overdue.
 *
 * #101 split this out of the old four-in-one `SettingsPanel`. The section nav has
 * always listed these four as separate sections, so keeping them nested inside
 * one component contradicted the nav — and left them unable to collapse
 * independently.
 *
 * The Save button is gone: each change schedules ONE debounced write for the
 * whole group (they share a single server action), and a failed write surfaces a
 * non-blocking error while leaving every input editable.
 *
 * #261 — HOURS THROUGHOUT, and that is the section's rule now rather than an
 * observation about it. It used to carry "Aging threshold (minutes)" beside
 * "Aging (hours)": two controls for one concept in two units, backed by two
 * columns with the same default expressed differently (240 vs 4), which nothing
 * reconciled. It also carried "Demo override (seconds)", a third unit whose one
 * job was to make hours of behaviour fire in seconds on stage.
 *
 * The convention every later duration setting follows — #260's "park until"
 * snooze is next — is written down in `src/lib/aging.ts`'s module docblock:
 * whole hours, one setting per concept.
 *
 * ## Why a failed write is NOT rolled back here (#227)
 *
 * #227 audited the four `useSaveStatus` sections for both halves — report the
 * failure *and* restore the control — and added the rollback to
 * `NotificationsSection`, `AppearanceSection` and `FocusTimerSection`. This
 * section was already correct, and deliberately so rather than by omission,
 * which is why it is written down: these are three free-entry number fields
 * behind a 600 ms debounce, so the value on screen is the user's own in-progress
 * typing rather than a toggle's committed state. Putting the server's number
 * back would DELETE what they are still editing — a worse outcome than the
 * stale-looking switch #227 is about, and precisely the failure the paragraph
 * above rules out when it says the inputs stay editable. For a field the user is
 * holding, reporting is the whole correct answer.
 *
 * Pinned by a spec in `aging-section.test.tsx` so the next audit does not read
 * the missing rollback as the bug the other three had.
 */
export function AgingSection({
  settings,
  voice,
  defaultExpanded,
  autoSaveDelayMs = 600,
}: {
  settings: AgingSettings;
  voice: Voice;
  defaultExpanded?: boolean;
  /** Debounce for numeric auto-saves. Overridable so tests stay fast + deterministic. */
  autoSaveDelayMs?: number;
}) {
  const router = useRouter();
  const [agingHours, setAgingHours] = useState(settings.agingHours);
  const [overdueHours, setOverdueHours] = useState(settings.overdueHours);
  const [wayOverdueHours, setWayOverdueHours] = useState(
    settings.wayOverdueHours,
  );

  const { status, markSaving, markSaved, markError } = useSaveStatus();
  const valuesRef = useRef({ agingHours, overdueHours, wayOverdueHours });
  // Keep the ref current for the debounced flush (reads the latest values when
  // it eventually fires) without touching the ref during render.
  useEffect(() => {
    valuesRef.current = { agingHours, overdueHours, wayOverdueHours };
  });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const flushAgingSave = async () => {
    const v = valuesRef.current;
    markSaving();
    try {
      await updateAgingSettings({
        agingHours: v.agingHours,
        overdueHours: v.overdueHours,
        wayOverdueHours: v.wayOverdueHours,
      });
      markSaved();
      router.refresh();
    } catch {
      markError();
    }
  };

  const scheduleAgingSave = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void flushAgingSave();
    }, autoSaveDelayMs);
  };

  return (
    <CollapsibleSection
      id="settings-aging"
      voice={voice}
      defaultExpanded={defaultExpanded}
      headingExtras={<SaveIndicator status={status} voice={voice} />}
    >
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            {t("freshness.aging", voice)} (hours)
          </span>
          <input
            type="number"
            min={1}
            value={agingHours}
            onChange={(e) => {
              setAgingHours(Number(e.target.value));
              scheduleAgingSave();
            }}
            className="border-input w-32 rounded-md border px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            {t("freshness.overdue", voice)} (hours)
          </span>
          <input
            type="number"
            min={1}
            value={overdueHours}
            onChange={(e) => {
              setOverdueHours(Number(e.target.value));
              scheduleAgingSave();
            }}
            className="border-input w-32 rounded-md border px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            {t("freshness.wayOverdue", voice)} (hours)
          </span>
          <input
            type="number"
            min={1}
            value={wayOverdueHours}
            onChange={(e) => {
              setWayOverdueHours(Number(e.target.value));
              scheduleAgingSave();
            }}
            className="border-input w-32 rounded-md border px-2 py-1"
          />
        </label>
      </div>
      <p className="text-muted-foreground text-xs">
        Changes save automatically. Every threshold here is in whole hours, and
        each one is counted from when you added an item — or from the last time
        you said it was still needed.
      </p>
    </CollapsibleSection>
  );
}
