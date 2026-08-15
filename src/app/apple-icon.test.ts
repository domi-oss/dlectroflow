import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import path from "node:path";

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
 * not. Everything below uses `node:zlib` and byte offsets from the PNG spec.
 */

const ICON = path.join(__dirname, "apple-icon.png");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Colour types that carry a per-pixel alpha channel (PNG spec, bit 2). */
const ALPHA_BIT = 4;

type PngFacts = {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  hasAlphaChannel: boolean;
  /** A `tRNS` chunk makes even an alpha-less colour type transparent. */
  hasTrnsChunk: boolean;
  /** Fully-transparent pixel count, or null where transparency is impossible. */
  fullyTransparentPixels: number | null;
};

/**
 * Pure: everything here works on a buffer, so the parser can be exercised on
 * synthetic input (see "the guard can actually fail" below) rather than only
 * against the repo's own file.
 */
function readPngFacts(buffer: Buffer): PngFacts {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG: signature mismatch");
  }
  // IHDR is required to be the first chunk: 8-byte signature, then a 4-byte
  // length and the 4-byte type "IHDR", then the 13-byte header itself.
  if (buffer.subarray(12, 16).toString("latin1") !== "IHDR") {
    throw new Error("not a PNG: first chunk is not IHDR");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colourType = buffer[25];
  const hasAlphaChannel = (colourType & ALPHA_BIT) !== 0;

  // Walk the chunk list for tRNS, and collect IDAT (which may be split).
  let offset = 8;
  let hasTrnsChunk = false;
  const idat: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("latin1");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "tRNS") hasTrnsChunk = true;
    if (type === "IDAT") idat.push(Buffer.from(data));
    if (type === "IEND") break;
    offset += 12 + length; // length + type + data + CRC
  }

  return {
    width,
    height,
    bitDepth,
    colourType,
    hasAlphaChannel,
    hasTrnsChunk,
    fullyTransparentPixels:
      hasAlphaChannel &&
      bitDepth === 8 &&
      (colourType === 6 || colourType === 4)
        ? countFullyTransparent(
            Buffer.concat(idat),
            width,
            height,
            colourType === 6 ? 4 : 2,
          )
        : null,
  };
}

/**
 * Count alpha==0 pixels in 8-bit RGBA/greyscale-alpha IDAT data.
 *
 * The scanlines have to be un-filtered first: PNG stores each row's bytes as a
 * delta against its neighbours, so reading raw inflated bytes as pixels gives
 * nonsense (and, for filter type 0 rows, plausible-looking nonsense — which is
 * the trap). Filters are PNG spec 9.2.
 */
function countFullyTransparent(
  idat: Buffer,
  width: number,
  height: number,
  bytesPerPixel: number,
): number {
  const raw = inflateSync(idat);
  const stride = width * bytesPerPixel;
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  let transparent = 0;

  for (let row = 0; row < height; row++) {
    const start = row * (stride + 1);
    const filter = raw[start];
    raw.copy(current, 0, start + 1, start + 1 + stride);

    for (let i = 0; i < stride; i++) {
      const left = i >= bytesPerPixel ? current[i - bytesPerPixel] : 0;
      const up = previous[i];
      const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          current[i] = (current[i] + left) & 0xff;
          break;
        case 2:
          current[i] = (current[i] + up) & 0xff;
          break;
        case 3:
          current[i] = (current[i] + ((left + up) >> 1)) & 0xff;
          break;
        case 4: {
          const p = left + up - upLeft;
          const dl = Math.abs(p - left);
          const du = Math.abs(p - up);
          const dul = Math.abs(p - upLeft);
          const predictor =
            dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
          current[i] = (current[i] + predictor) & 0xff;
          break;
        }
        default:
          throw new Error(`unknown PNG filter type ${filter} on row ${row}`);
      }
    }

    for (let x = 0; x < width; x++) {
      if (current[x * bytesPerPixel + (bytesPerPixel - 1)] === 0) transparent++;
    }
    current.copy(previous);
  }

  return transparent;
}

/** A minimal single-IDAT PNG, for exercising the parser on known input. */
function synthesiseRgbaPng(
  width: number,
  height: number,
  alphaAt: (x: number, y: number) => number,
): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const at = y * (stride + 1) + 1 + x * 4;
      raw[at] = 0x0a;
      raw[at + 1] = 0x05;
      raw[at + 2] = 0x10;
      raw[at + 3] = alphaAt(x, y);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    // CRC is never validated by readPngFacts, so a zero placeholder is honest
    // here rather than a hand-rolled CRC32 nobody would read.
    return Buffer.concat([
      length,
      Buffer.from(type, "latin1"),
      data,
      Buffer.alloc(4),
    ]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("the PNG guard can actually fail (#254)", () => {
  it("counts a fully transparent RGBA image as 100% transparent", () => {
    const facts = readPngFacts(synthesiseRgbaPng(8, 8, () => 0));
    expect(facts.hasAlphaChannel).toBe(true);
    expect(facts.fullyTransparentPixels).toBe(64);
  });

  it("counts a fully opaque RGBA image as 0% transparent", () => {
    const facts = readPngFacts(synthesiseRgbaPng(8, 8, () => 255));
    expect(facts.fullyTransparentPixels).toBe(0);
  });

  it("counts a half-transparent RGBA image correctly", () => {
    const facts = readPngFacts(
      synthesiseRgbaPng(8, 8, (x) => (x < 4 ? 0 : 255)),
    );
    expect(facts.fullyTransparentPixels).toBe(32);
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
    const pixels = facts.width * facts.height;
    const measured =
      facts.fullyTransparentPixels === null
        ? "0 (no alpha channel)"
        : `${facts.fullyTransparentPixels} of ${pixels} (${(
            (facts.fullyTransparentPixels / pixels) *
            100
          ).toFixed(1)}%)`;

    expect(
      facts.hasAlphaChannel,
      `apple-icon.png has PNG colour type ${facts.colourType}, which carries an ` +
        `alpha channel. Fully transparent pixels: ${measured}. iOS composites a ` +
        `transparent home-screen icon on BLACK, so this ships a black square. ` +
        `Regenerate it flattened onto the splash colour #0a0510 — see the ` +
        `recipe in this file's sibling docs/design/specs entry for #254.`,
    ).toBe(false);
  });

  it("carries no tRNS chunk either", () => {
    // Belt and braces: colour types 0, 2 and 3 have no alpha channel but can
    // still declare transparent samples through tRNS.
    expect(facts.hasTrnsChunk).toBe(false);
  });
});
