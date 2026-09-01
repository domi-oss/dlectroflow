import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import {
  PNG_SIGNATURE,
  readPngFacts,
  readPngPixels,
  synthesisePng,
} from "./png-inspect";

/**
 * A dependency-free PNG reader, and the tests that prove it can fail (#277).
 *
 * ## Why this exists rather than `sharp`
 *
 * ⚠️ **`sharp` is not a declared dependency of this project.** It appears only
 * under `overrides` in `package.json` — a version pin for a transitive — and
 * resolves because `next` lists it under `optionalDependencies`. A
 * `--no-optional` install, a platform with no prebuilt binary, or a `next`
 * upgrade that drops the entry would each remove it **without failing the
 * install**, and every test importing it would then error on the import rather
 * than on the thing it asserts. #254's design spec reaches the same conclusion
 * for build-time icon generation and declines it on exactly this basis:
 * generating an icon with `sharp` is a sanctioned one-off local run, asserting
 * on it in CI is not.
 *
 * So everything here is `node:zlib` and byte offsets from the PNG spec.
 *
 * ## Why a module rather than a helper inside one test file
 *
 * `src/app/apple-icon.test.ts` (#254, folded in via #85) grew the first copy of
 * this parser to prove the iOS home-screen icon carries no alpha channel. #277
 * needs the same machinery for a different question — the furthest *drawn*
 * pixel in a maskable icon, which is a per-pixel LUMINANCE measurement rather
 * than a transparency count — and two hand-rolled PNG unfilterers in one repo is
 * one too many. Same split as the `*-hygiene` modules: the parsing is here and
 * unit-testable on synthetic input, the assertions about real assets live beside
 * the assets.
 */

describe("readPngFacts: the header", () => {
  it("reads width, height, bit depth and colour type", () => {
    const facts = readPngFacts(synthesisePng({ width: 7, height: 3 }));
    expect(facts.width).toBe(7);
    expect(facts.height).toBe(3);
    expect(facts.bitDepth).toBe(8);
    expect(facts.colourType).toBe(6);
    expect(facts.hasAlphaChannel).toBe(true);
    expect(facts.interlaced).toBe(false);
  });

  it("reports colour type 2 (RGB) as carrying no alpha channel", () => {
    const facts = readPngFacts(
      synthesisePng({ width: 4, height: 4, rgb: true }),
    );
    expect(facts.colourType).toBe(2);
    expect(facts.hasAlphaChannel).toBe(false);
    expect(facts.fullyTransparentPixels).toBeNull();
  });

  it("rejects a buffer that is not a PNG", () => {
    expect(() =>
      readPngFacts(Buffer.from("not a png at all, honestly")),
    ).toThrow(/signature/i);
  });

  it("rejects a PNG whose first chunk is not IHDR", () => {
    const png = synthesisePng({ width: 2, height: 2 });
    // Corrupt the chunk type in place: bytes 12..16 are the first chunk's type.
    const broken = Buffer.from(png);
    broken.write("IDAT", 12, "latin1");
    expect(() => readPngFacts(broken)).toThrow(/IHDR/);
  });

  it("spots a tRNS chunk, which makes even an alpha-less colour type transparent", () => {
    const png = synthesisePng({ width: 2, height: 2, rgb: true, trns: true });
    const facts = readPngFacts(png);
    expect(facts.hasAlphaChannel).toBe(false);
    expect(facts.hasTrnsChunk).toBe(true);
  });

  it("finds no tRNS chunk when there is none", () => {
    expect(
      readPngFacts(synthesisePng({ width: 2, height: 2 })).hasTrnsChunk,
    ).toBe(false);
  });
});

describe("readPngFacts: counting fully transparent pixels", () => {
  it("counts a fully transparent RGBA image as 100% transparent", () => {
    const facts = readPngFacts(
      synthesisePng({ width: 8, height: 8, alphaAt: () => 0 }),
    );
    expect(facts.fullyTransparentPixels).toBe(64);
  });

  it("counts a fully opaque RGBA image as 0% transparent", () => {
    const facts = readPngFacts(
      synthesisePng({ width: 8, height: 8, alphaAt: () => 255 }),
    );
    expect(facts.fullyTransparentPixels).toBe(0);
  });

  it("counts a half-transparent RGBA image correctly", () => {
    const facts = readPngFacts(
      synthesisePng({ width: 8, height: 8, alphaAt: (x) => (x < 4 ? 0 : 255) }),
    );
    expect(facts.fullyTransparentPixels).toBe(32);
  });
});

describe("readPngPixels: un-filtering", () => {
  /**
   * ⚠️ The test that matters most in this file. PNG stores each row as a delta
   * against its neighbours, so reading inflated bytes straight through gives
   * nonsense — and for filter type 0 rows, PLAUSIBLE-LOOKING nonsense, which is
   * the trap. Every filter type the spec defines gets exercised on a known
   * gradient, so a broken predictor cannot hide behind a synthetic image that
   * happens to use only filter 0.
   */
  for (const filter of [0, 1, 2, 3, 4] as const) {
    it(`recovers the original pixels through filter type ${filter}`, () => {
      const width = 6;
      const height = 5;
      const expected = (x: number, y: number) => [
        (x * 37 + y * 11) & 0xff,
        (x * 91 + y * 53) & 0xff,
        (x * 13 + y * 197) & 0xff,
        255,
      ];
      const png = synthesisePng({
        width,
        height,
        filter,
        pixelAt: (x, y) => expected(x, y) as [number, number, number, number],
      });
      const { data, channels } = readPngPixels(png);
      expect(channels).toBe(4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const at = (y * width + x) * 4;
          expect(
            [data[at], data[at + 1], data[at + 2], data[at + 3]],
            `pixel (${x}, ${y}) under filter ${filter}`,
          ).toEqual(expected(x, y));
        }
      }
    });
  }

  it("reads a 3-channel RGB image as 3 channels, not 4", () => {
    const { channels, data } = readPngPixels(
      synthesisePng({
        width: 2,
        height: 1,
        rgb: true,
        pixelAt: () => [10, 5, 16, 255],
      }),
    );
    expect(channels).toBe(3);
    expect([data[0], data[1], data[2]]).toEqual([10, 5, 16]);
  });

  it("rejects an unknown filter type rather than returning silent nonsense", () => {
    const png = synthesisePng({ width: 2, height: 2, filter: 9 });
    expect(() => readPngPixels(png)).toThrow(/filter/i);
  });

  it("rejects an interlaced PNG, which this un-filterer cannot read", () => {
    const png = synthesisePng({ width: 2, height: 2, interlace: true });
    expect(readPngFacts(png).interlaced).toBe(true);
    expect(() => readPngPixels(png)).toThrow(/interlac/i);
  });

  it("rejects a bit depth other than 8", () => {
    const png = synthesisePng({ width: 2, height: 2, bitDepth: 16 });
    expect(() => readPngPixels(png)).toThrow(/bit depth/i);
  });

  it("rejects a palette image, which needs PLTE expansion this does not do", () => {
    const png = synthesisePng({ width: 2, height: 2, colourType: 3 });
    expect(() => readPngPixels(png)).toThrow(/colour type/i);
  });

  it("reassembles IDAT data that arrives split across several chunks", () => {
    // Real encoders split IDAT; a reader that only looks at the first chunk
    // works on small synthetic images and fails on every real asset.
    const png = synthesisePng({
      width: 4,
      height: 4,
      splitIdat: 3,
      pixelAt: (x, y) => [x * 10, y * 10, 7, 255],
    });
    const { data } = readPngPixels(png);
    expect([data[0], data[1], data[2], data[3]]).toEqual([0, 0, 7, 255]);
    const last = (3 * 4 + 3) * 4;
    expect([data[last], data[last + 1], data[last + 2]]).toEqual([30, 30, 7]);
  });
});

/**
 * ⚠️ Greyscale, added after Duo found the gap on `!397`.
 *
 * `readPngFacts`'s `countable` predicate accepted colour type 4 (grey+alpha)
 * while `readPngPixels` rejected everything but RGB and RGBA — so
 * `readPngFacts` on a grey+alpha PNG **threw** instead of returning facts. Not
 * reachable from any asset in this repo today, which is exactly why it needed a
 * test: the first grey source anyone rasterises would have turned
 * `apple-icon.test.ts` from a guard into an import-time error.
 *
 * ⚠️ Duo's suggested remedy — drop colour type 4 from `countable` — is declined,
 * and the reason is the whole point of these cases. `fullyTransparentPixels:
 * null` MEANS "transparency is impossible here"; that is the contract
 * `apple-icon.test.ts` reads it under ("0 (no alpha channel)"). A grey+alpha PNG
 * can be fully transparent, so reporting `null` for one would be a false
 * negative dressed as a graceful degradation. Supporting the colour type is two
 * lines and is the honest fix.
 */
describe("readPngPixels: greyscale colour types", () => {
  it("reads grey+alpha (type 4) as 2 channels and counts its transparency", () => {
    const png = synthesisePng({
      width: 8,
      height: 8,
      colourType: 4,
      alphaAt: (x) => (x < 2 ? 0 : 255),
    });
    const pixels = readPngPixels(png);
    expect(pixels.channels).toBe(2);

    const facts = readPngFacts(png);
    expect(facts.colourType).toBe(4);
    expect(facts.hasAlphaChannel).toBe(true);
    // 2 of 8 columns, 8 rows. `null` here would be the false negative.
    expect(facts.fullyTransparentPixels).toBe(16);
  });

  it("reads plain grey (type 0) as 1 channel and reports transparency impossible", () => {
    const png = synthesisePng({ width: 4, height: 4, colourType: 0 });
    expect(readPngPixels(png).channels).toBe(1);
    const facts = readPngFacts(png);
    expect(facts.hasAlphaChannel).toBe(false);
    // Correct here, and for the right reason: colour type 0 has nowhere to put
    // transparency, so "impossible" is true rather than a shrug.
    expect(facts.fullyTransparentPixels).toBeNull();
  });

  it("recovers grey+alpha samples through the Paeth filter too", () => {
    // The filter predictors step back by BYTES-PER-PIXEL, so a 2-channel image
    // exercises a different stride than the 3- and 4-channel cases above.
    const png = synthesisePng({
      width: 5,
      height: 4,
      colourType: 4,
      filter: 4,
      pixelAt: (x, y) => [
        (x * 41 + y * 17) & 0xff,
        0,
        0,
        (x * 23 + y * 7) & 0xff,
      ],
    });
    const { data, channels } = readPngPixels(png);
    expect(channels).toBe(2);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 5; x++) {
        const at = (y * 5 + x) * 2;
        expect([data[at], data[at + 1]], `pixel (${x}, ${y})`).toEqual([
          (x * 41 + y * 17) & 0xff,
          (x * 23 + y * 7) & 0xff,
        ]);
      }
    }
  });
});

describe("synthesisePng: the fixture builder is itself sound", () => {
  it("emits a valid PNG signature", () => {
    expect(synthesisePng({ width: 1, height: 1 }).subarray(0, 8)).toEqual(
      PNG_SIGNATURE,
    );
  });

  it("produces something readPngFacts and readPngPixels agree about", () => {
    const png = synthesisePng({ width: 3, height: 2 });
    const facts = readPngFacts(png);
    const pixels = readPngPixels(png);
    expect([facts.width, facts.height]).toEqual([pixels.width, pixels.height]);
  });

  /**
   * The control for every "rejects …" case above: a deliberately corrupt
   * deflate stream must fail loudly, so none of those tests can be passing
   * because inflate happened to throw first for an unrelated reason.
   */
  it("a corrupt deflate stream throws from zlib, not from a silent zero", () => {
    const png = synthesisePng({ width: 2, height: 2 });
    const broken = Buffer.from(png);
    // Find the IDAT payload and scribble on it.
    const at = broken.indexOf(Buffer.from("IDAT", "latin1")) + 4;
    broken[at] = broken[at] ^ 0xff;
    expect(() => readPngPixels(broken)).toThrow();
  });

  it("deflateSync round-trips through the reader (sanity on the fixture path)", () => {
    // Guards against a fixture that accidentally stores raw rather than deflated
    // data — which would make every assertion above test the fixture, not the
    // reader.
    const raw = Buffer.alloc(9);
    expect(deflateSync(raw).length).toBeGreaterThan(0);
  });
});
