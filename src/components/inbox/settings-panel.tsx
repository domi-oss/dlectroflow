"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateAgingSettings } from "@/app/actions/settings";
import type { AgingSettings } from "@/lib/aging";

export function SettingsPanel({ settings }: { settings: AgingSettings }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [minutes, setMinutes] = useState(settings.agingThresholdMinutes);
  const [demo, setDemo] = useState<string>(
    settings.demoOverrideSeconds != null
      ? String(settings.demoOverrideSeconds)
      : "",
  );

  const save = () =>
    startTransition(async () => {
      await updateAgingSettings({
        agingThresholdMinutes: minutes,
        demoOverrideSeconds: demo.trim() === "" ? null : Number(demo),
      });
      router.refresh();
    });

  return (
    <details className="rounded-lg border px-4 py-2 text-sm">
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer list-none">
        ⚙️ Aging &amp; reminder settings
        {settings.demoOverrideSeconds != null && (
          <span className="ml-2 text-amber-600">
            demo override: {settings.demoOverrideSeconds}s
          </span>
        )}
      </summary>
      <div className="mt-3 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            Aging threshold (minutes)
          </span>
          <input
            type="number"
            min={1}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            className="border-input w-32 rounded-md border px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            Demo override (seconds, blank = off)
          </span>
          <input
            type="number"
            min={1}
            value={demo}
            placeholder="e.g. 10"
            onChange={(e) => setDemo(e.target.value)}
            className="border-input w-40 rounded-md border px-2 py-1"
          />
        </label>
        <button
          onClick={save}
          disabled={pending}
          className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 font-medium disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        The demo override makes items age in seconds so reminders fire live on
        stage.
      </p>
    </details>
  );
}
