import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isolatedGitEnv } from "@/lib/git-env";
import {
  DEFAULT_FINDING_LIMIT,
  controlByteName,
  escapeForByte,
  fileExtensionOf,
  formatControlByteFinding,
  isBinaryClassifyingByte,
  scanControlBytes,
} from "@/lib/source-encoding-hygiene";

/**
 * `src/lib/source-encoding-hygiene.ts` plus a sweep of the real tree (#224).
 *
 * Two halves, the shape `CLAUDE.md` prescribes for every file-parsing guard
 * here: the classifier is exercised on **synthetic** bytes so it can be shown to
 * fail, and one test reads the real files.
 *
 * The synthetic half carries the load, because this guard's failure mode is
 * silence. It replaces nothing a scanner does — it asserts that the scanners
 * *ran at all* on every file, which no scanner can report about itself. A
 * version of it that could not catch a NUL would look identical from the outside
 * to a clean tree, which is the exact confusion #224 is about.
 */

// ── Extensions whose files are legitimately binary ──────────────────────────
//
// Measured off the tree with `git ls-files -z | xargs -0 file --mime-encoding`,
// not copied from a list of known media types: every entry here is a real file
// in this repo today, and the "no speculative entry" test below fails if one
// stops being. That matters more than tidiness — this map is the only way to
// make the guard blind, so an entry nobody can point at a file for is an
// unreviewed hole.
//
// Adding one is a decision to stop scanning a class of file, so it carries its
// reason, the same contract `REVIEWED_DYNAMIC_HOSTS` carries in
// `fetch-host-hygiene.test.ts`.
const BINARY_ASSET_EXTENSIONS: Record<string, string> = {
  ".png":
    "raster images: the brand mark, the app/apple touch icons, and the " +
    "design-spec screenshots under docs/design/specs/assets/.",
  ".woff2":
    "the self-hosted OpenDyslexic web font, which the dyslexia-friendly " +
    "typeface setting needs served from this origin rather than a CDN.",
  ".mp3": "the lo-fi focus catalog shipped under public/audio/lofi/.",
  ".wav": "the focus-timer alarm at public/audio/alarm.wav.",
};

// Extensions that must never appear in the allowlist above, because a file with
// one is source, config or prose that a scanner is expected to read. Listed
// explicitly rather than derived, so widening the allowlist to `.ts` in a hurry
// fails a test instead of quietly turning the guard off.
const NEVER_ALLOWLISTED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".sql",
  ".sh",
  ".toml",
  ".css",
  ".prisma",
  ".svg",
] as const;

const REPO_ROOT = path.join(__dirname, "..", "..");

/**
 * Every file git tracks, repo-relative.
 *
 * `git ls-files` rather than the `readdirSync` the other hygiene tests use,
 * because this is the only guard here whose scope is the WHOLE repository rather
 * than `src/`: a recursive readdir from the root would walk `node_modules`,
 * `.next` and — in this repo's normal working setup — sibling worktrees, and
 * `.gitignore` is the only thing that knows which of those count. It is also the
 * exact surface #224's own detector used, so the sweep and the issue agree about
 * what "tracked" means.
 *
 * Hardened the way #146 requires of every git child here: `-C REPO_ROOT` *and*
 * `cwd`, with an allow-listed environment, so an inherited `GIT_DIR` cannot
 * point this at another repository and have it report that tree as clean.
 *
 * The index, so a file that has never been `git add`ed is not scanned. That is
 * deliberate rather than an oversight: adding `--others --exclude-standard`
 * would also sweep whatever scratch files happen to be lying in a working tree,
 * reddening the suite over something that is not in the repo. Nothing reaches
 * `main` unstaged, so CI sees every file either way; locally the cost is that a
 * brand-new fixture is checked from the moment it is staged rather than the
 * moment it is written.
 */
function trackedFiles(): string[] {
  const out = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: isolatedGitEnv(),
    // A large tree overruns the default 1 MB stdout buffer, and execFileSync
    // signals that by THROWING ENOBUFS — but only once the tree is big enough,
    // which is the kind of latent failure this guard exists to avoid.
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split("\0").filter((entry) => entry.length > 0);
}

/** The tracked files this guard scans: everything not an allow-listed asset. */
function scannedFiles(): string[] {
  return trackedFiles().filter(
    (file) => !(fileExtensionOf(file) in BINARY_ASSET_EXTENSIONS),
  );
}

/**
 * `file`'s bytes, or `null` when the index and the working tree disagree.
 *
 * A tracked path missing from disk is an unstaged deletion in somebody's
 * checkout — a local state, not repo drift — so it is skipped rather than
 * reported. That skip is the one silent path in here, which is why the
 * "the sweep can see the real files" test below names actual files instead of
 * only counting them: a bug that made every read fail would otherwise present
 * as a clean tree.
 */
function readTracked(file: string): Uint8Array | null {
  try {
    return readFileSync(path.join(REPO_ROOT, file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Every raw control byte in the real tree, as ready-to-read message lines. */
function repoOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of scannedFiles()) {
    const bytes = readTracked(file);
    if (bytes === null) continue;
    const { findings, total } = scanControlBytes(bytes);
    for (const finding of findings) {
      offenders.push(formatControlByteFinding(file, finding));
    }
    if (total > findings.length) {
      offenders.push(
        `${file} — and ${total - findings.length} more raw control bytes ` +
          `beyond the first ${findings.length}. A file with this many is ` +
          `probably a binary asset: if it is, add its extension to ` +
          `BINARY_ASSET_EXTENSIONS with a reason.`,
      );
    }
  }
  return offenders;
}

/** Synthetic file bytes from a string written with escapes. */
function bytesOf(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

describe("isBinaryClassifyingByte — the measured `file` boundary", () => {
  /**
   * MEASURED, not reasoned about: each byte below was written into its own
   * one-line `.ts` fixture and passed to `file -b` on 2026-08-14. This table is
   * the evidence for the whole guard, so it records the verdict `file` actually
   * gave rather than what its documentation implies.
   *
   * The surprise, and the reason the guard reports two kinds rather than one:
   * BEL, BS, VT, FF and ESC are all TEXT to `file`. A rule scoped strictly to
   * "would make `file` say data" would not have flagged the raw BEL and ESC
   * sitting beside the NUL in `breakdown.test.ts`.
   */
  const MEASURED: { byte: number; verdict: string; binary: boolean }[] = [
    { byte: 0x00, verdict: "data", binary: true },
    { byte: 0x01, verdict: "data", binary: true },
    { byte: 0x07, verdict: "ASCII text", binary: false },
    { byte: 0x08, verdict: "ASCII text, with overstriking", binary: false },
    { byte: 0x0b, verdict: "ASCII text", binary: false },
    { byte: 0x0c, verdict: "ASCII text", binary: false },
    { byte: 0x0e, verdict: "data", binary: true },
    { byte: 0x1a, verdict: "data", binary: true },
    { byte: 0x1b, verdict: "ASCII text, with escape sequences", binary: false },
    { byte: 0x1c, verdict: "data", binary: true },
    { byte: 0x1f, verdict: "data", binary: true },
    { byte: 0x7f, verdict: "data", binary: true },
    { byte: 0x80, verdict: "Non-ISO extended-ASCII text", binary: false },
    { byte: 0xff, verdict: "ISO-8859 text", binary: false },
  ];

  it.each(MEASURED)(
    "0x$byte matches the `file -b` verdict recorded for it",
    ({ byte, verdict, binary }) => {
      expect(
        isBinaryClassifyingByte(byte),
        `file -b reported ${JSON.stringify(verdict)} for a fixture whose only ` +
          `unusual byte was 0x${byte.toString(16)}`,
      ).toBe(binary);
    },
  );

  it("treats printable ASCII, tab, newline and carriage return as text", () => {
    for (const byte of [0x09, 0x0a, 0x0d, 0x20, 0x41, 0x7e]) {
      expect(isBinaryClassifyingByte(byte), `0x${byte.toString(16)}`).toBe(
        false,
      );
    }
  });

  it("refuses a value that is not a byte rather than answering false", () => {
    // A confident `false` for a non-byte is how a guard stops guarding: the
    // caller has passed a code point or an off-by-one index, and every one of
    // those is a bug in the caller, not a clean file.
    for (const notAByte of [-1, 256, 1.5, Number.NaN, 0x110000]) {
      expect(() => isBinaryClassifyingByte(notAByte)).toThrow(RangeError);
    }
  });
});

describe("scanControlBytes — what it reports", () => {
  it("finds nothing in ordinary source, including tabs and CRLF", () => {
    const source = 'const a = "x";\r\n\tconst b = `y`;\n// — an em dash\n';
    expect(scanControlBytes(bytesOf(source))).toEqual({
      findings: [],
      total: 0,
    });
  });

  it("finds nothing in a file whose only non-ASCII is valid UTF-8", () => {
    // The comment blocks in this repo are full of these, and a guard that
    // reported them would be deleted within a day.
    const source = "// ── ✅ naïve façade — 日本語 ──\nexport const x = 1;\n";
    expect(scanControlBytes(bytesOf(source)).total).toBe(0);
  });

  it("reports a NUL with its offset, position, escape and kind", () => {
    const source = 'const a = "x";\nconst b = "y\u0000z";\n';
    const { findings, total } = scanControlBytes(bytesOf(source));
    expect(total).toBe(1);
    expect(findings).toEqual([
      {
        offset: source.indexOf("\u0000"),
        line: 2,
        // `const b = "y` is 12 bytes, so the NUL is the 13th byte on line 2.
        column: 13,
        byte: 0x00,
        kind: "binary-classifying",
        escape: "\\u0000",
        reason: expect.stringContaining("Semgrep's parser fails at this byte"),
      },
    ]);
  });

  it("reports BEL and ESC as escapable rather than binary-classifying", () => {
    // This is the distinction the `file` measurement forced. Both are still
    // findings — the fix escapes them — but neither blinds a scanner, and a
    // failure message that claimed otherwise would be wrong.
    const { findings } = scanControlBytes(bytesOf("a\u0007b\u001bc"));
    expect(findings.map((f) => [f.byte, f.kind])).toEqual([
      [0x07, "escapable-control"],
      [0x1b, "escapable-control"],
    ]);
    for (const finding of findings) {
      expect(finding.reason).toContain("does not produce");
    }
  });

  it("reports DEL, which is above printable ASCII rather than below it", () => {
    // 0x7f is the one offender outside the C0 block, so a range check written
    // as `byte < 0x20` alone misses it — and `file` calls a file holding one
    // `data`, so it is the blinding kind.
    const { findings } = scanControlBytes(bytesOf("a\u007fb"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      byte: 0x7f,
      kind: "binary-classifying",
      escape: "\\u007f",
    });
  });

  it("counts lines from 1 and columns in bytes from 1", () => {
    const source = "one\ntwo\nthree\u0000\n";
    const [finding] = scanControlBytes(bytesOf(source)).findings;
    expect(finding.line).toBe(3);
    expect(finding.column).toBe(6);
    expect(finding.offset).toBe(13);
  });

  it("counts columns in BYTES, so a multi-byte character shifts the column", () => {
    // Deliberate: a file `file` calls binary may not decode at all, so a code
    // point column would be a number no tool could reproduce. `hexdump -C` and
    // the offset agree with each other, and that is the pair a reader uses.
    const [finding] = scanControlBytes(bytesOf("é\u0000")).findings;
    expect(finding.column).toBe(3);
    expect(finding.offset).toBe(2);
  });

  it("caps the findings it retains but not the total it reports", () => {
    // An unallowlisted binary asset holds tens of thousands of these. The cap is
    // what keeps the failure message readable; `total` is what stops the cap
    // making the problem look small.
    const scan = scanControlBytes(bytesOf("\u0000".repeat(50)));
    expect(scan.findings).toHaveLength(DEFAULT_FINDING_LIMIT);
    expect(scan.total).toBe(50);
    expect(scan.findings.map((f) => f.offset)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("honours an explicit limit, including zero", () => {
    const bytes = bytesOf("\u0000\u0000\u0000");
    expect(scanControlBytes(bytes, 1).findings).toHaveLength(1);
    expect(scanControlBytes(bytes, 0)).toEqual({ findings: [], total: 3 });
  });

  it("reports an empty file as clean", () => {
    expect(scanControlBytes(new Uint8Array(0))).toEqual({
      findings: [],
      total: 0,
    });
  });
});

describe("escapeForByte — the suggested fix must denote the same character", () => {
  it("round-trips every reportable byte through a JSON string", () => {
    // The point of the guard is that escaping must not change the run-time
    // string, so the suggestion is PROVED rather than asserted: JSON is an
    // independent parser of the same `\\uXXXX` syntax TypeScript uses, so if
    // `JSON.parse` reads the escape back as the original code point, the
    // replacement is byte-identical.
    for (let byte = 0; byte < 0x80; byte += 1) {
      const escape = escapeForByte(byte);
      expect(JSON.parse(`"${escape}"`), escape).toBe(String.fromCharCode(byte));
    }
  });

  it("always produces four hex digits", () => {
    expect(escapeForByte(0x00)).toBe("\\u0000");
    expect(escapeForByte(0x07)).toBe("\\u0007");
    expect(escapeForByte(0x1b)).toBe("\\u001b");
    expect(escapeForByte(0x7f)).toBe("\\u007f");
  });
});

describe("controlByteName", () => {
  it("names the bytes that actually turn up in source", () => {
    expect(controlByteName(0x00)).toBe("NUL");
    expect(controlByteName(0x07)).toBe("BEL");
    expect(controlByteName(0x1b)).toBe("ESC");
    expect(controlByteName(0x7f)).toBe("DEL");
  });

  it("does not invent a name for a printable byte", () => {
    expect(controlByteName(0x41)).toBe("non-control");
  });
});

describe("formatControlByteFinding", () => {
  it("names the file, the position, the byte and the fix", () => {
    const [finding] = scanControlBytes(bytesOf('f("a\u0000")')).findings;
    const message = formatControlByteFinding("src/lib/x.test.ts", finding);
    expect(message).toContain("src/lib/x.test.ts:1:5");
    expect(message).toContain("0x00 NUL");
    expect(message).toContain("byte offset 4");
    expect(message).toContain("\\u0000");
  });
});

describe("fileExtensionOf", () => {
  it("lower-cases, so an allow-listed asset in caps is still an asset", () => {
    expect(fileExtensionOf("public/LOGO.PNG")).toBe(".png");
    expect(fileExtensionOf("a/b.Woff2")).toBe(".woff2");
  });

  it("takes the last extension only", () => {
    expect(fileExtensionOf("src/lib/a.test.ts")).toBe(".ts");
    expect(fileExtensionOf("archive.tar.gz")).toBe(".gz");
  });

  it("treats a dotfile as having no extension, so it gets scanned", () => {
    // `.gitignore`, `.gitattributes` and `.env.example` are text and a scanner
    // is expected to read them; a rule that read `.gitignore`'s extension as
    // `.gitignore` would be harmless, but one that read it as an allow-listable
    // extension would not.
    expect(fileExtensionOf(".gitignore")).toBe("");
    expect(fileExtensionOf("docker/.dockerignore")).toBe("");
    expect(fileExtensionOf("Dockerfile")).toBe("");
    expect(fileExtensionOf("a/b/no-extension")).toBe("");
  });

  it("ignores a dot in a directory name", () => {
    expect(fileExtensionOf(".gitlab/duo/prompts/x")).toBe("");
    expect(fileExtensionOf(".gitlab/renovate.json")).toBe(".json");
  });
});

describe("the real tree", () => {
  it("has no tracked text file holding a raw control byte", () => {
    // THE gate. A file that fails this is skipped whole by Semgrep, so every
    // SAST result for it — including a clean one — says nothing at all.
    expect(
      repoOffenders(),
      "Raw control bytes in tracked text files. Each one belongs in its " +
        "string literal as the \\uXXXX escape named below, which produces the " +
        "identical run-time character (#224):",
    ).toEqual([]);
  });

  it("can see the real files it claims to have scanned", () => {
    // The unproven-zero control. Every other assertion here passes trivially if
    // the sweep enumerates nothing, and #224 is precisely a story about a green
    // signal that meant nobody looked — so the sweep names files it must have
    // seen rather than only counting them.
    const scanned = new Set(scannedFiles());
    for (const file of [
      "src/lib/source-encoding-hygiene.ts",
      "src/lib/source-encoding-hygiene.test.ts",
      "src/lib/breakdown.test.ts",
      "src/lib/breakdown-context.test.ts",
      "package.json",
      "CLAUDE.md",
    ]) {
      expect(scanned, `${file} must be in the scanned set`).toContain(file);
    }
    // A floor, not a count: an exact number would be stale by the next commit,
    // while a sweep that has collapsed to a handful of files is the failure
    // being guarded against.
    expect(scanned.size).toBeGreaterThan(300);
  });

  it("scans every tracked text file it can read", () => {
    // The other half of the same control: a bug that made every read fail would
    // present as a clean tree, because `readTracked` returns null on ENOENT.
    const unreadable = scannedFiles().filter(
      (file) => readTracked(file) === null,
    );
    expect(
      unreadable,
      "tracked files missing from the working tree — an unstaged deletion " +
        "locally, but in CI it means the sweep skipped files silently",
    ).toEqual([]);
  });

  it("allow-lists no extension it cannot point at a real file", () => {
    // A speculative entry is an unreviewed hole: it turns off scanning for a
    // class of file nobody has checked is binary. Keeping the map measured off
    // the tree is what stops it growing by habit.
    const present = new Set(trackedFiles().map(fileExtensionOf));
    for (const extension of Object.keys(BINARY_ASSET_EXTENSIONS)) {
      expect(
        present,
        `${extension} is allow-listed but no tracked file has it. Remove the ` +
          `entry: it is scanning nothing and hiding whatever arrives next.`,
      ).toContain(extension);
    }
  });

  it("allow-lists no extension whose files a scanner must read", () => {
    for (const extension of NEVER_ALLOWLISTED_EXTENSIONS) {
      expect(
        BINARY_ASSET_EXTENSIONS,
        `${extension} is source, config or prose — allow-listing it would ` +
          `turn this guard off for the files it exists to protect`,
      ).not.toHaveProperty(extension);
    }
  });

  it("states a reason for every allow-listed extension", () => {
    for (const [extension, reason] of Object.entries(BINARY_ASSET_EXTENSIONS)) {
      expect(reason.length, extension).toBeGreaterThan(30);
    }
  });

  it("allow-lists only files the scanner would in fact have reported", () => {
    // Proves the allowlist is load-bearing rather than decorative: for each
    // entry, a real file with that extension is checked to hold
    // binary-classifying bytes. If one did not, the extension is not an
    // exception at all and the entry should go — which is the shape of a
    // too-broad allowlist, the way this guard would most plausibly be defeated.
    const tracked = trackedFiles();
    for (const extension of Object.keys(BINARY_ASSET_EXTENSIONS)) {
      const sample = tracked.find(
        (file) => fileExtensionOf(file) === extension,
      );
      expect(sample, extension).toBeDefined();
      const bytes = readTracked(sample as string);
      expect(bytes, `${sample as string} must be readable`).not.toBeNull();
      const { findings } = scanControlBytes(bytes as Uint8Array);
      expect(
        findings.some((f) => f.kind === "binary-classifying"),
        `${sample as string} holds no binary-classifying byte, so ` +
          `${extension} is not a binary asset extension and does not need an ` +
          `exception`,
      ).toBe(true);
    }
  });
});
