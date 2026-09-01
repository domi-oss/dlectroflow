import { inflateSync, deflateSync } from "node:zlib";

/**
 * A dependency-free PNG reader, for asserting things about the repo's own image
 * assets (#277).
 *
 * ── Why not `sharp` ─────────────────────────────────────────────────────────
 *
 * ⚠️ **`sharp` is not a declared dependency of this project.** It appears only
 * under `overrides` in `package.json` (a version pin for a transitive) and
 * resolves because `next` lists it under `optionalDependencies` — so a
 * `--no-optional` install, a platform with no prebuilt binary, or a `next`
 * upgrade that drops the entry each remove it **without failing the install**,
 * and any test importing it would then error on the import rather than on the
 * asset it is asserting about. #254's design spec reaches the same conclusion
 * about build-time icon generation and declines it on exactly this basis:
 * generating an icon with `sharp` is a sanctioned ONE-OFF LOCAL run, depending on
 * it in CI is not.
 *
 * ── Scope, deliberately narrow ──────────────────────────────────────────────
 *
 * 8-bit, non-interlaced, and any of the four colour types that need no palette:
 * grey (0), RGB (2), grey+alpha (4) and RGBA (6). Everything outside that THROWS
 * rather than returning a plausible-looking answer — a silently wrong pixel
 * buffer is worse than no reader, because the assertions built on it would go
 * green. Palette (colour type 3) needs PLTE expansion, 16-bit needs endian
 * handling and Adam7 needs seven passes; none is needed here and each is a way to
 * be subtly wrong.
 *
 * ⚠️ The two GREY types are supported because of a real bug, not for
 * completeness. The first version of this module accepted colour type 4 in
 * `readPngFacts`'s transparency-counting predicate while `readPngPixels`
 * rejected it, so `readPngFacts` on a grey+alpha PNG **threw** instead of
 * returning facts (Duo review, `!397`). Narrowing the predicate instead was
 * declined: `fullyTransparentPixels: null` MEANS "transparency is impossible
 * here" — that is the contract `src/app/apple-icon.test.ts` reads it under — and
 * a grey+alpha PNG can be fully transparent, so `null` for one would be a false
 * negative dressed up as graceful degradation.
 *
 * ── Kept free of `fs` ───────────────────────────────────────────────────────
 *
 * Same split as the `*-hygiene` modules: everything here works on a Buffer, so
 * it is exercisable on synthetic input (`synthesisePng`, used throughout
 * `png-inspect.test.ts`) rather than only against the repo's own files. A reader
 * that can only be tested on assets that already pass cannot be shown to fail.
 */

/** PNG spec 5.2. The first eight bytes of every PNG. */
export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Colour types that carry a per-pixel alpha channel (PNG spec, bit 2). */
const ALPHA_BIT = 4;

/**
 * PNG colour types this reader can turn into pixels, and how many 8-bit samples
 * each stores per pixel (PNG spec 11.2.2, table 11.1). Colour type 3 (palette)
 * is deliberately absent — it stores one index per pixel and needs its PLTE
 * chunk expanded, which nothing here needs and everything here would get wrong.
 *
 * The map is the single source of the sample count: the un-filterer steps its
 * predictors back by exactly this many bytes, so a hard-coded 3-or-4 was the
 * thing that made grey support a bug rather than an omission.
 */
const COLOUR_TYPE_GREY = 0;
const COLOUR_TYPE_RGB = 2;
const COLOUR_TYPE_GREY_ALPHA = 4;
const COLOUR_TYPE_RGBA = 6;

const SAMPLES_PER_PIXEL: Readonly<Record<number, number>> = {
  [COLOUR_TYPE_GREY]: 1,
  [COLOUR_TYPE_RGB]: 3,
  [COLOUR_TYPE_GREY_ALPHA]: 2,
  [COLOUR_TYPE_RGBA]: 4,
};

export type PngFacts = {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  hasAlphaChannel: boolean;
  /** Adam7. `readPngPixels` refuses these rather than mis-reading them. */
  interlaced: boolean;
  /** A `tRNS` chunk makes even an alpha-less colour type transparent. */
  hasTrnsChunk: boolean;
  /** Fully-transparent pixel count, or null where transparency is impossible. */
  fullyTransparentPixels: number | null;
};

export type PngPixels = {
  width: number;
  height: number;
  /** 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA. Read it; do not assume 3 or 4. */
  channels: number;
  /** Un-filtered 8-bit samples, `width * height * channels` long. */
  data: Buffer;
};

type Chunks = { hasTrnsChunk: boolean; idat: Buffer };

/**
 * Walk the chunk list once.
 *
 * IDAT is concatenated because real encoders split it — a reader that takes only
 * the first chunk works on small synthetic images and fails on every real asset,
 * which is the worst possible place for the boundary to be.
 */
function readChunks(buffer: Buffer): Chunks {
  let offset = 8;
  let hasTrnsChunk = false;
  const idat: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("latin1");
    if (type === "tRNS") hasTrnsChunk = true;
    if (type === "IDAT") {
      idat.push(Buffer.from(buffer.subarray(offset + 8, offset + 8 + length)));
    }
    if (type === "IEND") break;
    offset += 12 + length; // length + type + data + CRC
  }
  return { hasTrnsChunk, idat: Buffer.concat(idat) };
}

function readHeader(buffer: Buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG: signature mismatch");
  }
  // IHDR is required to be the first chunk: 8-byte signature, then a 4-byte
  // length and the 4-byte type "IHDR", then the 13-byte header itself.
  if (buffer.subarray(12, 16).toString("latin1") !== "IHDR") {
    throw new Error("not a PNG: first chunk is not IHDR");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colourType: buffer[25],
    // Byte 28 is the interlace method: 0 none, 1 Adam7 (PNG spec 11.2.2).
    interlaced: buffer[28] === 1,
  };
}

/** Header facts plus, where transparency is possible at all, how much there is. */
export function readPngFacts(buffer: Buffer): PngFacts {
  const header = readHeader(buffer);
  const { hasTrnsChunk } = readChunks(buffer);
  const hasAlphaChannel = (header.colourType & ALPHA_BIT) !== 0;
  const countable =
    hasAlphaChannel &&
    header.bitDepth === 8 &&
    !header.interlaced &&
    (header.colourType === COLOUR_TYPE_RGBA ||
      header.colourType === COLOUR_TYPE_GREY_ALPHA);

  return {
    ...header,
    hasAlphaChannel,
    hasTrnsChunk,
    fullyTransparentPixels: countable
      ? countFullyTransparent(readPngPixels(buffer))
      : null,
  };
}

function countFullyTransparent({ data, channels, width, height }: PngPixels) {
  let transparent = 0;
  for (let p = 0; p < width * height; p++) {
    if (data[p * channels + (channels - 1)] === 0) transparent++;
  }
  return transparent;
}

/**
 * Inflate and un-filter the image data.
 *
 * ⚠️ The un-filtering is the part that must be right. PNG stores each row's
 * bytes as a delta against its neighbours (spec 9.2), so reading raw inflated
 * bytes as pixels gives nonsense — and for filter type 0 rows, PLAUSIBLE-LOOKING
 * nonsense. `png-inspect.test.ts` exercises all five filter types against a
 * known gradient for exactly that reason.
 */
export function readPngPixels(buffer: Buffer): PngPixels {
  const { width, height, bitDepth, colourType, interlaced } =
    readHeader(buffer);
  if (interlaced) {
    throw new Error(
      "interlaced (Adam7) PNGs are not supported: the seven passes would have " +
        "to be de-interleaved, and this reader would otherwise return a " +
        "plausible-looking but wrong pixel buffer",
    );
  }
  if (bitDepth !== 8) {
    throw new Error(`unsupported bit depth ${bitDepth}: only 8 is supported`);
  }
  const channels = SAMPLES_PER_PIXEL[colourType];
  if (!channels) {
    throw new Error(
      `unsupported colour type ${colourType}: only 0 (grey), 2 (RGB), ` +
        `4 (grey+alpha) and 6 (RGBA) are supported — a palette image would need ` +
        `its PLTE chunk expanded`,
    );
  }
  const stride = width * channels;
  const raw = inflateSync(readChunks(buffer).idat);
  const expected = height * (stride + 1);
  if (raw.length < expected) {
    throw new Error(
      `truncated image data: ${raw.length} bytes inflated, ${expected} expected ` +
        `for ${width}x${height} at ${channels} channels`,
    );
  }

  const out = Buffer.alloc(stride * height);
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);

  for (let row = 0; row < height; row++) {
    const start = row * (stride + 1);
    const filter = raw[start];
    raw.copy(current, 0, start + 1, start + 1 + stride);

    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? current[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      switch (filter) {
        case 0: // None
          break;
        case 1: // Sub
          current[i] = (current[i] + left) & 0xff;
          break;
        case 2: // Up
          current[i] = (current[i] + up) & 0xff;
          break;
        case 3: // Average
          current[i] = (current[i] + ((left + up) >> 1)) & 0xff;
          break;
        case 4: {
          // Paeth
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

    current.copy(out, row * stride);
    current.copy(previous);
  }

  return { width, height, channels, data: out };
}

/**
 * Build a PNG in memory, so the reader above can be exercised on input whose
 * every pixel is known.
 *
 * Test-only, and it lives here beside the reader rather than in a test file
 * because two callers need it: `png-inspect.test.ts` and
 * `src/app/apple-icon.test.ts`.
 *
 * CRCs are zero placeholders — nothing in this module validates them, so a
 * hand-rolled CRC32 nobody reads would be ceremony rather than fidelity.
 */
export function synthesisePng({
  width,
  height,
  rgb = false,
  colourType,
  bitDepth = 8,
  interlace = false,
  trns = false,
  filter = 0,
  splitIdat = 1,
  alphaAt,
  pixelAt,
}: {
  width: number;
  height: number;
  /** Emit colour type 2 (RGB, no alpha channel) instead of 6 (RGBA). */
  rgb?: boolean;
  /** Force a colour type outright, for the reader's rejection paths. */
  colourType?: number;
  bitDepth?: number;
  interlace?: boolean;
  trns?: boolean;
  /** Which PNG filter to encode every row with. 9 is deliberately invalid. */
  filter?: number;
  /** Split the image data across this many IDAT chunks. */
  splitIdat?: number;
  alphaAt?: (x: number, y: number) => number;
  pixelAt?: (x: number, y: number) => [number, number, number, number];
}): Buffer {
  const declaredType = colourType ?? (rgb ? COLOUR_TYPE_RGB : COLOUR_TYPE_RGBA);
  // Unsupported types still need a plausible stride so the REJECTION paths can be
  // exercised on a fixture that is otherwise well formed; 3 is the sane default.
  const channels = SAMPLES_PER_PIXEL[declaredType] ?? 3;
  const stride = width * channels;

  // Unfiltered samples first, then encode each row with the requested filter, so
  // the fixture is the inverse of the reader rather than a second implementation
  // of it.
  const plain = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelAt?.(x, y) ?? [
        0x0a,
        0x05,
        0x10,
        alphaAt?.(x, y) ?? 255,
      ];
      const at = y * stride + x * channels;
      // Grey types store ONE luminance sample, and `r` is it — the fixture's
      // caller passes a 4-tuple whatever the colour type, so the mapping is
      // named here rather than left for a reader to infer from a stride.
      if (channels <= 2) {
        plain[at] = r;
        if (channels === 2) plain[at + 1] = a;
      } else {
        plain[at] = r;
        plain[at + 1] = g;
        plain[at + 2] = b;
        if (channels === 4) plain[at + 3] = a;
      }
    }
  }

  const encoded = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    encoded[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const value = plain[y * stride + i];
      const left = i >= channels ? plain[y * stride + i - channels] : 0;
      const up = y > 0 ? plain[(y - 1) * stride + i] : 0;
      const upLeft =
        y > 0 && i >= channels ? plain[(y - 1) * stride + i - channels] : 0;
      let predictor = 0;
      switch (filter) {
        case 1:
          predictor = left;
          break;
        case 2:
          predictor = up;
          break;
        case 3:
          predictor = (left + up) >> 1;
          break;
        case 4: {
          const p = left + up - upLeft;
          const dl = Math.abs(p - left);
          const du = Math.abs(p - up);
          const dul = Math.abs(p - upLeft);
          predictor = dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
          break;
        }
        default:
          predictor = 0; // filter 0, and the invalid case the reader must reject
      }
      encoded[y * (stride + 1) + 1 + i] = (value - predictor) & 0xff;
    }
  }

  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
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
  ihdr[8] = bitDepth;
  ihdr[9] = declaredType;
  ihdr[12] = interlace ? 1 : 0;

  const compressed = deflateSync(encoded);
  const parts = Math.max(1, splitIdat);
  const size = Math.ceil(compressed.length / parts);
  const idats: Buffer[] = [];
  for (let at = 0; at < compressed.length; at += size) {
    idats.push(chunk("IDAT", compressed.subarray(at, at + size)));
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    ...(trns ? [chunk("tRNS", Buffer.from([0, 0, 0, 0, 0, 0]))] : []),
    ...idats,
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
