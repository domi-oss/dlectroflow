import { describe, it, expect } from "vitest";
import {
  HELP_SECTIONS,
  SETTINGS_SECTIONS,
  sectionById,
  sectionLabel,
  type SectionId,
} from "@/lib/section-nav";

const ALL = [...SETTINGS_SECTIONS, ...HELP_SECTIONS];

describe("section registries (#72)", () => {
  it("ids are unique across BOTH pages — they are global DOM ids and URL fragments", () => {
    const ids = ALL.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ids are fragment-safe (lowercase, no spaces) so #anchors stay linkable", () => {
    for (const { id } of ALL) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("covers every section that exists on each page today", () => {
    // Guards silent shrinkage: dropping a section from the registry without
    // dropping it from the page would leave an unlisted, unreachable section.
    // 11 since #199 added shopping-list mode's switch (10 after #118 Phase C's
    // signed-in-only Account section, 9 after #35 Phase B's owner-only People
    // section).
    expect(SETTINGS_SECTIONS.length).toBe(11);
    // 9 since the copy audit added "Where things end up" (Library + Activity) and
    // "Shopping list" — three of the app menu's seven destinations were
    // undocumented, and shopping-list mode is additionally OFF by default, so its
    // switch is the only thing that reveals the feature exists at all.
    // (7 after #129/#153 added "Your data" — export and self-deletion are rights a
    // reader arrives looking for, so they are a named section rather than a line
    // inside another one.)
    expect(HELP_SECTIONS.length).toBe(9);
  });

  it("resolves a settings label through the app voice — one source for nav + <h2>", () => {
    const appearance = sectionById("settings-appearance");
    expect(sectionLabel(appearance, "plain")).toBe("Appearance");
    expect(sectionLabel(appearance, "playful")).toBe("🎨 Appearance");
  });

  it("keeps Help labels plain English in either voice (the page is meta)", () => {
    const focus = sectionById("help-focus-session");
    expect(sectionLabel(focus, "plain")).toBe("The focus session");
    expect(sectionLabel(focus, "playful")).toBe("The focus session");
  });

  it("throws on an unknown id rather than silently rendering a dead anchor", () => {
    expect(() => sectionById("help-nope" as SectionId)).toThrow(/help-nope/);
  });
});
