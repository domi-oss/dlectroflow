import { deflateRawSync, crc32 } from "node:zlib";

/**
 * A minimal ZIP writer (#129 — a member can export their own data).
 *
 * ## Why this is here rather than in `package.json`
 *
 * The export is one download containing seven files, and nothing in the tree
 * could make one. The options, and why this won:
 *
 *  1. **A zip dependency.** Rejected on the lockfile: local `npm` is
 *     allow-scripts-wrapped and resolves optional-dependency subtrees
 *     differently from CI's `node:22-alpine`, so `package-lock.json` can only be
 *     regenerated inside the CI image. That is a real cost to weigh against
 *     ~120 lines of a format that has not changed since 1993.
 *  2. **`tar.gz` via `node:zlib`.** Genuinely built in and genuinely smaller to
 *     write — and nothing on Windows opens one by double-click. The point of the
 *     archive is that the person who asked for their data can open it.
 *  3. **Seven separate downloads.** Drops the one-click property the feature
 *     exists for, and the README stops travelling with the files it explains.
 *
 * So: ZIP, written here, using only `node:zlib` — `deflateRawSync` for DEFLATE
 * (method 8 is a raw deflate stream, no zlib wrapper) and `crc32`, which Node
 * has exposed since 20.15 / 22.2. `package.json` requires `>=20.19.0`, so it is
 * available on every supported runtime.
 *
 * `zip.test.ts` verifies the output with a reader written independently from the
 * specification rather than from this file, which is the only way a
 * header-layout bug shows up as a failure instead of as a matching pair of
 * mistakes.
 *
 * ## What it deliberately does not do
 *
 * No ZIP64, no encryption, no data descriptors, no streaming: a personal task
 * list is kilobytes, so the whole archive is built in memory and every size
 * fits in the classic 32-bit fields. The limits are *checked* rather than
 * assumed — see `assertRepresentable` — because the alternative to a thrown
 * error is a silently truncated archive that still opens.
 *
 * Field layouts are APPNOTE.TXT §4.3.7 (local header), §4.3.12 (central
 * directory) and §4.3.16 (end of central directory).
 */

/** One file in the archive. `name` is the path inside it, `/`-separated. */
export type ZipEntry = {
  name: string;
  data: string | Uint8Array;
};

/** Version 2.0 — the minimum that understands DEFLATE (APPNOTE §4.4.3.2). */
const VERSION_20 = 20;

/**
 * General purpose bit 11: the name and comment are UTF-8 (APPNOTE §4.4.4).
 * Without it, an extractor is entitled to read the name as CP437 and a
 * non-ASCII filename arrives mojibaked.
 */
const FLAG_UTF8 = 0x0800;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** The classic 32-bit size/offset ceiling, and the 16-bit entry count. Past
 *  either, an archive needs ZIP64, which this writer does not emit. */
const MAX_UINT32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/**
 * Names that must not reach the archive.
 *
 * Zip-slip closed on the WRITING side: an absolute path, a `..` segment or a
 * backslash (which Windows extractors treat as a separator) can make an
 * extractor write outside its target directory. Producing them is never
 * intended here, so the check costs nothing and means the archive this app hands
 * out cannot carry one regardless of what unpacks it.
 */
function assertSafeName(name: string): void {
  const unsafe =
    name.length === 0 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.split("/").some((segment) => segment === ".." || segment === ".");
  if (unsafe) throw new Error(`unsafe entry name: ${JSON.stringify(name)}`);
}

function assertRepresentable(label: string, value: number): void {
  if (value > MAX_UINT32) {
    throw new Error(
      `${label} is ${value} bytes, past the 4 GiB limit of a non-ZIP64 archive`,
    );
  }
}

/**
 * MS-DOS date and time (APPNOTE §4.4.6), which carry NO timezone — they are
 * local wall-clock by definition, so local accessors are correct here and a UTC
 * reading would shift every timestamp in the archive listing.
 *
 * Seconds have one-second resolution lost to the format (`>> 1`), and the year
 * is 7 bits from 1980. A pre-1980 date is clamped rather than allowed to wrap:
 * the wrapped value is a plausible-looking date in the future.
 */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

type Prepared = {
  nameBytes: Buffer;
  method: number;
  crc: number;
  body: Buffer;
  uncompressedSize: number;
  localOffset: number;
};

/**
 * Build a ZIP archive in memory.
 *
 * `modifiedAt` stamps every entry — one timestamp for the whole archive, since
 * these files are all generated in the same instant and per-entry mtimes would
 * only invite the reader to look for meaning in the microseconds between them.
 */
export function buildZip(
  entries: readonly ZipEntry[],
  opts?: { modifiedAt?: Date },
  // `Uint8Array<ArrayBuffer>`, not the default `Uint8Array<ArrayBufferLike>`.
  // The distinction is load-bearing rather than pedantic: `BodyInit` accepts only
  // a view over a real `ArrayBuffer`, so the plain alias does not compile when the
  // result is handed to `new Response(...)` — which is the only thing the export
  // route does with it. Pinning it here is better than a cast at the call site.
): Uint8Array<ArrayBuffer> {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(
      `${entries.length} entries is past the ${MAX_ENTRIES}-entry limit of a non-ZIP64 archive`,
    );
  }
  const { time, date } = dosDateTime(opts?.modifiedAt ?? new Date());

  const seen = new Set<string>();
  const prepared: Prepared[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    assertSafeName(entry.name);
    if (seen.has(entry.name)) {
      // A valid archive can hold two entries with one name; it extracts to one
      // file and silently loses the other. For an export whose whole purpose is
      // completeness, that is the worst possible failure mode.
      throw new Error(`duplicate entry name: ${JSON.stringify(entry.name)}`);
    }
    seen.add(entry.name);

    const raw =
      typeof entry.data === "string"
        ? Buffer.from(entry.data, "utf8")
        : Buffer.from(entry.data);
    const deflated = raw.length > 0 ? deflateRawSync(raw) : Buffer.alloc(0);
    // Store when DEFLATE does not pay. Deflating incompressible or tiny content
    // makes the archive bigger, and `level` cannot fix that — the wrapper is
    // never free.
    const useDeflate = raw.length > 0 && deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const nameBytes = Buffer.from(entry.name, "utf8");

    assertRepresentable(`entry ${entry.name}`, raw.length);
    assertRepresentable(`entry ${entry.name} (compressed)`, body.length);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION_20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(useDeflate ? METHOD_DEFLATE : METHOD_STORE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    // `crc32` returns an unsigned 32-bit value; writeUInt32LE is the matching
    // write. (A signed `>>> 0` dance is what hand-rolled CRC tables need.)
    const crc = crc32(raw);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // no extra field

    prepared.push({
      nameBytes,
      method: useDeflate ? METHOD_DEFLATE : METHOD_STORE,
      crc,
      body,
      uncompressedSize: raw.length,
      localOffset: offset,
    });
    chunks.push(local, nameBytes, body);
    offset += local.length + nameBytes.length + body.length;
  }

  const centralStart = offset;
  for (const p of prepared) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    // Version made by: 2.0, MS-DOS (upper byte 0). Claiming a Unix host would
    // mean the external attributes carry a POSIX mode, and an all-zero mode
    // makes some extractors write a 000-permission file.
    central.writeUInt16LE(VERSION_20, 4);
    central.writeUInt16LE(VERSION_20, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(p.method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(p.crc, 16);
    central.writeUInt32LE(p.body.length, 20);
    central.writeUInt32LE(p.uncompressedSize, 24);
    central.writeUInt16LE(p.nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // file comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal file attributes
    central.writeUInt32LE(0, 38); // external file attributes
    central.writeUInt32LE(p.localOffset, 42);
    chunks.push(central, p.nameBytes);
    offset += central.length + p.nameBytes.length;
  }

  const centralSize = offset - centralStart;
  assertRepresentable("central directory", centralSize);
  assertRepresentable("archive", offset);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with the central directory
  eocd.writeUInt16LE(prepared.length, 8);
  eocd.writeUInt16LE(prepared.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // no archive comment
  chunks.push(eocd);

  // Copied into a freshly allocated ArrayBuffer rather than wrapping the Buffer's
  // own: `Buffer.concat` returns a view onto pooled memory typed as
  // `ArrayBufferLike`, which is exactly what the return type above rules out.
  const merged = Buffer.concat(chunks);
  const out = new Uint8Array(merged.byteLength);
  out.set(merged);
  return out;
}
