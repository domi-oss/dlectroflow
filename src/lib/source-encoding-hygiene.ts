/**
 * #224 — source-encoding hygiene: does any tracked text file hold a raw control
 * BYTE, which stops a scanner reading the file at all?
 *
 * A single raw NUL inside a TypeScript string literal makes `file(1)` classify
 * the whole file as `data`. Semgrep then skips it entirely and SAST reports zero
 * findings for it — not because it is clean, but because nothing looked. That
 * was MEASURED on !292, not inferred: pipelines 2188, 2250 and 2264 all reported
 * 0 findings for `migration-data-harness.ts`, and 3 the moment the NUL was
 * removed, with the flagged code unchanged for the whole period. All three were
 * false positives, but a real finding would have been equally invisible. Two
 * more files (`breakdown.test.ts`, `breakdown-context.test.ts`) carried one on
 * `main` for weeks.
 *
 * This is the sharpest instance of the class where a green signal means nothing
 * was examined, and nobody investigates a clean SAST report — so a test is the
 * only thing that can see it. Same argument `fetch-host-hygiene`,
 * `regexp-source-hygiene` and `a11y-class-hygiene` were built on.
 *
 * ── One claim in #224 does not survive measurement, and it is recorded here ──
 * #224 says the two files were also invisible to `git grep`, because git prints
 * only "Binary file X matches" instead of the matching lines. The mechanism is
 * real; it did NOT apply to these two files, and the difference is a number
 * worth knowing.
 *
 * git decides "binary" by looking for a NUL in roughly the FIRST 8000 BYTES
 * only. Measured on a throwaway repo: a NUL at offset 112 produced "Binary file
 * early.ts matches", while the same NUL at offset 9012 produced ordinary
 * `file:line:text` output — and `file -b` said `data` for both. The two NULs on
 * `main` sat at offsets 10518 and 12814, so `git grep` printed their lines
 * normally the whole time, which is confirmed against `origin/main` itself.
 *
 * `file` has no such window, which is exactly why this is a scanner problem
 * rather than a grep problem: the SAST blind spot is total and position-
 * independent, and the grep symptom that would have made it visible to a human
 * only appears when the byte lands early. That asymmetry is the reason this had
 * to be found by fixing something else.
 *
 * ── The rule is `file`'s text table, NOT "valid UTF-8" ──────────────────────
 * #224's scope line asked for a check that a tracked file "is not valid UTF-8
 * text". Measuring `file` on single-byte fixtures shows that to be the wrong
 * rule in both directions:
 *
 *   * U+0000 IS valid UTF-8. The defect that started this passes a UTF-8
 *     validity check, so that rule would have caught none of the three files.
 *   * A lone 0xFF is NOT valid UTF-8, and `file` reports `ISO-8859 text` for
 *     it — no `data` classification, so nothing is skipped. Mojibake is a
 *     correctness problem for whoever reads the file, not a scanner blind spot,
 *     and it is left out of scope here rather than silently folded in.
 *
 * What decides whether the file is read at all is `file`'s own text table, so
 * that is what {@link isBinaryClassifyingByte} encodes. The values were measured
 * by running `file -b` over one-byte-per-fixture files rather than copied from
 * the source of `file`, and `source-encoding-hygiene.test.ts` keeps that
 * measurement as a table so a future `file` change shows up as a test failure
 * rather than as a guard that quietly stopped matching the tool.
 *
 * ── Kept free of `fs`, like every other hygiene module ───────────────────────
 * The caller reads the files; this module classifies bytes. It takes a
 * `Uint8Array` rather than a string on purpose — decoding to UTF-8 first is the
 * step that would hide the very thing being looked for, since a `Buffer`
 * round-tripped through a lossy decode no longer carries the offending byte at a
 * knowable offset.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 * It does not decide which files are legitimately binary. That allowlist is a
 * repo fact and lives in the colocated test next to the sweep, the same place
 * `fetch-host-hygiene` keeps `REVIEWED_DYNAMIC_HOSTS`.
 */

/** Which of the two problems a raw byte is. */
export type ControlByteKind =
  /**
   * `file` classifies the file as `data`, so a scanner reading it as text skips
   * it whole. This is the measured defect: absence of findings, not cleanliness.
   */
  | "binary-classifying"
  /**
   * `file` still calls the file text, so nothing is blinded — but a raw control
   * character in source is invisible in review and in a diff, and every string
   * literal that wants one can say so with an escape instead.
   */
  | "escapable-control";

/** One offending byte, and everything needed to find and fix it. */
export interface ControlByteFinding {
  /** 0-based offset in the file, which is what `hexdump -C` and the issue's own
   *  table use. */
  offset: number;
  /** 1-based line, counting LF. */
  line: number;
  /** 1-based byte column within that line. Bytes, not code points: the point of
   *  this guard is that the file may not decode. */
  column: number;
  /** The offending byte's value, 0x00–0xff. */
  byte: number;
  kind: ControlByteKind;
  /** The escape sequence that produces the identical run-time character, so the
   *  fix cannot change what a fixture feeds the code under test. */
  escape: string;
  /** Why this byte is a problem, in a sentence — stated on the finding so a
   *  failure message explains itself without the reader coming here. */
  reason: string;
}

/** The result of a scan: a bounded sample, plus the true count. */
export interface ControlByteScan {
  /** The first `limit` findings, in file order. */
  findings: ControlByteFinding[];
  /**
   * How many offending bytes the file actually holds, which may exceed
   * `findings.length`. Reported separately so a truncated scan says so instead
   * of looking like a small problem.
   */
  total: number;
}

/**
 * How many findings a scan retains per file.
 *
 * Not a style choice: an unallowlisted binary asset — someone adds a `.ico`, or
 * a new audio format — holds tens of thousands of offending bytes, and a failure
 * message that listed them all would be megabytes long and unreadable. A sample
 * plus {@link ControlByteScan.total} says the same thing in two lines.
 */
export const DEFAULT_FINDING_LIMIT = 10;

/**
 * The C0 control bytes `file` accepts as text. MEASURED with `file -b` on a
 * one-byte fixture per value, not read off `file`'s table:
 *
 *   0x07 BEL  `ASCII text`                        0x0b VT   `ASCII text`
 *   0x08 BS   `ASCII text, with overstriking`     0x0c FF   `ASCII text`
 *   0x09 TAB  `ASCII text`                        0x0d CR   `ASCII text`
 *   0x0a LF   `ASCII text`                        0x1b ESC  `…with escape sequences`
 *
 * Everything else below 0x20, and 0x7f, reported `data`.
 */
const FILE_TEXT_CONTROL_BYTES: ReadonlySet<number> = new Set([
  0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b,
]);

/**
 * The three control bytes that are ordinary source whitespace, so never a
 * finding however they are written. Everything else below 0x20 is reported —
 * including BEL, BS, VT, FF and ESC, which `file` tolerates. They are not a
 * scanner blind spot, they are the sibling defect: `breakdown.test.ts` carried a
 * raw BEL and a raw ESC on the same line as its NUL, and a guard scoped strictly
 * to what blinds `file` would have declared that line fixed with two of its
 * three raw bytes still in place.
 */
const SOURCE_WHITESPACE_BYTES: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0d,
]);

const PRINTABLE_ASCII_FIRST = 0x20;
const PRINTABLE_ASCII_LAST = 0x7e;

/**
 * 0x80 and above. `file` reports `Non-ISO extended-ASCII text` for a lone 0x80
 * and `ISO-8859 text` for a lone 0xff — both TEXT, so neither produces the
 * skip-the-file behaviour this guard exists to prevent. Valid UTF-8 for any
 * non-ASCII character is made of these bytes, and this repo's source contains
 * plenty (em dashes and box-drawing characters in comments), so treating them as
 * suspect would report most of the tree.
 */
const HIGH_BYTE_FIRST = 0x80;

/** C0 names by byte value, for a message a reader can act on. */
const C0_NAMES = [
  "NUL",
  "SOH",
  "STX",
  "ETX",
  "EOT",
  "ENQ",
  "ACK",
  "BEL",
  "BS",
  "TAB",
  "LF",
  "VT",
  "FF",
  "CR",
  "SO",
  "SI",
  "DLE",
  "DC1",
  "DC2",
  "DC3",
  "DC4",
  "NAK",
  "SYN",
  "ETB",
  "CAN",
  "EM",
  "SUB",
  "ESC",
  "FS",
  "GS",
  "RS",
  "US",
] as const;

const DELETE_BYTE = 0x7f;

/** The mnemonic for a control byte, e.g. `NUL` for 0x00. */
export function controlByteName(byte: number): string {
  if (byte === DELETE_BYTE) return "DEL";
  return C0_NAMES[byte] ?? "non-control";
}

const REASONS: Record<ControlByteKind, string> = {
  "binary-classifying":
    "`file` reports this file as `data`, so Semgrep skips it whole and SAST " +
    "reports zero findings for it whatever the code says (#224)",
  "escapable-control":
    "`file` still calls this file text, so no scanner is blinded — but a raw " +
    "control character is invisible in review and in a diff, and the string " +
    "literal holding it means exactly the same thing written as an escape",
};

/**
 * Would this byte, present anywhere in a file, make `file` classify that file as
 * `data` rather than text — and so make every text-based scanner skip it?
 *
 * Throws on a non-byte rather than answering: a caller that has managed to pass
 * `-1`, `256` or a fraction is not reading a `Uint8Array`, and a confident
 * `false` there is how a guard stops guarding.
 */
export function isBinaryClassifyingByte(byte: number): boolean {
  if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
    throw new RangeError(
      `isBinaryClassifyingByte: ${byte} is not a byte (0–255). This function ` +
        `classifies raw file bytes; a code point is not a byte.`,
    );
  }
  if (byte >= PRINTABLE_ASCII_FIRST && byte <= PRINTABLE_ASCII_LAST) {
    return false;
  }
  if (byte >= HIGH_BYTE_FIRST) return false;
  return !FILE_TEXT_CONTROL_BYTES.has(byte);
}

/** Which problem `byte` is, or `null` when it is legitimate source. */
function kindOf(byte: number): ControlByteKind | null {
  if (SOURCE_WHITESPACE_BYTES.has(byte)) return null;
  if (isBinaryClassifyingByte(byte)) return "binary-classifying";
  if (byte < PRINTABLE_ASCII_FIRST) return "escapable-control";
  return null;
}

/**
 * The `\uXXXX` escape denoting the same character as `byte`.
 *
 * Every byte this module reports is below 0x80, so its value and its code point
 * are the same number and the escape is exact. Four hex digits rather than
 * `\xXX` because `\u0000` is the form #224 asks for and the only one that is
 * also valid inside a JSON string, which is what lets the test prove the escape
 * round-trips.
 */
export function escapeForByte(byte: number): string {
  return `\\u${byte.toString(16).padStart(4, "0")}`;
}

/**
 * Every raw control byte in `bytes`, in file order, capped at `limit`.
 *
 * Bytes rather than a decoded string: see the module comment — decoding is the
 * step that loses the evidence.
 */
export function scanControlBytes(
  bytes: Uint8Array,
  limit: number = DEFAULT_FINDING_LIMIT,
): ControlByteScan {
  const findings: ControlByteFinding[] = [];
  let total = 0;
  let line = 1;
  let lineStart = 0;

  for (let offset = 0; offset < bytes.length; offset += 1) {
    const byte = bytes[offset];
    if (byte === 0x0a) {
      line += 1;
      lineStart = offset + 1;
      continue;
    }
    const kind = kindOf(byte);
    if (kind === null) continue;
    total += 1;
    if (findings.length >= limit) continue;
    findings.push({
      offset,
      line,
      column: offset - lineStart + 1,
      byte,
      kind,
      escape: escapeForByte(byte),
      reason: REASONS[kind],
    });
  }

  return { findings, total };
}

/**
 * One line naming the file, the position, the byte and the fix.
 *
 * `file:line:column` first because that is the form an editor and a CI log
 * reader both jump to, and the byte offset after it because a file `file` calls
 * binary is one whose lines a plain `git grep` will not print.
 */
export function formatControlByteFinding(
  file: string,
  finding: ControlByteFinding,
): string {
  const hex = `0x${finding.byte.toString(16).padStart(2, "0")}`;
  return (
    `${file}:${finding.line}:${finding.column} — raw ${hex} ` +
    `${controlByteName(finding.byte)} at byte offset ${finding.offset}. ` +
    `Write it as ${finding.escape} instead, which is the identical run-time ` +
    `character: ${finding.reason}.`
  );
}

/**
 * The lower-cased extension of `path`, including the dot, or `""` when there is
 * none.
 *
 * Lower-cased because an allowlist of binary asset extensions that missed
 * `LOGO.PNG` would report a legitimate image as a source-encoding failure, and
 * `path.extname` alone does not fold case. A leading dot with nothing before it
 * is a dotfile, not an extension: `.gitignore` has no extension, so it is text
 * and gets scanned.
 */
export function fileExtensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot).toLowerCase();
}
