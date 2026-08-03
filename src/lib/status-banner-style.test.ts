import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { STATUS_BANNER_TONE } from "@/lib/status-banner-style";
import { scanClassScopes } from "@/lib/a11y-class-hygiene";

/**
 * #109 — the composite half of the contrast problem, which
 * `a11y-class-hygiene.ts` explicitly cannot see.
 *
 * That guard checks the TOKEN: no bare `-600`, always a `dark:` partner. Six
 * banners in this repo satisfied the token rule and still failed AA, because a
 * translucent `bg-<family>-<n>/10` composites over `--background` and pulls the
 * background toward the text. `text-green-700` is 4.65:1 on the bare light
 * background and 4.16:1 once its own tint is in the way.
 *
 * There is no cheap way to measure a composite from source, so this asserts the
 * next best thing: **any banner with a translucent chromatic tint and no dark
 * background of its own takes its colours from the one measured table.** That is
 * a structural rule with the same effect — it makes the seventh banner
 * impossible rather than merely unlikely.
 *
 * The `dark:bg-*` carve-out is not a loophole, it is the boundary of the claim.
 * `guest-indicator.tsx` tints with `bg-amber-500/10` AND overrides
 * `dark:bg-amber-950/20`, so it composites over a background it chose rather than
 * over `--background`, and the table's numbers say nothing about it. (It measures
 * 6.24:1 in light on `text-amber-800` — the same shade the table uses, which is
 * how the table's amber was chosen.)
 */

/** Tailwind's chromatic families, as `a11y-class-hygiene.ts` defines them. */
const CHROMATIC = new Set([
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);

// Literal patterns with the family checked by Set membership, matching
// `a11y-class-hygiene.ts` — a membership test belongs in a Set, and building the
// pattern from an interpolated string trips semgrep's ReDoS rule for no benefit.

/** `bg-amber-500/10` — a palette background with an alpha modifier. */
const TINTED_BG = /^bg-([a-z]+)-\d{2,3}\/\d{1,3}$/;
/** An unprefixed palette text colour. */
const PALETTE_TEXT = /^text-([a-z]+)-\d{2,3}$/;

const isTintedBg = (t: string): boolean => {
  const m = TINTED_BG.exec(t);
  return m !== null && CHROMATIC.has(m[1]);
};
const isChromaticText = (t: string): boolean => {
  const m = PALETTE_TEXT.exec(t);
  return m !== null && CHROMATIC.has(m[1]);
};

const TONE_TOKENS = new Set(
  Object.values(STATUS_BANNER_TONE).flatMap((tone) => tone.split(/\s+/)),
);

function sourceFiles(): string[] {
  return readdirSync("src", { recursive: true, encoding: "utf8" })
    .filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
    .map((entry) => path.join("src", entry))
    .filter(
      (file) => file !== path.join("src", "lib", "status-banner-style.ts"),
    );
}

describe("STATUS_BANNER_TONE", () => {
  it("pairs every tone's light text colour with a dark: partner", () => {
    for (const [name, tone] of Object.entries(STATUS_BANNER_TONE)) {
      const tokens = tone.split(/\s+/);
      expect(
        tokens.filter((t) => isChromaticText(t)),
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
});

describe("src/ tinted-banner hygiene (#109)", () => {
  it("finds banner-shaped scopes at all (the scan is not a no-op)", () => {
    const tinted = sourceFiles().flatMap((file) =>
      scanClassScopes(readFileSync(file, "utf8"), file).filter((scope) =>
        scope.tokens.some((t) => isTintedBg(t)),
      ),
    );
    expect(tinted.length).toBeGreaterThan(0);
  });

  it("takes every translucent-tinted banner's colours from the tone table", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const scope of scanClassScopes(readFileSync(file, "utf8"), file)) {
        if (!scope.tokens.some((t) => isTintedBg(t))) continue;
        // Its own dark background means it does not composite over
        // --background, so the table's measurements do not apply to it.
        if (scope.tokens.some((t) => t.startsWith("dark:bg-"))) continue;
        for (const token of scope.tokens) {
          if (!isChromaticText(token)) continue;
          if (TONE_TOKENS.has(token)) continue;
          offenders.push(
            `${file}:${scope.line} — \`${token}\` on a translucent tint is not from STATUS_BANNER_TONE; the composite ratio is unmeasured`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
