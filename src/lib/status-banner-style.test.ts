import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { STATUS_BANNER_TONE } from "@/lib/status-banner-style";
import { findTintedBannerText } from "@/lib/a11y-class-hygiene";

/**
 * #109 — the composite half of the contrast problem, which Rules A and B in
 * `a11y-class-hygiene.ts` explicitly cannot judge.
 *
 * Those rules check the TOKEN: no bare `-600`, always a `dark:` partner. Six
 * banners in this repo satisfied them and still failed AA, because a translucent
 * `bg-<family>-<n>/10` composites over `--background` and pulls the effective
 * background *toward* the text. `text-green-700` is 4.65:1 on the bare light
 * background and **4.16:1** once its own tint is in the way. One of the six
 * carried a comment asserting the opposite.
 *
 * Measuring a composite from source is not something a class scanner can do, so
 * the split is: `findTintedBannerText` reports the *shape* (a translucent
 * chromatic tint with no dark background of its own, plus the chromatic text
 * colours on it), and this file requires those colours to come from the one table
 * whose ratios were actually measured. Structural rather than photometric, with
 * the same effect — it makes the seventh banner impossible rather than unlikely.
 *
 * The measured numbers live in `status-banner-style.ts` next to the values they
 * describe; the shape detection lives in the pure module where it can be
 * exercised on synthetic input, which is this repo's convention for a guard (a
 * guard whose predicate can only be run against the real tree cannot be shown to
 * fail). Both halves were review findings on !250.
 */

const TONE_TOKENS = new Set(
  Object.values(STATUS_BANNER_TONE).flatMap((tone) => tone.split(/\s+/)),
);

/** An unprefixed palette text colour, for the table's own shape assertions. */
const PALETTE_TEXT = /^text-[a-z]+-\d{2,3}$/;

/**
 * All of `src/`, **including `status-banner-style.ts` itself.**
 *
 * It was excluded at first, on the reflex that a guard should not scan its own
 * subject. That was wrong here, and the "the scan is not a no-op" test below is
 * what proved it: once all six banners took their tone from the table, the tint
 * classes stopped appearing at any call site — `cn("rounded-lg border p-3
 * text-sm", STATUS_BANNER_TONE.ok)` contains no tinted background at all — so the
 * scan over the rest of `src/` found **nothing**, and a green run meant "there is
 * nothing to look at" rather than "everything is fine". Exactly the failure mode
 * this MR is about.
 *
 * Including the table gives the scan a real, non-synthetic subject on the real
 * tree: the three tone strings. They pass, because they are the table. That is
 * not circular — the assertion worth making is *"no scope in `src/` spells a
 * tinted banner the table does not define"*, and after centralisation the table is
 * legitimately the only place one is spelled.
 */
function sourceFiles(): string[] {
  return readdirSync("src", { recursive: true, encoding: "utf8" })
    .filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
    .map((entry) => path.join("src", entry));
}

describe("STATUS_BANNER_TONE", () => {
  it("pairs every tone's light text colour with a dark: partner", () => {
    for (const [name, tone] of Object.entries(STATUS_BANNER_TONE)) {
      const tokens = tone.split(/\s+/);
      expect(
        tokens.filter((t) => PALETTE_TEXT.test(t)),
        `${name} must set exactly one unprefixed text colour`,
      ).toHaveLength(1);
      expect(
        tokens.some((t) => t.startsWith("dark:text-")),
        `${name} must carry a dark: text partner — a -700/-800 reads 2.3-4.0:1 on the dark --background`,
      ).toBe(true);
    }
  });

  it("uses a shade of at least 800 for the ok and warn tones", () => {
    // The tint is what forces this. green-700 measures 4.16:1 and amber-700
    // 4.42:1 on their own tints; -800 restores the margin (5.98:1 / 6.24:1).
    expect(STATUS_BANNER_TONE.ok).toContain("text-green-800");
    expect(STATUS_BANNER_TONE.warn).toContain("text-amber-800");
    // red-700 already clears 4.5:1 on its tint (5.07:1) and is the error red the
    // rest of the app uses, so it is deliberately NOT escalated.
    expect(STATUS_BANNER_TONE.error).toContain("text-red-700");
  });

  it("carries no geometry — the caller owns rounding, padding and text size", () => {
    for (const tone of Object.values(STATUS_BANNER_TONE)) {
      expect(tone).not.toMatch(/\b(rounded|p-|px-|py-|text-(xs|sm|base|lg))/);
    }
  });

  it("is itself the shape the scanner reports, so the two cannot drift apart", () => {
    // If a tone stopped being a translucent tint, or gained a `dark:bg-*`, the
    // scanner would stop reporting banners built from it and this file's main
    // assertion would pass by measuring nothing.
    for (const [name, tone] of Object.entries(STATUS_BANNER_TONE)) {
      const reported = findTintedBannerText(
        `const x = <div className="${tone}" />;`,
      );
      expect(
        reported.map((r) => r.token),
        name,
      ).toHaveLength(1);
      expect(TONE_TOKENS.has(reported[0].token), name).toBe(true);
    }
  });
});

describe("src/ tinted-banner hygiene (#109)", () => {
  it("finds banner-shaped scopes on the real tree (the scan is not a no-op)", () => {
    // One per tone, from the table. If this drops to zero the assertion below
    // stops meaning anything, which is how a clean run turns into a hollow one.
    const tinted = sourceFiles().flatMap((file) =>
      findTintedBannerText(readFileSync(file, "utf8"), file),
    );
    expect(tinted.length).toBeGreaterThanOrEqual(
      Object.keys(STATUS_BANNER_TONE).length,
    );
  });

  it("takes every translucent-tinted banner's colours from the tone table", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const { line, token } of findTintedBannerText(
        readFileSync(file, "utf8"),
        file,
      )) {
        if (TONE_TOKENS.has(token)) continue;
        offenders.push(
          `${file}:${line} — \`${token}\` sits on a translucent tint but is not from STATUS_BANNER_TONE, so its composite ratio is unmeasured`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
