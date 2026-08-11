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
import { useOptimisticOwnership } from "@/components/settings/revert-optimistic";
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
  /**
   * #252 — does the header carry a one-tap shortcut to the timer?
   * (`Settings.focusQuickAccess`, which defaults ON.)
   *
   * A member of `Prefs` rather than a prop this section reads separately,
   * because every write here sends the WHOLE group: `updateFocusTimerSettings`
   * leaves the column alone when the key is absent, so a partial payload would
   * make "change the timer style" the one path that cannot turn the shortcut
   * off. Being in `Prefs` also enrols it in the #227 rollback ledger for free.
   */
  quickAccess: boolean;
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
 *
 * ## A failed save both speaks and steps back (#227)
 *
 * Audited alongside the two sites #227 names, and it was NOT already correct:
 * `set()` wrote `prefs` optimistically and `persist`'s catch reported the
 * failure without restoring it, so a refused write left five switches and the
 * style radiogroup showing values the server had declined — an error message
 * next to controls still reading the way the user set them.
 *
 * `timerStyle` is the part worth spelling out. `null` means "never chosen", and
 * the UI renders the voice-resolved default for it, so a rollback that lost the
 * null would quietly promote that default into an explicit stored choice — the
 * exact write this section has just failed to make. The `revert-optimistic`
 * ledger restores the field's stored value rather than the value it renders as,
 * which is why the rollback goes through it and not through
 * `setPrefs(previous)`; that also keeps a slow failure from clobbering a newer
 * success, since nothing here disables a control during a save. Ownership is a
 * per-attempt token rather than a value comparison, because re-picking an
 * earlier style puts that value back on screen without transferring ownership
 * to the attempt that first wrote it.
 */
export function FocusTimerSection({
  timerStyle,
  minimalMode,
  keepAwake,
  alarmEnabled,
  sound,
  pauseTogether,
  quickAccess,
  voice,
  defaultExpanded,
}: Prefs & { voice: Voice; defaultExpanded?: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { status, markSaving, markSaved, markError } = useSaveStatus();
  const ownership = useOptimisticOwnership<Prefs>();
  const [prefs, setPrefs] = useState<Prefs>({
    timerStyle,
    minimalMode,
    keepAwake,
    alarmEnabled,
    sound,
    pauseTogether,
    quickAccess,
  });

  const persist = (next: Prefs, previous: Prefs) => {
    // Claimed in the same synchronous turn as the optimistic `setPrefs(next)`
    // above, so attempts are ordered the way the user made the changes.
    const attempt = ownership.claim(next, previous);
    startTransition(async () => {
      markSaving();
      try {
        await updateFocusTimerSettings(next);
        // What the server now holds, so a later failure undoes to this rather
        // than to some earlier attempt's unconfirmed guess.
        attempt.confirm();
        markSaved();
        router.refresh();
      } catch {
        // #227 — say so AND put the control back. The functional updater reads
        // the state as it stands now, not this closure's `prefs`; the attempt
        // restores only the fields it still owns, and it restores a null
        // `timerStyle` as a null rather than as the default the UI renders in
        // its place.
        setPrefs((current) => attempt.revert(current));
        markError();
      }
    });
  };

  const set = <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    persist(next, prefs);
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

      {/* #252 — last in the group, because it is the only switch here that
          changes something OUTSIDE the focus session: the other five are about
          what happens once you have started. It is a plain boolean like
          focusShuffle, so coercion in the action is the only validation needed,
          and it defaults ON — focus is the payoff step of the core loop and the
          button was asked for, so an account that never opens this page should
          have it. The hint says the timer stays in the menu, because "hide the
          shortcut" and "disable the timer" look identical from a checkbox. */}
      <Toggle
        label={t("focusSettings.quickAccess", voice)}
        hint={t("focusSettings.quickAccessHint", voice)}
        checked={prefs.quickAccess}
        onChange={(v) => set("quickAccess", v)}
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
