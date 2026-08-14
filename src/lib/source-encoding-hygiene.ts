/**
 * #224 — source-encoding hygiene: does any tracked text file hold a raw control
 * BYTE, which stops a scanner reading the file at all?
 *
 * A single raw NUL inside a TypeScript string literal makes `file(1)` classify
 * the whole file as `data`, and Semgrep's parser then fails on it, so SAST
 * reports nothing for the file — not because it is clean, but because nothing
 * read it. #224 recorded this on !292: pipelines 2188, 2250 and 2264 reported 0
 * findings for `migration-data-harness.ts` and 3 the moment the NUL was removed,
 * with the flagged code unchanged throughout. Two more files
 * (`breakdown.test.ts`, `breakdown-context.test.ts`) carried one on `main` for
 * weeks.
 *
 * This is the sharpest instance of the class where a green signal means nothing
 * was examined, and nobody investigates a clean SAST report — so a test is the
 * only thing that can see it. Same argument `fetch-host-hygiene`,
 * `regexp-source-hygiene` and `a11y-class-hygiene` were built on.
 *
 * ── The mechanism, measured HERE rather than inherited ──────────────────────
 * Two adjacent commits on !347 make this observable directly, same branch, same
 * ruleset, same analyzer (GitLab Semgrep analyzer v6.19.1). Before the escapes,
 * the `semgrep-sast` job log carried exactly two of these:
 *
 *   [WARN] tool notification warning: Syntax error at line
 *     src/lib/breakdown-context.test.ts:317:
 *   [WARN] tool notification warning: Syntax error at line
 *     src/lib/breakdown.test.ts:292:
 *
 * — the two lines holding the raw bytes. After the escapes, neither file appears
 * in the log at all.
 *
 * Two refinements to the mechanism as #224 describes it, both worth having:
 *
 *   1. The analyzer does NOT drop the file from its target list. `Scanning 796
 *      files`, `ts … 655`, `Targets scanned: 678` and `Findings: 37` were
 *      IDENTICAL across the two commits. So the file is counted as scanned while
 *      its contents are not parsed, which is the worst possible combination for
 *      anyone auditing coverage from the summary.
 *   2. Because of that, a FINDING COUNT is the wrong evidence surface — #224's
 *      own scope line says "an unchanged 0 proves nothing", and here it stayed 0
 *      on both sides. The per-file `Syntax error` warning is the signal, and it
 *      was present in every SAST run this repo has ever done. It sits in the job
 *      log rather than the security report, which is why nobody read it.
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
 * `file` has no such window, and neither does the analyzer's parser — it failed
 * on the byte at offset 10518, well past anything git would have looked at. That
 * is the asymmetry, and it is the reason this had to be found by fixing
 * something else: the scanner problem does not depend on where the byte lands,
 * while the grep symptom that would have shown it to a human only appears when
 * the byte lands early.
 *
 * "Total" would be the wrong word for the scanner side, per refinement 1 above:
 * the file is not dropped, it is counted as scanned and then not parsed.
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
 * ── How the byte gets IN, measured on !347 ──────────────────────────────────
 * Everything above says why the byte is harmful and what to replace it with.
 * None of it said how the byte ARRIVES, and a fixture author who does not know
 * that reintroduces it on the next fixture — so it is recorded here.
 *
 * A `\uXXXX` escape typed into a file-authoring tool whose input is carried as
 * JSON is DECODED on the way to disk: the file receives the raw byte, not the
 * six ASCII characters of the escape. Measured twice, not inferred:
 *
 *   1. The pre-fix `breakdown.test.ts` held 0x00, 0x07 and 0x1b at offsets
 *      10518, 10523 and 10528 — byte for byte, and in the exact positions,
 *      what a `"call…the…vet…"` fixture written with those three escapes
 *      becomes once they are decoded.
 *   2. Reproduced deliberately while proving this guard bites: a scratch script
 *      authored with the escapes typed landed holding two raw NULs and a raw
 *      BEL, and `file -b` reported `binary data` for it. Rewritten with each
 *      escape assembled from a backslash byte plus `"u0000"` it is clean, and
 *      two separate authoring tools were seen decoding it the same way in one
 *      session.
 *
 * The consequence is that this guard's own remediation is a hazard: apply
 * "write it as the escape instead" using the tool that decoded the escape the
 * first time, and the raw byte comes straight back — in a diff that renders
 * identically either way, which is why nobody catches it by reading. That is
 * what {@link formatControlByteFinding} ends by addressing.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 * It does not decide which files are legitimately binary. That allowlist is a
 * repo fact and lives in the colocated test next to the sweep, the same place
 * `fetch-host-hygiene` keeps `REVIEWED_DYNAMIC_HOSTS`.
 */

/** Which of the two problems a raw byte is. */
export type ControlByteKind =
  /**
   * `file` classifies the file as `data` and Semgrep's parser fails on the byte.
   * The file is still COUNTED as a scanned target, so what a SAST run reports
   * for it is absence rather than cleanliness, and the coverage summary cannot
   * show the difference. This is the measured defect — see the module comment.
   */
  | "binary-classifying"
  /**
   * `file` still calls the file text, so this byte alone does not produce the
   * `data` classification — but a raw control character in source is invisible
   * in review and in a diff, and every string literal that wants one can say so
   * with an escape instead.
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

/**
 * Refuse anything that is not a byte, naming the caller.
 *
 * Every exported function here takes a raw file byte, and each one has a
 * plausible-looking wrong answer for an out-of-range input: `"non-control"`,
 * `false`, or an escape with six hex digits. Those are worse than a throw,
 * because the caller has passed a CODE POINT where a byte was wanted — the one
 * confusion this module exists to keep straight — and a confident answer hides
 * it. Duo review on !347 caught `controlByteName` missing the check that
 * `isBinaryClassifyingByte` already had; factored out here rather than pasted a
 * third time, so the three cannot drift apart again.
 */
function assertByte(byte: number, caller: string): void {
  if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
    throw new RangeError(
      `${caller}: ${byte} is not a byte (0–255). These functions classify raw ` +
        `file bytes; a code point is not a byte.`,
    );
  }
}

/** The mnemonic for a control byte, e.g. `NUL` for 0x00. */
export function controlByteName(byte: number): string {
  assertByte(byte, "controlByteName");
  if (byte === DELETE_BYTE) return "DEL";
  return C0_NAMES[byte] ?? "non-control";
}

const REASONS: Record<ControlByteKind, string> = {
  "binary-classifying":
    "`file` reports this file as `data` and Semgrep's parser fails at this " +
    "byte, so SAST reports nothing for the file whatever the code says. The " +
    "analyzer still counts it as a scanned target, so the coverage summary " +
    "cannot show the gap either (#224)",
  "escapable-control":
    "`file` still calls this file text, so this byte alone does not produce " +
    "the `data` classification — but a raw control character is invisible in " +
    "review and in a diff, and the string literal holding it means exactly " +
    "the same thing written as an escape",
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
  assertByte(byte, "isBinaryClassifyingByte");
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
 *
 * ── The 0x80 ceiling is ENFORCED, not just documented (Duo review, !347) ────
 * The paragraph above states the sub-0x80 invariant, and stating an invariant is
 * not keeping one. `escapeForByte(0x80)` would return `\u0080`, which as a string
 * literal denotes U+0080 — and U+0080 encodes in UTF-8 as TWO bytes, 0xc2 0x80,
 * not as the single byte 0x80. So for anything at or above 0x80 the escape is
 * silently NOT byte-identical, which is the one guarantee this whole module
 * exists to provide. `kindOf` never reports a high byte today, so nothing reaches
 * it — but this function is exported, and "no caller does that yet" is how the
 * guarantee gets quietly broken by the next refactor.
 *
 * The general range check is kept as well, because the two failures have
 * different causes and deserve different messages: 256 or a fraction is not a
 * byte at all, while 0x80 is a perfectly good byte that this escape cannot
 * represent. `padStart` only pads, so an out-of-range value would otherwise come
 * back as a SIX-digit escape that looks valid and denotes something else.
 */
export function escapeForByte(byte: number): string {
  assertByte(byte, "escapeForByte");
  if (byte >= HIGH_BYTE_FIRST) {
    throw new RangeError(
      `escapeForByte: 0x${byte.toString(16)} is at or above 0x80, where a ` +
        `\\uXXXX escape denotes a CODE POINT that UTF-8 encodes as two or more ` +
        `bytes — so the escape would not be byte-identical to the byte, which ` +
        `is the only property that makes this substitution safe (#224).`,
    );
  }
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
 *
 * It closes by sending the reader back to this test, which is not boilerplate:
 * naming the escape ALONE is advice that can reproduce the defect, because an
 * escape decoded on the way to disk is how the byte arrives in the first place
 * — see the measurement in the module docblock. Re-running the sweep is the
 * only step that distinguishes the fixed form from the unfixed one, because a
 * rendered diff cannot.
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
    `character: ${finding.reason}. Then re-run this test rather than reading ` +
    `the diff: a tool or editor that DECODES the escape as it writes puts the ` +
    `raw byte straight back, and both forms render identically.`
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
