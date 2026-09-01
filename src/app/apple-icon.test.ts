import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readPngFacts, synthesisePng, type PngFacts } from "@/lib/png-inspect";

/**
 * The iOS home-screen icon must be OPAQUE — #254, folded in via #85.
 *
 * ## The defect this would have caught
 *
 * `src/app/apple-icon.png` shipped at 180x180 with **25,054 of its 32,400 pixels
 * fully transparent (77.3%)**. iOS composites a transparent home-screen icon
 * against **black**, so adding dlectroflow to an iPhone home screen produced a
 * black square with a small mark in it. It had been like that since #13/#40, and
 * nothing could see it: Next emits the `<link rel="apple-touch-icon">` from the
 * file's mere existence, so every check in the repo was satisfied by a file that
 * rendered wrong.
 *
 * ## Why it asserts the ALPHA CHANNEL rather than a transparency percentage
 *
 * A threshold ("under 2% transparent") would pass a file that is 1.9%
 * transparent for no reason, and the number would need re-arguing at every
 * regeneration. A PNG with no alpha channel and no `tRNS` chunk **cannot** be
 * transparent — the guarantee is structural, the assertion is one line, and the
 * measured percentage is 0 by construction rather than by measurement. The
 * percentage is still computed when an alpha channel IS present, purely so the
 * failure message says "77.3% transparent" instead of "colour type 6".
 *
 * ## Why this parses the PNG by hand instead of using `sharp`
 *
 * ⚠️ **`sharp` is not a declared dependency of this project.** It appears only
 * under `overrides` in `package.json` (a version pin for a transitive) and
 * resolves because `next` lists it under `optionalDependencies` — so a
 * `--no-optional` install, a platform with no prebuilt binary, or a `next`
 * upgrade that drops the entry would each remove it **without failing the
 * install**, and this test would start erroring on an import rather than on the
 * icon. #254's spec reaches the same conclusion for build-time icon generation
 * and declines it on exactly this basis. Regenerating the asset with `sharp` is
 * a one-off local run, which that spec does sanction; asserting on it in CI is
 * not.
 *
 * The parser itself moved to `src/lib/png-inspect.ts` under #277, which needed
 * the same un-filterer to measure the maskable icons' safe zone — a per-pixel
 * LUMINANCE question rather than a transparency count. Its own suite
 * (`src/lib/png-inspect.test.ts`) exercises all five PNG filter types, split
 * IDAT chunks and every rejection path on synthetic input. The control kept
 * below is the narrower one that matters here: that THIS assertion, on this
 * file, would reject the icon that used to ship.
 */

const ICON = path.join(__dirname, "apple-icon.png");

/** The failure message the assertion below builds, extracted so the control can
 *  drive the identical code path on a synthetic icon. */
function transparencySummary(facts: PngFacts): string {
  const pixels = facts.width * facts.height;
  return facts.fullyTransparentPixels === null
    ? "0 (no alpha channel)"
    : `${facts.fullyTransparentPixels} of ${pixels} (${(
        (facts.fullyTransparentPixels / pixels) *
        100
      ).toFixed(1)}%)`;
}

describe("the opacity assertion can actually fail (#254)", () => {
  it("rejects a 77.3%-transparent 180x180 icon — the file that used to ship", () => {
    // 25,054 of 32,400 is 77.3%; reproduced here as a band of fully transparent
    // rows so the shape of the old defect is in the fixture, not just its size.
    const transparentRows = Math.round((25054 / 32400) * 180);
    const facts = readPngFacts(
      synthesisePng({
        width: 180,
        height: 180,
        alphaAt: (_x, y) => (y < transparentRows ? 0 : 255),
      }),
    );
    expect(facts.hasAlphaChannel).toBe(true);
    expect(facts.fullyTransparentPixels).toBe(transparentRows * 180);
    expect(transparencySummary(facts)).toMatch(/%\)$/);
  });

  it("accepts an alpha-less icon, so the assertion is not simply always red", () => {
    const facts = readPngFacts(
      synthesisePng({ width: 180, height: 180, rgb: true }),
    );
    expect(facts.hasAlphaChannel).toBe(false);
    expect(transparencySummary(facts)).toBe("0 (no alpha channel)");
  });
});

describe("src/app/apple-icon.png is opaque (#254)", () => {
  const facts = readPngFacts(readFileSync(ICON));

  // 180x180 is the Apple touch icon size iOS asks for, and the size the file has
  // always been. Pinned so a regeneration cannot silently change it.
  it("is 180x180", () => {
    expect([facts.width, facts.height]).toEqual([180, 180]);
  });

  /**
   * ⚠️ THE assertion. iOS renders a transparent home-screen icon on black, so
   * any transparency at all is the black-square defect, and the only way to be
   * sure there is none is for the file to have nowhere to put it.
   */
  it("carries no alpha channel, so it CANNOT render on a black backdrop", () => {
    expect(
      facts.hasAlphaChannel,
      `apple-icon.png has PNG colour type ${facts.colourType}, which carries an ` +
        `alpha channel. Fully transparent pixels: ${transparencySummary(facts)}. ` +
        `iOS composites a transparent home-screen icon on BLACK, so this ships a ` +
        `black square. Regenerate it flattened onto the splash colour #0a0510 — ` +
        `see the recipe in this file's sibling docs/design/specs entry for #254.`,
    ).toBe(false);
  });

  it("carries no tRNS chunk either", () => {
    // Belt and braces: colour types 0, 2 and 3 have no alpha channel but can
    // still declare transparent samples through tRNS.
    expect(facts.hasTrnsChunk).toBe(false);
  });
});
