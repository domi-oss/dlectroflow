"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Play, Square } from "lucide-react";
import { useRouter } from "next/navigation";
import { updateFocusTimerSettings } from "@/app/actions/settings";
import { FocusTimerStyle, FocusSound } from "@/lib/constants";
import { resolveTimerStyle } from "@/lib/focus-timer-style";
import {
  FOCUS_SOUND_TRACKS,
  MIN_CATEGORY_PLAYLIST_TRACKS,
  createPreviewPlayer,
  focusTrackForCategory,
  offerableFocusCategories,
  type PreviewPlayer,
} from "@/lib/focus-sounds";
import { useFocusCatalog } from "@/lib/use-focus-catalog";
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
  sound: string;
  /**
   * #70 — the category playlist (Settings.focusSoundCategory). null = the whole
   * list, which is what every instance with no reachable catalog stores.
   */
  category: string | null;
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
  category,
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
    category,
    pauseTogether,
  });

  // #70 — which categories are worth offering is a question about the DATA, not
  // about configuration: `useFocusCatalog` returns the bundled ten plus whatever
  // the streamed catalog added, and a category only becomes a playlist once it
  // holds more than one of them. On an instance with no reachable catalog this is
  // empty, and the whole group below is absent rather than disabled — ten radios
  // that each play a single track is exactly what #70 was blocked on.
  const tracks = useFocusCatalog();
  const categories = useMemo(() => {
    // `min: 1` then filtered, rather than the default floor, so a STORED
    // selection that has dropped below the floor (the store stopped answering)
    // stays on screen. It is still live — the player honours it — and hiding it
    // would leave a preference nobody can see or clear.
    return offerableFocusCategories(tracks, 1).filter(
      (c) =>
        c.count >= MIN_CATEGORY_PLAYLIST_TRACKS || c.slug === prefs.category,
    );
  }, [tracks, prefs.category]);

  // #43 — one shared preview player: auditioning a track stops any previous
  // preview. Created lazily on first click (a user gesture, so autoplay unlocks).
  const previewRef = useRef<PreviewPlayer | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  useEffect(() => () => previewRef.current?.stop(), []);

  const togglePreview = (id: string, src: string) => {
    if (!previewRef.current) previewRef.current = createPreviewPlayer();
    if (previewingId === id) {
      previewRef.current.stop();
      setPreviewingId(null);
      return;
    }
    previewRef.current.play(src, () => setPreviewingId(null));
    setPreviewingId(id);
  };

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

  /**
   * #70 — the sound selection is TWO fields, and one radio group.
   *
   * "Off", a category and an individual track are mutually exclusive options in
   * `name="focusSound"`, but the answer they produce needs both "which category is
   * the playlist" and "which track does the session open on" — a category still
   * has to start somewhere. So every choice here writes both, and `set` (one key
   * at a time) cannot express it: two sequential `set` calls would persist the
   * intermediate state, briefly saving a category against the wrong track.
   */
  const pickSound = (sound: string, category: string | null) => {
    const next = { ...prefs, sound, category };
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

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">
          {t("focusSettings.sound", voice)}
        </legend>
        <p className="text-muted-foreground text-xs">
          {t("focusSettings.soundPickerHint", voice)}
        </p>
        {/* Off */}
        <label className="flex min-h-[44px] items-center gap-2 text-sm">
          <input
            type="radio"
            name="focusSound"
            checked={prefs.sound === FocusSound.Off}
            onChange={() => pickSound(FocusSound.Off, null)}
          />
          {t("focusSettings.soundOff", voice)}
        </label>

        {/* #70 — category playlists, in the SAME radio group as the tracks:
            "off", "this whole category" and "start on this track" are three
            answers to one question, so exactly one of them can be selected.
            Rendered only when the data supports it (see `categories` above) —
            absent, not disabled, on an instance with no reachable catalog. */}
        {categories.length > 0 && (
          <>
            <p className="text-muted-foreground text-xs">
              {t("focusSettings.soundCategoryHint", voice)}
            </p>
            {categories.map((c) => (
              <label
                key={c.slug}
                className="flex min-h-[44px] items-center gap-2 text-sm"
              >
                <input
                  type="radio"
                  name="focusSound"
                  checked={prefs.category === c.slug}
                  onChange={() =>
                    // The bundled track of the category. `offerableFocusCategories`
                    // only returns the ten, and each has exactly one bundled track
                    // (asserted in focus-sounds.test.ts), so the fallback is
                    // unreachable — it is here so a future eleventh category
                    // cannot silently persist a category against no track.
                    pickSound(
                      focusTrackForCategory(c.slug)?.id ?? prefs.sound,
                      c.slug,
                    )
                  }
                />
                <span className="min-w-0">
                  <span className="font-medium">
                    {c.label} — {t("focusSettings.soundWholeCategory", voice)}
                  </span>{" "}
                  <span className="text-muted-foreground">
                    · {c.count}{" "}
                    {t(
                      c.count === 1
                        ? "focusSettings.soundTrackCountOne"
                        : "focusSettings.soundTrackCount",
                      voice,
                    )}
                  </span>
                </span>
              </label>
            ))}
          </>
        )}

        {/* One curated CC0 track per category, each with a preview toggle. The
            list stays the BUNDLED ten: a streamed track's id cannot be persisted
            (see CATALOG_TRACK_ID_PREFIX), so offering one as a start track would
            be a control that does not stick. Its category can be, which is what
            the group above is for. */}
        {FOCUS_SOUND_TRACKS.map((track) => {
          const isPreviewing = previewingId === track.id;
          return (
            <div key={track.id} className="flex items-center gap-2">
              <label className="flex min-h-[44px] flex-1 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="focusSound"
                  // A category selection owns the group: the track it opens on is
                  // not separately "chosen", and showing two checked radios in one
                  // group would misstate the state.
                  checked={!prefs.category && prefs.sound === track.id}
                  onChange={() => pickSound(track.id, null)}
                />
                <span className="min-w-0">
                  <span className="font-medium">{track.title}</span>{" "}
                  <span className="text-muted-foreground">
                    · {track.categoryLabel}
                  </span>
                </span>
              </label>
              <button
                type="button"
                onClick={() => togglePreview(track.id, track.src)}
                aria-pressed={isPreviewing}
                aria-label={`${t(
                  isPreviewing
                    ? "focusSettings.stopPreview"
                    : "focusSettings.preview",
                  voice,
                )} — ${track.title}`}
                className="hover:bg-accent inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md border"
              >
                {isPreviewing ? (
                  <Square aria-hidden="true" className="h-4 w-4" />
                ) : (
                  <Play aria-hidden="true" className="h-4 w-4" />
                )}
              </button>
            </div>
          );
        })}
      </fieldset>

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
