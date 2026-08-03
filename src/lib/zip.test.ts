import { describe, it, expect } from "vitest";
import { inflateRawSync, crc32 } from "node:zlib";
import { buildZip, type ZipEntry } from "./zip";

/**
 * An INDEPENDENT reader, deliberately written from the specification rather than
 * from `zip.ts`, and deliberately not `unzip` (the CI images cannot be assumed
 * to carry it, and a test that silently skips is worse than no test).
 *
 * It reads the archive the way a real extractor does — end-of-central-directory
 * first, then the central directory, then each local header — so a
 * self-consistent-but-wrong writer (offsets computed twice from the same
 * mistake) still fails. A round-trip through `zip.ts`'s own constants would not
 * catch that.
 *
 * APPNOTE.TXT §4.3.6-4.3.16 are the field layouts.
 */
type ReadEntry = {
  name: string;
  method: number;
  flags: number;
  crc: number;
  content: Uint8Array;
};

function readZip(buf: Uint8Array): ReadEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o: number) => view.getUint16(o, true);
  const u32 = (o: number) => view.getUint32(o, true);

  // End of central directory: scan backwards for its signature, because it is
  // followed by a variable-length comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd, "no end-of-central-directory record").toBeGreaterThanOrEqual(0);

  const total = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  let cursor = u32(eocd + 16);
  expect(cursor + cdSize).toBe(eocd);

  const out: ReadEntry[] = [];
  for (let n = 0; n < total; n++) {
    expect(u32(cursor), "central directory header signature").toBe(0x02014b50);
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const crc = u32(cursor + 16);
    const compressedSize = u32(cursor + 20);
    const uncompressedSize = u32(cursor + 24);
    const nameLen = u16(cursor + 28);
    const extraLen = u16(cursor + 30);
    const commentLen = u16(cursor + 32);
    const localOffset = u32(cursor + 42);
    const name = Buffer.from(
      buf.subarray(cursor + 46, cursor + 46 + nameLen),
    ).toString("utf8");
    cursor += 46 + nameLen + extraLen + commentLen;

    // Now the local header the central directory pointed at. Every duplicated
    // field must agree — that is the invariant an extractor relies on.
    expect(u32(localOffset), `local header signature for ${name}`).toBe(
      0x04034b50,
    );
    // The local header is NOT the central header minus two bytes: it has no
    // "version made by", so flags sit at +6 and the method at +8, two bytes
    // earlier than their central-directory counterparts (§4.3.7 vs §4.3.12).
    expect(u16(localOffset + 6), "local flags").toBe(flags);
    expect(u16(localOffset + 8), "local method").toBe(method);
    expect(u32(localOffset + 14), "local crc").toBe(crc);
    expect(u32(localOffset + 18), "local compressed size").toBe(compressedSize);
    expect(u32(localOffset + 22), "local uncompressed size").toBe(
      uncompressedSize,
    );
    const localNameLen = u16(localOffset + 26);
    const localExtraLen = u16(localOffset + 28);
    expect(
      Buffer.from(
        buf.subarray(localOffset + 30, localOffset + 30 + localNameLen),
      ).toString("utf8"),
      "local name",
    ).toBe(name);

    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? inflateRawSync(raw) : raw;
    expect(content.length, `uncompressed size for ${name}`).toBe(
      uncompressedSize,
    );
    expect(crc32(content), `crc for ${name}`).toBe(crc);
    out.push({ name, method, flags, crc, content });
  }
  return out;
}

const text = (e: ReadEntry) => Buffer.from(e.content).toString("utf8");

describe("buildZip", () => {
  const entries: ZipEntry[] = [
    { name: "README.md", data: "# hello\n" },
    { name: "tasks.csv", data: "id,title\r\n1,one\r\n" },
  ];

  it("starts with the local file header signature, so a file(1) sees a zip", () => {
    const zip = buildZip(entries);
    expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("round-trips every entry's name and bytes through an independent reader", () => {
    const read = readZip(buildZip(entries));
    expect(read.map((e) => e.name)).toEqual(["README.md", "tasks.csv"]);
    expect(read.map(text)).toEqual(["# hello\n", "id,title\r\n1,one\r\n"]);
  });

  it("preserves CRLF and embedded newlines byte for byte", () => {
    // The CSV tier depends on this: a writer that normalised line endings would
    // quietly break RFC 4180 compliance inside a valid-looking archive.
    const body = 'id,text\r\n1,"one\ntwo"\r\n';
    const [entry] = readZip(buildZip([{ name: "inbox.csv", data: body }]));
    expect(text(entry)).toBe(body);
  });

  it("round-trips UTF-8 content, including astral-plane characters", () => {
    const body = "🚀 émoji — and an ideograph: 漢\n";
    const [entry] = readZip(buildZip([{ name: "tasks.md", data: body }]));
    expect(text(entry)).toBe(body);
  });

  it("flags names as UTF-8 (bit 11), which is what makes a non-ASCII name legible", () => {
    const [entry] = readZip(buildZip([{ name: "réunion.md", data: "x" }]));
    expect(entry.flags & 0x0800).toBe(0x0800);
    expect(entry.name).toBe("réunion.md");
  });

  it("deflates when that is smaller, and stores when it is not", () => {
    const read = readZip(
      buildZip([
        { name: "big.txt", data: "a".repeat(5000) },
        { name: "tiny.txt", data: "a" },
      ]),
    );
    expect(read[0].method).toBe(8); // deflate
    expect(text(read[0])).toBe("a".repeat(5000));
    // One byte cannot be deflated smaller than itself, so it is stored — a
    // writer that always deflates makes small archives bigger.
    expect(read[1].method).toBe(0);
    expect(text(read[1])).toBe("a");
  });

  it("actually compresses compressible content", () => {
    const zip = buildZip([{ name: "big.txt", data: "a".repeat(50_000) }]);
    expect(zip.length).toBeLessThan(5_000);
  });

  it("accepts binary data as a Uint8Array", () => {
    const data = new Uint8Array([0, 1, 2, 250, 251, 0]);
    const [entry] = readZip(buildZip([{ name: "bin", data }]));
    expect([...entry.content]).toEqual([...data]);
  });

  it("writes an archive with no entries that still parses", () => {
    // The empty state is a real state (see the export's own empty-account
    // case), and an EOCD-only archive is what every extractor expects for it.
    const zip = buildZip([]);
    expect(readZip(zip)).toEqual([]);
    expect(zip.length).toBe(22);
  });

  it("stamps the DOS modification time from the date it is given", () => {
    // 2026-08-03 14:35:20 local → DOS date ((2026-1980)<<9)|(8<<5)|3, DOS time
    // (14<<11)|(35<<5)|(20>>1). Constructed with local-time accessors because a
    // DOS timestamp has no timezone (APPNOTE §4.4.6), so it is written local.
    const zip = buildZip([{ name: "a", data: "x" }], {
      modifiedAt: new Date(2026, 7, 3, 14, 35, 20),
    });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint16(10, true)).toBe((14 << 11) | (35 << 5) | 10);
    expect(view.getUint16(12, true)).toBe(((2026 - 1980) << 9) | (8 << 5) | 3);
  });

  it("clamps a pre-1980 date rather than writing a negative year field", () => {
    // DOS dates start at 1980 and the year field is 7 bits; a 1970 date would
    // wrap and produce a timestamp in the future.
    const zip = buildZip([{ name: "a", data: "x" }], {
      modifiedAt: new Date(1970, 0, 1, 0, 0, 0),
    });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint16(12, true)).toBe((0 << 9) | (1 << 5) | 1);
  });

  it("rejects a name that could escape the extraction directory", () => {
    // Zip-slip, closed on the WRITING side: an archive this app hands out can
    // never carry a traversal path, whatever the extractor does with it.
    for (const name of [
      "../escape.md",
      "a/../../escape.md",
      "/absolute.md",
      "back\\slash.md",
    ]) {
      expect(() => buildZip([{ name, data: "x" }]), name).toThrow(
        /unsafe entry name/i,
      );
    }
  });

  it("rejects an empty name and a duplicate name", () => {
    expect(() => buildZip([{ name: "", data: "x" }])).toThrow(
      /unsafe entry name/i,
    );
    // Two entries with one name is a valid archive that extracts to one file,
    // silently losing the other — exactly the failure the export must not have.
    expect(() =>
      buildZip([
        { name: "a.md", data: "1" },
        { name: "a.md", data: "2" },
      ]),
    ).toThrow(/duplicate entry name/i);
  });

  it("allows a nested path", () => {
    const [entry] = readZip(buildZip([{ name: "notes/tasks.md", data: "x" }]));
    expect(entry.name).toBe("notes/tasks.md");
  });
});
