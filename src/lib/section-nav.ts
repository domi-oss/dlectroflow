import { t, type StringKey, type Voice } from "@/lib/strings";

/**
 * #72 — the section registry behind the collapsible sticky "Jump to…" nav on
 * the two long pages (Settings, Help).
 *
 * ONE source of truth per section: the same entry supplies the on-page `<h2>`
 * text (via `<SectionHeading>`) and the nav entry's label (via `<SectionNav>`),
 * so a heading rename can never leave the nav pointing at a name that no longer
 * exists on the page. `id` is a real DOM id and a URL fragment — treat it as
 * part of the public surface (people bookmark and share `#settings-focus-timer`).
 */
export type SectionDef = {
  readonly id: string;
  /**
   * Either a voice-aware string key (Settings speaks the app's Plain/Playful
   * voice) or a literal (Help is deliberately voice-neutral — it is meta copy
   * about the app, see the note at the top of src/app/(app)/help/page.tsx).
   */
  readonly heading: { readonly key: StringKey } | { readonly text: string };
};

/** Resolve a section's single label — used for both the `<h2>` and the nav. */
export function sectionLabel(section: SectionDef, voice: Voice): string {
  return "key" in section.heading
    ? t(section.heading.key, voice)
    : section.heading.text;
}

/**
 * Settings sections, in the order the page renders them. `settings-people` and
 * `settings-integrations` are the two OWNER-ONLY entries — the page filters both
 * out of this list for anyone else, so a guest never gets a nav link to a section
 * that is not on their page (see `(app)/settings/page.tsx`).
 *
 * #101 — the order is FREQUENCY OF USE descending, with administration last
 * (owner-approved). Focus timer leads because it is the most-tuned surface in the
 * app; People closes the page because instance administration should not be what
 * greets you on your own settings page — it used to lead, which is what made the
 * reorder necessary. The page renders these top to bottom in exactly this order
 * (locked by src/app/(app)/settings/page.test.tsx), and every one of them is a
 * collapsible section.
 */
export const SETTINGS_SECTIONS = [
  { id: "settings-focus-timer", heading: { key: "focusSettings.heading" } },
  { id: "settings-appearance", heading: { key: "appearance.heading" } },
  { id: "settings-notifications", heading: { key: "notify.heading" } },
  { id: "settings-voice", heading: { text: "Voice" } },
  { id: "settings-aging", heading: { text: "Aging & reminder" } },
  { id: "settings-breakdown-model", heading: { text: "Breakdown model" } },
  { id: "settings-integrations", heading: { text: "Integrations" } },
  { id: "settings-demo", heading: { text: "Demo" } },
  { id: "settings-people", heading: { text: "People" } },
] as const satisfies readonly SectionDef[];

/** Help sections, in page order. */
export const HELP_SECTIONS = [
  { id: "help-getting-started", heading: { text: "Getting started" } },
  { id: "help-inbox-freshness", heading: { text: "The inbox & freshness" } },
  { id: "help-task-breakdown", heading: { text: "Task breakdown" } },
  { id: "help-focus-session", heading: { text: "The focus session" } },
  { id: "help-voice-settings", heading: { text: "Voice & settings" } },
  { id: "help-guests-ai-limits", heading: { text: "Guests & AI limits" } },
] as const satisfies readonly SectionDef[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
export type HelpSectionId = (typeof HELP_SECTIONS)[number]["id"];
/** Every id a `<SectionHeading>` may be asked to render — a typo is a type error. */
export type SectionId = SettingsSectionId | HelpSectionId;

const BY_ID: ReadonlyMap<string, SectionDef> = new Map(
  [...SETTINGS_SECTIONS, ...HELP_SECTIONS].map((s) => [s.id, s]),
);

/**
 * Look up a section by id. Throws rather than returning `undefined`: a missing
 * entry means the page would render a heading the nav cannot link to (or an
 * anchor that goes nowhere), which is exactly the drift this registry exists to
 * prevent — better a loud failure in dev/CI than a dead link in production.
 */
export function sectionById(id: SectionId): SectionDef {
  const section = BY_ID.get(id);
  if (!section) throw new Error(`Unknown page section id: ${id}`);
  return section;
}

/**
 * #101 — "I am working in this section now", published on `window`.
 *
 * Owner request: clicking a section header must highlight that section's title.
 * The highlight is !162's existing magenta current-section treatment, and the
 * only component that can apply it is `<SectionNav>` — it owns the `current`
 * state, and the headings live OUTSIDE its React tree (Help renders them from a
 * server component, Settings from nine separate client components). There is no
 * shared React state to thread a click through, so the click is published as one
 * DOM event the nav subscribes to. Same reasoning as the `data-current` attribute
 * the nav already writes onto the heading band: across that boundary, the DOM
 * *is* the channel.
 */
export const SECTION_ACTIVATE_EVENT = "dlectroflow:section-activate";

/** Payload of {@link SECTION_ACTIVATE_EVENT}: the id of the section clicked. */
export type SectionActivateDetail = { readonly id: string };

/** Publish {@link SECTION_ACTIVATE_EVENT}. No-op outside the browser. */
export function announceSectionActive(id: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<SectionActivateDetail>(SECTION_ACTIVATE_EVENT, {
      detail: { id },
    }),
  );
}
