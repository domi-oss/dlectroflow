"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

import { cn, controlSurface, touchTarget } from "@/lib/utils";
import { t, type StringKey, type Voice } from "@/lib/strings";
import {
  THEME_ATTRIBUTE,
  THEME_PREFERENCES,
  applyThemePreference,
  normaliseThemePreference,
  persistThemePreference,
  type ThemePreference,
} from "@/lib/theme";

// #23 — the `dark` class on <html> is the theme's single source of truth (the
// pre-hydration inline script sets it, and every toggle writes it), so read it
// as an external store instead of copying it into state from an effect
// (react-hooks/set-state-in-effect). Same pattern as usePrefersReducedMotion.
// Bonus: two mounted toggles (header + Settings > Appearance) can no longer
// drift apart, because both render straight from the class.
//
// #85 — the element now carries TWO facts and both are watched here: the `class`
// is the RESOLVED theme (what is painted) and `data-theme` is the PREFERENCE
// (system / light / dark). One store, two snapshots, because the resolved class
// can no longer express the setting — "no .dark" is either an explicit light
// choice or `system` on a light device, and the radiogroup below has to tell
// them apart.
function subscribe(onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", THEME_ATTRIBUTE],
  });
  return () => observer.disconnect();
}

function getSnapshot(): boolean {
  return document.documentElement.classList.contains("dark");
}

/** Server / pre-hydration snapshot — light, matching the SSR'd markup. */
function getServerSnapshot(): boolean {
  return false;
}

function getPreferenceSnapshot(): ThemePreference {
  return normaliseThemePreference(
    document.documentElement.getAttribute(THEME_ATTRIBUTE),
  );
}

/**
 * Server / pre-hydration snapshot — `system`, the new default, matching the
 * markup the server rendered (which carries no `data-theme` at all).
 *
 * `useSyncExternalStore` uses this for the hydration pass and re-renders with
 * the real value immediately afterwards, so a returning user's explicit choice
 * is not a hydration mismatch — the same contract `useMediaQuery` documents.
 */
function getPreferenceServerSnapshot(): ThemePreference {
  return "system";
}

/**
 * Apply a preference and report whether it was remembered.
 *
 * One writer for both controls below, so the header button and the Settings
 * radiogroup cannot persist different things — and `onPersist` still fires only
 * on a successful write, so "Saved ✓" is never shown for a storage that refused
 * (private mode).
 */
function choosePreference(pref: ThemePreference, onPersist?: () => void): void {
  applyThemePreference(pref);
  if (persistThemePreference(pref)) onPersist?.();
}

/**
 * How the control presents itself (#103).
 *
 * - `text` — icon + words ("Dark mode" / "Light mode"). The default, so a call
 *   site can never silently lose its label. Used in Settings > Appearance,
 *   where a bare icon in a settings row would be worse than the label it
 *   replaced.
 * - `icon` — glyph only, for the header menu bar, where the words are dead
 *   weight and crowd the bar at 390px.
 */
type ThemeToggleVariant = "text" | "icon";

export function ThemeToggle({
  onPersist,
  variant = "text",
}: {
  onPersist?: () => void;
  variant?: ThemeToggleVariant;
}) {
  const dark = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = () => {
    // #85 — this writes an EXPLICIT override, and it is keyed off the RESOLVED
    // theme rather than off the stored preference. That distinction is the whole
    // behaviour of the button on a `system` device: what is on screen is dark,
    // so one press must give light. Keying off the preference instead would
    // store "dark" while dark was already painted, and the button would appear
    // to do nothing.
    //
    // Writing to <html> is what flips this control: the observer above sees the
    // mutation and re-renders every mounted theme control.
    choosePreference(dark ? "light" : "dark", onPersist);
  };

  // #103 — lucide, not 🌙/☀️: the rest of the app moved to lucide in !141, and
  // emoji render differently on every platform (the VS16 variation selector
  // also makes their advance width unpredictable, which is part of why the
  // header button was so wide). Decorative in both variants — the accessible
  // name comes from the visible words or the aria-label, never the glyph.
  const Icon = dark ? Sun : Moon;

  // #252 — moved verbatim to `controlSurface` in @/lib/utils, because the header
  // now renders the shopping and focus quick-access links beside this button and
  // all three have to read as one set. A local copy per control is how the two
  // popup menus drifted apart in #117.
  const shared = controlSurface;

  if (variant === "icon") {
    // Dropping the visible words drops the button's accessible name with them,
    // so it is spelled out here. It names the ACTION the click performs ("switch
    // to …"), not the current state — and `title` gives a pointer user the same
    // string on hover. aria-pressed still carries the state for AT.
    const label = dark ? "Switch to light mode" : "Switch to dark mode";
    return (
      <button
        type="button"
        onClick={toggle}
        // A bare 20px glyph is far short of a hit target, so square it up to
        // the shared 44px minimum (WCAG 2.5.5) — the same size as the header's
        // menu trigger next to it, so the two line up.
        className={cn(shared, touchTarget)}
        aria-pressed={dark}
        aria-label={label}
        title={label}
      >
        <Icon aria-hidden="true" className="h-5 w-5" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={cn(
        shared,
        "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm",
      )}
      aria-pressed={dark}
    >
      {/* No aria-label on this variant: it would override the visible text and
          break WCAG 2.5.3 (Label in Name) for voice-control users. */}
      <Icon aria-hidden="true" className="h-4 w-4" />
      {dark ? "Light mode" : "Dark mode"}
    </button>
  );
}

/** One label per preference. */
const THEME_LABEL: Record<ThemePreference, StringKey> = {
  system: "appearance.themeSystem",
  light: "appearance.themeLight",
  dark: "appearance.themeDark",
};

/**
 * The three-state theme setting — #85. Settings > Appearance.
 *
 * ## Why a radiogroup and not a third state on the button
 *
 * Three mutually exclusive options is the definition of a radiogroup, and
 * `aria-pressed` — which the header button uses — is boolean, so it cannot carry
 * a third state at all. A cycling button could, but only by making the next
 * press unpredictable, which is the opposite of what this app is for. It also
 * lands as the third radiogroup in this section, beside tick colour and typeface,
 * so it reads as one more setting rather than as a special control.
 *
 * ## Why it replaced the toggle here rather than joining it
 *
 * A toggle plus a separate "follow my system" affordance is two controls for one
 * setting, and they can contradict each other on screen. The words the #103
 * decision protected in this row are still visible — they are now the three
 * option labels — and the header keeps the two-state button, which is what that
 * decision was actually about.
 *
 * Selection is read from `<html>`, not held in state, so this control and the
 * header button cannot drift (#23) and neither can a second copy of either.
 */
export function ThemePreferenceChoice({
  voice,
  onPersist,
}: {
  voice: Voice;
  onPersist?: () => void;
}) {
  const preference = useSyncExternalStore(
    subscribe,
    getPreferenceSnapshot,
    getPreferenceServerSnapshot,
  );

  return (
    <fieldset className="space-y-1" aria-describedby="theme-help">
      <legend className="text-muted-foreground text-xs">
        {t("appearance.theme", voice)}
      </legend>
      {/* Associated with the group rather than left beside it, so a screen
          reader hears WHY "Follow my system" is the default — the platforms
          already switch on a schedule, which is the automatic behaviour this
          setting was asked for. */}
      <p id="theme-help" className="text-muted-foreground text-sm">
        {t("appearance.themeIntro", voice)}
      </p>
      {THEME_PREFERENCES.map((pref) => (
        <label key={pref} className="flex items-center gap-2 text-sm">
          {/* Unstyled, like the tick-colour and typeface radios above: the UA's
              own focus ring and checked state are kept rather than replaced, so
              there is no focus indicator to kill (a11y-class-hygiene, 2.4.7). */}
          <input
            type="radio"
            name="theme-preference"
            value={pref}
            checked={preference === pref}
            onChange={() => choosePreference(pref, onPersist)}
          />
          {t(THEME_LABEL[pref], voice)}
        </label>
      ))}
    </fieldset>
  );
}
