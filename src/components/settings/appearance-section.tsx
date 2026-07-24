"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateAppearanceSettings } from "@/app/actions/settings";
import { CompleteTickColor, Typeface } from "@/lib/constants";
import {
  completionRootAttrs,
  COMPLETE_TICK,
  COMPLETE_TEXT,
} from "@/lib/completion-style";
import { typefaceRootAttrs } from "@/lib/typeface";
import { ThemeToggle } from "@/components/theme-toggle";
import { t, type StringKey, type Voice } from "@/lib/strings";
import {
  useSaveStatus,
  SaveIndicator,
} from "@/components/settings/use-save-status";
import { cn } from "@/lib/utils";

type AppearancePrefs = {
  completeStrikethrough: boolean;
  completeTickColor: string;
  typeface: string;
};

/** Radio labels for each typeface (both voices resolve via t()). */
const TYPEFACE_LABEL: Record<Typeface, StringKey> = {
  [Typeface.Figtree]: "appearance.typefaceFigtree",
  [Typeface.Atkinson]: "appearance.typefaceAtkinson",
  [Typeface.OpenDyslexic]: "appearance.typefaceOpenDyslexic",
  [Typeface.System]: "appearance.typefaceSystem",
};

/**
 * MR ③ — the Appearance group (Design C). Theme (light/dark) + the app-wide
 * completion style (Design D). Auto-saves each change (same pattern as
 * NotificationsSection). The completion controls carry a LIVE preview whose ✓ +
 * strike resolve from the same CSS custom properties the whole app uses, scoped
 * to the pending choice via completionRootAttrs — so the preview updates
 * instantly, before the server round-trip re-paints the shell.
 */
export function AppearanceSection({
  completeStrikethrough,
  completeTickColor,
  typeface,
  voice,
}: AppearancePrefs & { voice: Voice }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { status, markSaving, markSaved, markError } = useSaveStatus();
  const [prefs, setPrefs] = useState<AppearancePrefs>({
    completeStrikethrough,
    completeTickColor,
    typeface,
  });

  const persist = (next: AppearancePrefs) => {
    setPrefs(next); // optimistic: the live preview reflects the pending choice
    startTransition(async () => {
      markSaving();
      try {
        await updateAppearanceSettings(next);
        markSaved();
        router.refresh();
      } catch {
        markError();
      }
    });
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">
          {t("appearance.heading", voice)}
        </h2>
        <SaveIndicator status={status} voice={voice} />
      </div>

      {/* Theme (moved here so Appearance is a single group). */}
      <div className="space-y-1">
        <span className="text-muted-foreground text-xs">
          {t("appearance.theme", voice)}
        </span>
        <div>
          {/* Theme persists client-side (localStorage) instantly; flash the
              shared indicator so it gives the same "Saved" feedback as the
              completion controls below. */}
          <ThemeToggle
            onPersist={() => {
              markSaving();
              markSaved();
            }}
          />
        </div>
      </div>

      {/* App-wide completion style (Design D). */}
      <p className="text-muted-foreground text-sm">
        {t("appearance.completionIntro", voice)}
      </p>

      <label className="flex items-center gap-2 font-medium">
        <input
          type="checkbox"
          checked={prefs.completeStrikethrough}
          onChange={(e) =>
            persist({ ...prefs, completeStrikethrough: e.target.checked })
          }
        />
        {t("appearance.strike", voice)}
      </label>

      <fieldset className="space-y-1">
        <legend className="text-muted-foreground text-xs">
          {t("appearance.tick", voice)}
        </legend>
        {(Object.values(CompleteTickColor) as string[]).map((c) => (
          <label key={c} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="complete-tick-color"
              value={c}
              checked={prefs.completeTickColor === c}
              onChange={() => persist({ ...prefs, completeTickColor: c })}
            />
            {t(
              c === CompleteTickColor.Black
                ? "appearance.tickBlack"
                : "appearance.tickGreen",
              voice,
            )}
          </label>
        ))}
      </fieldset>

      {/* Live preview — the exact shared classes, scoped to the pending choice
          via the root data attributes. Status is glyph + text, never colour
          alone. */}
      <div
        {...completionRootAttrs(prefs)}
        data-testid="completion-preview"
        className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
      >
        <span className={cn("flex-1", COMPLETE_TEXT)}>
          {t("appearance.previewText", voice)}
        </span>
        <span className={COMPLETE_TICK} aria-label="done" title="done">
          ✓
        </span>
      </div>

      {/* Typeface picker (#40, a11y). A labelled radiogroup (fieldset + legend);
          the intro names the dyslexia/low-vision aids in both voices. Persists
          via the same optimistic persist() as the completion controls. */}
      <fieldset className="space-y-1" aria-describedby="typeface-help">
        <legend className="text-muted-foreground text-xs">
          {t("appearance.typeface", voice)}
        </legend>
        <p id="typeface-help" className="text-muted-foreground text-sm">
          {t("appearance.typefaceIntro", voice)}
        </p>
        {(Object.values(Typeface) as Typeface[]).map((f) => (
          <label key={f} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="typeface"
              value={f}
              checked={prefs.typeface === f}
              onChange={() => persist({ ...prefs, typeface: f })}
            />
            {t(TYPEFACE_LABEL[f], voice)}
          </label>
        ))}
      </fieldset>

      {/* Live preview — scoped to the pending typeface via data-font (same
          pattern as the completion preview), so the sample re-renders in the
          chosen face instantly, before the server round-trip re-paints the
          shell. globals.css [data-font] re-keys --font-sans off the attribute. */}
      <p
        {...typefaceRootAttrs(prefs)}
        data-testid="typeface-preview"
        className="rounded-lg border px-3 py-2 text-base"
      >
        {t("appearance.typefacePreview", voice)}
      </p>
    </section>
  );
}
