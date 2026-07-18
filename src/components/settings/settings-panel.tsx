"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  updateAgingSettings,
  updateBreakdownModel,
  updateFirstRunPreview,
  updateVoice,
} from "@/app/actions/settings";
import type { AgingSettings } from "@/lib/aging";
import { ThemeToggle } from "@/components/theme-toggle";
import { OWNER_BREAKDOWN_ALLOWLIST, OWNER_BREAKDOWN_MODEL_DEFAULT } from "@/lib/constants";
import { t, type Voice } from "@/lib/strings";

const FABLE_LINES = [
  "Our most capable model. Also $50/M tokens. To split 'clean the kitchen' into 3 steps? We love you, but no.",
  "We tried it. It wrote a dissertation on the philosophy of procrastination instead of your task. Disabled for everyone's safety.",
  "Reserved for problems harder than 'remember to buy milk.' 💸",
  "Bringing a frontier reasoning model to a to-do list felt… irresponsible.",
  "It kept trying to solve P vs NP instead of your laundry. Locked.",
  "Overkill detector tripped. Fable stays in its cage for this one.",
];

const MODEL_LABELS: Record<string, string> = {
  "claude-haiku-4-5": "Haiku 4.5 — fastest, cheapest",
  "claude-sonnet-4-6": "Sonnet 4.6 — balanced (default)",
  "claude-opus-4-8": "Opus 4.8 — deepest reasoning, slower",
};

export function SettingsPanel({
  settings,
  isOwner,
  breakdownModel,
  voice,
}: {
  settings: AgingSettings & { firstRunPreview: boolean };
  isOwner: boolean;
  breakdownModel: string | null;
  voice: Voice;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [voicePending, startVoiceTransition] = useTransition();
  const [frPending, startFr] = useTransition();
  const [firstRun, setFirstRun] = useState(settings.firstRunPreview);
  const [minutes, setMinutes] = useState(settings.agingThresholdMinutes);
  const [demo, setDemo] = useState<string>(
    settings.demoOverrideSeconds != null
      ? String(settings.demoOverrideSeconds)
      : "",
  );
  const [agingHours, setAgingHours] = useState(settings.agingHours);
  const [overdueHours, setOverdueHours] = useState(settings.overdueHours);
  const [wayOverdueHours, setWayOverdueHours] = useState(
    settings.wayOverdueHours,
  );

  const [model, setModel] = useState<string>(breakdownModel ?? OWNER_BREAKDOWN_MODEL_DEFAULT);
  const [fable] = useState(() => FABLE_LINES[Math.floor(Math.random() * FABLE_LINES.length)]);
  const [currentVoice, setCurrentVoice] = useState<Voice>(voice);

  const saveVoice = (v: Voice) =>
    startVoiceTransition(async () => {
      setCurrentVoice(v);
      await updateVoice(v);
      router.refresh();
    });

  const save = () =>
    startTransition(async () => {
      await updateAgingSettings({
        agingThresholdMinutes: minutes,
        demoOverrideSeconds: demo.trim() === "" ? null : Number(demo),
        agingHours,
        overdueHours,
        wayOverdueHours,
      });
      router.refresh();
    });

  const saveModel = (m: string) =>
    startTransition(async () => {
      setModel(m);
      await updateBreakdownModel(m);
      router.refresh();
    });

  const toggleFirstRun = (v: boolean) => {
    setFirstRun(v);
    // Async transition callback so frPending stays true for the whole write
    // (a sync callback returning an unawaited promise drops pending immediately,
    // leaving the checkbox re-clickable mid-request). Matches saveVoice.
    startFr(async () => {
      await updateFirstRunPreview(v);
    });
  };

  return (
    <div className="space-y-6 text-sm">
      <section className="space-y-3">
        <h2 className="font-semibold">
          Aging &amp; reminder
          {settings.demoOverrideSeconds != null && (
            <span className="ml-2 text-xs font-normal text-amber-600">
              demo override: {settings.demoOverrideSeconds}s
            </span>
          )}
        </h2>
        <div className="flex flex-wrap items-end gap-4">
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
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            {t("freshness.aging", voice)} (hours)
          </span>
          <input
            type="number"
            min={1}
            value={agingHours}
            onChange={(e) => setAgingHours(Number(e.target.value))}
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
            onChange={(e) => setOverdueHours(Number(e.target.value))}
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
            onChange={(e) => setWayOverdueHours(Number(e.target.value))}
            className="border-input w-32 rounded-md border px-2 py-1"
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
        <p className="text-muted-foreground text-xs">
          The demo override makes items age in seconds so reminders fire live on
          stage.
        </p>
      </section>

      <section className="space-y-2 border-t pt-4">
        <h2 className="font-semibold">Voice</h2>
        <div className="inline-flex rounded-md border" role="group" aria-label="Voice preference">
          {(["plain", "playful"] as const).map((v) => (
            <button
              key={v}
              type="button"
              disabled={voicePending}
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
      </section>

      <section className="space-y-2 border-t pt-4">
        <h2 className="font-semibold">Appearance</h2>
        <ThemeToggle />
      </section>

      {isOwner && (
        <section className="space-y-2 border-t pt-4">
          <h2 className="font-semibold">Breakdown model</h2>
          <div className="flex flex-col gap-1">
            {OWNER_BREAKDOWN_ALLOWLIST.map((m) => (
              <label key={m} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="breakdown-model"
                  checked={model === m}
                  disabled={pending}
                  onChange={() => saveModel(m)}
                />
                {MODEL_LABELS[m]}
              </label>
            ))}
            <label className="flex items-center gap-2 text-sm opacity-50" title={fable}>
              <input type="radio" name="breakdown-model" disabled />
              🔒 Fable 5 — {fable}
            </label>
          </div>
        </section>
      )}

      <section className="space-y-2 border-t pt-4">
        <h2 className="font-semibold">Demo</h2>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={firstRun}
            disabled={frPending}
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
      </section>
    </div>
  );
}
