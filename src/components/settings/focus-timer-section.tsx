"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateFocusTimerSettings } from "@/app/actions/settings";
import { FocusTimerStyle, FocusSound } from "@/lib/constants";
import { resolveTimerStyle } from "@/lib/focus-timer-style";
import { t, type Voice } from "@/lib/strings";
import {
  useSaveStatus,
  SaveIndicator,
} from "@/components/settings/use-save-status";
import { TimerStylePreview } from "@/components/focus/timer-style-preview";
import { CollapsibleSection } from "@/components/nav/collapsible-section";

type Prefs = {
  timerStyle: string | null;
  minimalMode: boolean;
  keepAwake: boolean;
  alarmEnabled: boolean;
  /**
   * #180 — Settings.focusSound, now just "off" | "on". Which playlists and which
   * track are decisions made in the player during a session (#181), so this page
   * holds the switch and nothing else about music.
   */
  sound: string;
  /** #65 — opt-in music↔timer pause coupling (Settings.focusPauseTogether). */
  pauseTogether: boolean;
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
  pauseTogether,
  voice,
  defaultExpanded,
}: Prefs & { voice: Voice; defaultExpanded?: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { status, markSaving, markSaved, markError } = useSaveStatus();
  const [prefs, setPrefs] = useState<Prefs>({
    timerStyle,
    minimalMode,
    keepAwake,
    alarmEnabled,
    sound,
    pauseTogether,
  });

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
    {
      value: FocusTimerStyle.Digits,
      label: t("focusSettings.styleDigits", voice),
    },
    { value: FocusTimerStyle.Bar, label: t("focusSettings.styleBar", voice) },
    { value: FocusTimerStyle.Mug, label: t("focusSettings.styleMug", voice) },
  ];
  // A null stored style means "not yet chosen" — show the voice-resolved default
  // (mug for playful, ring for plain) selected so one option is always active.
  const selectedStyle = resolveTimerStyle(prefs.timerStyle, voice);

  return (
    <CollapsibleSection
      id="settings-focus-timer"
      voice={voice}
      defaultExpanded={defaultExpanded}
      headingExtras={<SaveIndicator status={status} voice={voice} />}
    >
      <p className="text-muted-foreground text-sm">
        {t("focusSettings.intro", voice)}
      </p>

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">
          {t("focusSettings.style", voice)}
        </legend>
        {styleOptions.map((o) => (
          <label
            key={o.value}
            className="flex min-h-[44px] items-center gap-2 text-sm"
          >
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

      {/* #180 — one switch, and nothing else about music on this page.
          "Is there sound" is a settled preference; "what do I want to hear" is a
          decision you make while listening, so the ten tracks, their previews and
          the category playlists all moved to the in-session player (#181). Two
          surfaces answering overlapping questions was the problem, not the number
          of controls. */}
      <Toggle
        label={t("focusSettings.sound", voice)}
        hint={t("focusSettings.soundHint", voice)}
        checked={prefs.sound === FocusSound.On}
        onChange={(v) => set("sound", v ? FocusSound.On : FocusSound.Off)}
      />
      {/* Says where the rest of it went. Without this the removal reads as a lost
          feature rather than a moved one, which is the single most likely way a
          simplification gets reported as a regression. */}
      <p className="text-muted-foreground -mt-1 text-xs">
        {t("focusSettings.soundPlayerHint", voice)}
      </p>

      {/* #65 — sits under the sound picker rather than with the timer toggles
          above: it's a behaviour of the MUSIC (what pausing it should do), and
          it's the one focus pref that can stop a running session, so its hint
          spells out both directions before you turn it on. Left enabled when
          sound is "off" — nothing to pause then, so a stored true is simply
          inert (same as focusShuffle), and hiding it would only make the pref
          vanish while someone is picking a track. */}
      <Toggle
        label={t("focusSettings.pauseTogether", voice)}
        hint={t("focusSettings.pauseTogetherHint", voice)}
        checked={prefs.pauseTogether}
        onChange={(v) => set("pauseTogether", v)}
      />
    </CollapsibleSection>
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
