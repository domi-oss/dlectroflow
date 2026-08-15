/**
 * The theme setting — #85.
 *
 * ## Three states, not two
 *
 * `df-theme` used to hold `light | dark` and the app had no OS path at all: the
 * `<head>` bootstrap added `.dark` only for the literal string `"dark"`, so a
 * first visit landed on light whatever the device was set to. That is the whole
 * defect. The setting is now `system | light | dark` with **`system` as the
 * default**, and `system` reads `prefers-color-scheme` — which is also how
 * "dark mode automatic with time of day" gets delivered, because macOS, iOS,
 * Windows and Android all already switch appearance on a schedule. The app does
 * not need a scheduler of its own; it needs to stop ignoring theirs.
 *
 * ## Two values on `<html>`, and why
 *
 * - `class="dark"` — the RESOLVED theme. Unchanged: it is what Tailwind's dark
 *   variant keys off and what every existing test and e2e helper reads.
 * - `data-theme` — the PREFERENCE. New, because the resolved class can no longer
 *   express the setting: `.dark` absent means "light", which could be an
 *   explicit choice or a `system` preference on a light device, and the Settings
 *   radiogroup has to tell those apart.
 *
 * Both live on the element rather than in React state, which keeps #23's single
 * source of truth: the bootstrap writes them before hydration, every control
 * reads them through a `MutationObserver`, and two mounted controls cannot
 * drift apart.
 *
 * ## Pure by design
 *
 * No `"use client"` and no hooks, so `src/app/layout.tsx` — a Server Component
 * — can import `THEME_BOOTSTRAP_SCRIPT` without turning the root layout into a
 * client boundary. The DOM helpers below touch `document`/`localStorage` only
 * when called, which is only ever from client code.
 */

/** localStorage key. Unchanged since #23, so existing choices survive. */
export const THEME_STORAGE_KEY = "df-theme";

/** Attribute on `<html>` carrying the PREFERENCE (not the resolved theme). */
export const THEME_ATTRIBUTE = "data-theme";

/** The one media query this feature is about. */
export const PREFERS_DARK_QUERY = "(prefers-color-scheme: dark)";

/** What the user chose. `system` defers to `prefers-color-scheme`. */
export type ThemePreference = "system" | "light" | "dark";

/** What actually gets painted. */
export type ResolvedTheme = "light" | "dark";

/**
 * Every preference, in the order the Settings radiogroup offers them —
 * `system` first, because it is the default.
 */
export const THEME_PREFERENCES: readonly ThemePreference[] = [
  "system",
  "light",
  "dark",
];

/**
 * Read a stored `df-theme` value tolerantly.
 *
 * `light` and `dark` are the only values shipped code has ever written to this
 * key (`theme-toggle.tsx`, since #23), and both are kept — so anyone who has
 * already pressed the toggle keeps the choice they made rather than being
 * silently moved onto `system`. Everything else — an unset key on a first visit,
 * an empty string, a value some future version writes — resolves to `system`.
 *
 * ⚠️ Matching is EXACT: no trimming, no lower-casing. Not laziness — the same
 * comparison has to be made by the pre-hydration script below, where every byte
 * is on the critical path of the first paint, and two normalisers that differ by
 * a `.trim()` would diverge only for inputs nothing has ever written. The
 * equivalence is asserted in theme.test.ts across the whole cross-product.
 */
export function normaliseThemePreference(
  raw: string | null | undefined,
): ThemePreference {
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

/** Fold a preference and the OS setting into the theme to paint. */
export function resolveTheme(
  pref: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (pref === "system") return systemPrefersDark ? "dark" : "light";
  return pref;
}

/**
 * The anti-FOUC bootstrap, as the string that ships in `<head>`.
 *
 * Built from the constants above so a rename cannot leave the script pointing
 * at the old key, and asserted by EXECUTING it (theme.test.ts) rather than by
 * matching its source text.
 *
 * Requirements it has to meet at once, which is why it looks the way it does:
 *
 *  - **Synchronous, in `<head>`, before `<body>` is parsed.** Anything later —
 *    a hook, an effect, a deferred script — paints the light default first and
 *    corrects it a frame afterwards, which is the flash this replaces rather
 *    than introduces.
 *  - **Cannot throw.** An exception here aborts the rest of the script and takes
 *    a returning user's explicit dark theme down with it, so both the storage
 *    read (private mode makes `localStorage` throw on access) and the whole body
 *    are wrapped. `matchMedia` is feature-detected for the same reason.
 *  - **No interpolation of anything runtime.** Every substitution below is a
 *    module constant passed through `JSON.stringify`, so nothing user-supplied
 *    can reach the inlined source. It also contains no `</`, so it cannot
 *    terminate the `<script>` element it lives in — both are asserted.
 *  - **Agrees with the server-rendered markup, or `suppressHydrationWarning`
 *    has to cover the difference.** `<html>` already carries that prop (it has
 *    to: the class was always written here), which is what keeps this out of
 *    the #75 hydration-mismatch class of bug.
 */
export const THEME_BOOTSTRAP_SCRIPT = [
  "try{",
  "var d=document.documentElement,r=null;",
  `try{r=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch(e){}`,
  'var p=r==="light"||r==="dark"||r==="system"?r:"system",',
  'k=p==="dark"||(p==="system"&&typeof matchMedia==="function"&&',
  `matchMedia(${JSON.stringify(PREFERS_DARK_QUERY)}).matches);`,
  `d.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)},p);`,
  'd.classList.toggle("dark",k)',
  "}catch(e){}",
].join("");

// ── Client-side helpers ──────────────────────────────────────────────────────
// Callable only from the browser. Kept here rather than in the components so
// the header toggle, the Settings radiogroup and the OS listener all write the
// theme exactly one way.

/** The OS setting right now. `false` where `matchMedia` is unavailable. */
export function systemPrefersDark(): boolean {
  if (typeof matchMedia !== "function") return false;
  return matchMedia(PREFERS_DARK_QUERY).matches;
}

/** The preference currently on `<html>`, i.e. what the bootstrap resolved. */
export function readThemePreference(): ThemePreference {
  if (typeof document === "undefined") return "system";
  return normaliseThemePreference(
    document.documentElement.getAttribute(THEME_ATTRIBUTE),
  );
}

/** Write both values on `<html>`. Every visible control re-renders from these. */
export function applyThemePreference(pref: ThemePreference): void {
  const root = document.documentElement;
  root.setAttribute(THEME_ATTRIBUTE, pref);
  root.classList.toggle(
    "dark",
    resolveTheme(pref, systemPrefersDark()) === "dark",
  );
}

/**
 * Persist the preference. Returns whether it actually stuck.
 *
 * The boolean is load-bearing: Settings > Appearance only shows "Saved ✓" on a
 * successful write, so in private mode — where `setItem` throws — the choice
 * applies for this session and does not claim to have been remembered.
 */
export function persistThemePreference(pref: ThemePreference): boolean {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
    return true;
  } catch {
    return false;
  }
}
