"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  updateAgingSettings,
  updateBreakdownModel,
  updateFirstRunPreview,
  updateVoice,
} from "@/app/actions/settings";
import type { AgingSettings } from "@/lib/aging";
import { OWNER_BREAKDOWN_MODEL_DEFAULT } from "@/lib/constants";
import { t, type Voice } from "@/lib/strings";
import {
  useSaveStatus,
  SaveIndicator,
} from "@/components/settings/use-save-status";
import { SectionHeading } from "@/components/nav/section-heading";

const FABLE_LINES = [
  "Our most capable model. Also $50/M tokens. To split 'clean the kitchen' into 3 steps? We love you, but no.",
  "We tried it. It wrote a dissertation on the philosophy of procrastination instead of your task. Disabled for everyone's safety.",
  "Reserved for problems harder than 'remember to buy milk.' 💸",
  "Bringing a frontier reasoning model to a to-do list felt… irresponsible.",
  "It kept trying to solve P vs NP instead of your laundry. Locked.",
  "Overkill detector tripped. Fable stays in its cage for this one.",
];

export function SettingsPanel({
  settings,
  isOwner,
  breakdownModel,
  modelChoices,
  activeModelName,
  voice,
  autoSaveDelayMs = 600,
}: {
  settings: AgingSettings & { firstRunPreview: boolean };
  isOwner: boolean;
  breakdownModel: string | null;
  /**
   * Provider-scoped model choices for the picker below, computed server-side
   * via `modelChoicesForProvider()` (#59) — `null` when the active
   * `LLM_PROVIDER` exposes no user-facing choice (e.g. a single-model
   * openai-compatible deploy). Must be resolved by the server (env vars
   * aren't available in this client component's browser bundle) and passed
   * in as a prop so server-rendered HTML and client hydration agree.
   */
  modelChoices: { id: string; label: string }[] | null;
  /** The single configured model name, shown read-only when `modelChoices` is null. */
  activeModelName?: string | null;
  voice: Voice;
  /** Debounce for numeric auto-saves. Overridable so tests stay fast + deterministic. */
  autoSaveDelayMs?: number;
}) {
  const router = useRouter();
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

  const [model, setModel] = useState<string>(
    breakdownModel ?? OWNER_BREAKDOWN_MODEL_DEFAULT,
  );
  const [fable] = useState(
    () => FABLE_LINES[Math.floor(Math.random() * FABLE_LINES.length)],
  );
  const [currentVoice, setCurrentVoice] = useState<Voice>(voice);

  // ── Auto-save for the freshness/aging numeric inputs (debounced). ──────────
  // The Save button is gone; each change schedules a debounced write. A failed
  // write surfaces a non-blocking error and leaves every input editable.
  const { status, markSaving, markSaved, markError } = useSaveStatus();
  const valuesRef = useRef({
    minutes,
    demo,
    agingHours,
    overdueHours,
    wayOverdueHours,
  });
  // Keep the ref current for the debounced flush (reads the latest values when
  // it eventually fires) without touching the ref during render.
  useEffect(() => {
    valuesRef.current = {
      minutes,
      demo,
      agingHours,
      overdueHours,
      wayOverdueHours,
    };
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
        agingThresholdMinutes: v.minutes,
        demoOverrideSeconds: v.demo.trim() === "" ? null : Number(v.demo),
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

  const saveVoice = (v: Voice) =>
    startVoiceTransition(async () => {
      setCurrentVoice(v);
      await updateVoice(v);
      router.refresh();
    });

  const saveModel = (m: string) =>
    startVoiceTransition(async () => {
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
        <SectionHeading id="settings-aging" voice={voice}>
          {settings.demoOverrideSeconds != null && (
            <span className="text-xs font-normal text-amber-600">
              demo override: {settings.demoOverrideSeconds}s
            </span>
          )}
          <SaveIndicator status={status} voice={voice} />
        </SectionHeading>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">
              Aging threshold (minutes)
            </span>
            <input
              type="number"
              min={1}
              value={minutes}
              onChange={(e) => {
                setMinutes(Number(e.target.value));
                scheduleAgingSave();
              }}
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
              onChange={(e) => {
                setDemo(e.target.value);
                scheduleAgingSave();
              }}
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
          Changes save automatically. The demo override makes items age in
          seconds so reminders fire live on stage.
        </p>
      </section>

      <section className="space-y-2 border-t pt-4">
        <SectionHeading id="settings-voice" voice={voice} />
        <div
          className="inline-flex rounded-md border"
          role="group"
          aria-label="Voice preference"
        >
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

      {/* Breakdown model (#6). Shown to guests too (#11) but read-only: the
          picker is an owner-only control, so guests see WHAT the app offers
          without the owner's actual choice (never pre-selected for guests) and
          without being able to change it. Server-side, updateBreakdownModel
          already rejects non-owners — this is the matching UI. */}
      <section className="space-y-2 border-t pt-4">
        <SectionHeading id="settings-breakdown-model" voice={voice}>
          {!isOwner && (
            <span className="border-input text-muted-foreground rounded-full border px-2 py-0.5 text-xs font-normal">
              🔒 {t("settings.ownerOnly", voice)}
            </span>
          )}
        </SectionHeading>
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
                    disabled={!isOwner || voicePending}
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
      </section>

      <section className="space-y-2 border-t pt-4">
        <SectionHeading id="settings-demo" voice={voice} />
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
