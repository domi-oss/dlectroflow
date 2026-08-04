import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import {
  buildExportArchive,
  exportFileEntries,
  exportFilename,
} from "./bundle";
import { EXPORT_FILES } from "./manifest";
import { makeSnapshot, makeEmptySnapshot } from "./__tests__/fixture";

/** Minimal central-directory reader, so the assertions are about what an
 *  extractor sees rather than about what `buildZip` was handed. */
function readNames(zip: Uint8Array): string[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  const total = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const names: string[] = [];
  for (let n = 0; n < total; n++) {
    const nameLen = view.getUint16(cursor + 28, true);
    names.push(
      Buffer.from(zip.subarray(cursor + 46, cursor + 46 + nameLen)).toString(
        "utf8",
      ),
    );
    cursor +=
      46 +
      nameLen +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
  }
  return names;
}

/** Read one entry's decompressed text out of the archive. */
function readEntry(zip: Uint8Array, name: string): string {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  const total = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  for (let n = 0; n < total; n++) {
    const nameLen = view.getUint16(cursor + 28, true);
    const entryName = Buffer.from(
      zip.subarray(cursor + 46, cursor + 46 + nameLen),
    ).toString("utf8");
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (entryName === name) {
      const start =
        localOffset +
        30 +
        view.getUint16(localOffset + 26, true) +
        view.getUint16(localOffset + 28, true);
      const raw = zip.subarray(start, start + compressedSize);
      return Buffer.from(method === 8 ? inflateRawSync(raw) : raw).toString(
        "utf8",
      );
    }
    cursor +=
      46 +
      nameLen +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
  }
  throw new Error(`${name} is not in the archive`);
}

describe("exportFilename", () => {
  it("is dlectroflow-export-<user>-<date>.zip", () => {
    expect(exportFilename(makeSnapshot())).toBe(
      "dlectroflow-export-sam-2026-08-03.zip",
    );
  });

  it("names a guest sandbox export 'guest'", () => {
    expect(exportFilename(makeSnapshot({ account: null }))).toBe(
      "dlectroflow-export-guest-2026-08-03.zip",
    );
  });

  it("slugifies a handle that is not filename-safe", () => {
    // A filename goes into a Content-Disposition header and onto a filesystem. A
    // handle with a slash, a quote, a newline or a non-Latin script must not be
    // able to shape either.
    for (const [handle, expected] of [
      ["Sam.Smith", "sam-smith"],
      ["../../etc/passwd", "etc-passwd"],
      ['sam"; rm -rf /', "sam-rm-rf"],
      ["sam\nsmith", "sam-smith"],
      ["дом", "account"],
      ["", "account"],
      ["-----", "account"],
    ] as const) {
      expect(
        exportFilename(
          makeSnapshot({
            account: { ...makeSnapshot().account!, handle },
          }),
        ),
        handle,
      ).toBe(`dlectroflow-export-${expected}-2026-08-03.zip`);
    }
  });

  it("truncates a very long handle", () => {
    const name = exportFilename(
      makeSnapshot({
        account: { ...makeSnapshot().account!, handle: "a".repeat(200) },
      }),
    );
    expect(name.length).toBeLessThan(80);
    expect(name.endsWith("-2026-08-03.zip")).toBe(true);
  });

  it("contains only characters that are safe in a header and on a filesystem", () => {
    expect(exportFilename(makeSnapshot())).toMatch(/^[a-z0-9.-]+$/);
  });
});

describe("exportFileEntries", () => {
  const entries = exportFileEntries(makeSnapshot());

  it("produces exactly the agreed file list, in the agreed order", () => {
    expect(entries.map((e) => e.name)).toEqual([...EXPORT_FILES]);
  });

  it("produces the same file list for an account with no data", () => {
    // The archive's contents must not depend on how much data you happen to have
    // — a missing file reads as a failed export.
    expect(exportFileEntries(makeEmptySnapshot()).map((e) => e.name)).toEqual([
      ...EXPORT_FILES,
    ]);
  });

  it("leaves no file empty", () => {
    for (const entry of exportFileEntries(makeEmptySnapshot())) {
      expect(String(entry.data).length, entry.name).toBeGreaterThan(20);
    }
  });
});

describe("buildExportArchive", () => {
  const archive = buildExportArchive(makeSnapshot());

  it("returns a zip whose entries are the seven files", () => {
    expect(readNames(archive.bytes)).toEqual([...EXPORT_FILES]);
  });

  it("returns the filename alongside the bytes", () => {
    expect(archive.filename).toBe("dlectroflow-export-sam-2026-08-03.zip");
  });

  it("round-trips each file's real content through the archive", () => {
    expect(readEntry(archive.bytes, "README.md")).toContain(
      "# Your dlectroflow data",
    );
    expect(readEntry(archive.bytes, "tasks.md")).toContain(
      "# dlectroflow — tasks",
    );
    expect(readEntry(archive.bytes, "scheduled.ics")).toContain(
      "BEGIN:VCALENDAR",
    );
    expect(
      JSON.parse(readEntry(archive.bytes, "export.json")).schemaVersion,
    ).toBe(1);
    expect(readEntry(archive.bytes, "tasks.csv").split("\r\n")[0]).toBe(
      "id,title,status,source,scheduled_at,schedule_due_at,priority,hours,created_at",
    );
  });

  it("preserves CSV CRLF endings through compression", () => {
    expect(readEntry(archive.bytes, "inbox.csv")).toContain("\r\n");
  });

  it("stamps the archive with the export time", () => {
    // DOS timestamps are local wall-clock (no timezone), so the assertion reads
    // the same instant through local accessors rather than pinning a UTC literal.
    const view = new DataView(
      archive.bytes.buffer,
      archive.bytes.byteOffset,
      archive.bytes.byteLength,
    );
    const exportedAt = makeSnapshot().exportedAt;
    expect(view.getUint16(12, true)).toBe(
      ((exportedAt.getFullYear() - 1980) << 9) |
        ((exportedAt.getMonth() + 1) << 5) |
        exportedAt.getDate(),
    );
  });

  it("builds a valid archive for a brand-new account with nothing in it", () => {
    const empty = buildExportArchive(makeEmptySnapshot());
    expect(readNames(empty.bytes)).toEqual([...EXPORT_FILES]);
    expect(readEntry(empty.bytes, "tasks.md")).toContain("No tasks");
    expect(JSON.parse(readEntry(empty.bytes, "export.json")).tasks).toEqual([]);
  });

  it("is deterministic for the same snapshot", () => {
    const a = buildExportArchive(makeSnapshot()).bytes;
    const b = buildExportArchive(makeSnapshot()).bytes;
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });
});
