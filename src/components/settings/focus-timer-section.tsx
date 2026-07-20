"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateFocusTimerSettings } from "@/app/actions/settings";
import { FocusTimerStyle, FocusSound } from "@/lib/constants";
import { resolveTimerStyle } from "@/lib/focus-timer-style";
import { t, type Voice } from "@/lib/strings";
import { useSaveStatus, SaveIndicator } from "@/components/settings/use-save-status";
import { TimerStylePreview } from "@/components/focus/timer-style-preview";

type Prefs = {
  timerStyle: string | null;
  minimalMode: boolean;
  keepAwake: boolean;
  alarmEnabled: boolean;
  sound: string;
};

/**
 * MR ② — the Focus-timer settings group. Auto-saves each change (no Save
 * button), mirroring NotificationsSection. The style selector offers the four
 * explicit visuals (ring / digits / bar / mug), each with a small static
 * preview. The DB column stays nullable (null = never chosen → the timer
 * resolves a style from the voice via resolveTimerStyle); when the stored value
 * is null we preselect that voice-resolved default (mug for playful, ring for
 * plain) so one option is always shown selected, and picking any option persists
 * that explicit value. A failed write surfaces a non-blocking error and leaves
 * the controls editable.
 */
export function FocusTimerSection({
  timerStyle,
  minimalMode,
  keepAwake,
  alarmEnabled,
  sound,
  voice,
}: Prefs & { voice: Voice }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { status, markSaving, markSaved, markError } = useSaveStatus();
  const [prefs, setPrefs] = useState<Prefs>({ timerStyle, minimalMode, keepAwake, alarmEnabled, sound });

  const persist = (next: Prefs) =>
    startTransition(async () => {
      markSaving();
      try {
        await updateFocusTimerSettings(next);
        markSaved();
        router.refresh();
      } catch {
        markError();
      }
    });

  const set = <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    persist(next);
  };

  const styleOptions: { value: FocusTimerStyle; label: string }[] = [
    { value: FocusTimerStyle.Ring, label: t("focusSettings.styleRing", voice) },
    { value: FocusTimerStyle.Digits, label: t("focusSettings.styleDigits", voice) },
    { value: FocusTimerStyle.Bar, label: t("focusSettings.styleBar", voice) },
    { value: FocusTimerStyle.Mug, label: t("focusSettings.styleMug", voice) },
  ];
  // A null stored style means "not yet chosen" — show the voice-resolved default
  // (mug for playful, ring for plain) selected so one option is always active.
  const selectedStyle = resolveTimerStyle(prefs.timerStyle, voice);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{t("focusSettings.heading", voice)}</h2>
        <SaveIndicator status={status} voice={voice} />
      </div>
      <p className="text-muted-foreground text-sm">{t("focusSettings.intro", voice)}</p>

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">{t("focusSettings.style", voice)}</legend>
        {styleOptions.map((o) => (
          <label key={o.value} className="flex min-h-[44px] items-center gap-2 text-sm">
            <input
              type="radio"
              name="focusTimerStyle"
              checked={selectedStyle === o.value}
              onChange={() => set("timerStyle", o.value)}
            />
            <TimerStylePreview style={o.value} />
            {o.label}
          </label>
        ))}
      </fieldset>

      <Toggle
        label={t("focusSettings.minimal", voice)}
        hint={t("focusSettings.minimalHint", voice)}
        checked={prefs.minimalMode}
        onChange={(v) => set("minimalMode", v)}
      />
      <Toggle
        label={t("focusSettings.keepAwake", voice)}
        hint={t("focusSettings.keepAwakeHint", voice)}
        checked={prefs.keepAwake}
        onChange={(v) => set("keepAwake", v)}
      />
      <Toggle
        label={t("focusSettings.alarm", voice)}
        hint={t("focusSettings.alarmHint", voice)}
        checked={prefs.alarmEnabled}
        onChange={(v) => set("alarmEnabled", v)}
      />

      <label className="flex min-h-[44px] items-center justify-between gap-2 text-sm">
        <span className="font-medium">{t("focusSettings.sound", voice)}</span>
        <select
          value={prefs.sound}
          onChange={(e) => set("sound", e.target.value)}
          className="border-input rounded-md border px-2 py-1"
        >
          <option value={FocusSound.Off}>{t("focusSettings.soundOff", voice)}</option>
          <option value={FocusSound.LofiCalm}>{t("focusSettings.soundLofiCalm", voice)}</option>
        </select>
      </label>
    </section>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex min-h-[44px] items-start justify-between gap-3 text-sm">
      <span className="flex flex-col">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground text-xs">{hint}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-5 w-5 shrink-0"
      />
    </label>
  );
}
