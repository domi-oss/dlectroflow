/**
 * `src/lib/regexp-source-hygiene.ts` plus a scan of the real tree (#234).
 *
 * Two halves, the shape `CLAUDE.md` prescribes for every file-parsing guard
 * here: the parser is exercised on **synthetic** input so it can be shown to
 * fail, and one test reads the real files. The synthetic half is the part that
 * matters — this guard is the compensating control for a demoted SAST rule, so
 * a version of it that cannot catch a dynamic pattern is worse than no guard,
 * because the demotion stays.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  isTestFile,
  regexpSiteKey,
  scanRegExpSites,
} from "./regexp-source-hygiene";

describe("scanRegExpSites — what counts as a construction", () => {
  it("finds nothing in a file with no dynamic construction", () => {
    const src = `const RE = /^[a-z]+$/;\nexport const ok = RE.test("x");\n`;
    expect(scanRegExpSites("src/lib/a.ts", src)).toEqual([]);
  });

  it("does not read `new RegExp` out of a comment", () => {
    // This repo has been bitten twice by a tool reading prose as code, which is
    // why `source-text.ts` exists — and FOUR files here carry a comment
    // explaining why they avoid `new RegExp`. A guard that counted those would
    // report the files that got it right as the offenders.
    const src = `// A plain check rather than new RegExp(name): SAST flags it.\n/* new RegExp(other) */\nconst x = 1;\n`;
    expect(scanRegExpSites("src/lib/a.ts", src)).toEqual([]);
  });

  it("does not mistake a string containing the words for a call", () => {
    const src = `expect(source).not.toContain("new RegExp");\n`;
    expect(scanRegExpSites("src/lib/a.test.ts", src)).toEqual([]);
  });
});

describe("scanRegExpSites — the verdicts", () => {
  const verdict = (src: string, file = "src/lib/a.ts") =>
    scanRegExpSites(file, src)[0]?.verdict;

  it("a template with no interpolation is a literal", () => {
    expect(verdict('const r = new RegExp("^[a-z]+$");')).toBe("literal");
    expect(verdict("const r = new RegExp(`^[a-z]+$`);")).toBe("literal");
  });

  it("interpolating only SCREAMING_CASE module constants is constant", () => {
    expect(
      verdict(
        [
          "const SHORT_SHA_LENGTH = 7;",
          "const r = new RegExp(`^[0-9a-f]{${SHORT_SHA_LENGTH},40}$`);",
        ].join("\n"),
      ),
    ).toBe("constant");
    expect(
      verdict(
        [
          "const IDENT = '\"?([A-Za-z_]+)\"?';",
          "const r = new RegExp(`\\\\bALTER\\\\s+TABLE\\\\s+${IDENT}`, 'i');",
        ].join("\n"),
      ),
    ).toBe("constant");
  });

  it("interpolating through escapeForRegExp is escaped", () => {
    expect(
      verdict("const r = new RegExp(`^${escapeForRegExp(key)}:(.*)$`);"),
    ).toBe("escaped");
  });

  it("mixing constants and escaped values is still safe", () => {
    expect(
      verdict(
        [
          'const COMMAND_BOUNDARY = "[^&|;]";',
          "const r = new RegExp(`rm -rf${COMMAND_BOUNDARY}*${escapeForRegExp(path)}`);",
        ].join("\n"),
      ),
    ).toBe("escaped");
  });

  it("a bare identifier is unreviewed — this is the case that must be caught", () => {
    expect(verdict("const r = new RegExp(line);")).toBe("unreviewed");
    expect(verdict("const r = new RegExp(`\\\\b${constraint}\\\\b`);")).toBe(
      "unreviewed",
    );
    expect(verdict("const r = new RegExp(`(?:${models.join('|')})`);")).toBe(
      "unreviewed",
    );
  });

  it("a lower-case identifier is NOT treated as a module constant", () => {
    // The whole gate rests on this distinction. A rule that accepted any
    // identifier would pass every site in the tree and assert nothing.
    expect(verdict("const r = new RegExp(`^${prefix}$`);")).toBe("unreviewed");
  });

  /**
   * Adversarial review of !293's sibling MR. Seven of ten constructions written
   * to defeat this guard passed it green, and these are the four that mattered.
   * Each is the ordinary way somebody would actually write the unsafe thing.
   */
  describe("the ways a dynamic pattern used to slip through", () => {
    it("does not call string concatenation a literal", () => {
      // The commonest way to build a dynamic regex in JS, and precisely what
      // CWE-185 is about. It began with a quote and contained no `${`, so the
      // interpolation count was zero and it was classified `literal`.
      expect(
        verdict('const r = new RegExp("^" + userPrefix + "[a-f]+$");'),
      ).toBe("unreviewed");
      expect(verdict('const r = new RegExp("^".concat(userPrefix));')).toBe(
        "unreviewed",
      );
    });

    it("does not let anything ride along after an escapeForRegExp call", () => {
      // The check was a PREFIX test, so everything after the escaped value was
      // unexamined — including a raw concatenation and a ternary that returns
      // the unescaped branch.
      expect(
        verdict("const r = new RegExp(`${escapeForRegExp(a) + raw}`);"),
      ).toBe("unreviewed");
      expect(
        verdict("const r = new RegExp(`${escapeForRegExp(a) ? raw : other}`);"),
      ).toBe("unreviewed");
      // The genuine single call still passes, or the fix would be a ban.
      expect(verdict("const r = new RegExp(`^${escapeForRegExp(a)}$`);")).toBe(
        "escaped",
      );
    });

    it("counts an interpolation preceded by an escaped backslash", () => {
      // `\\b` and `\\s+` are everywhere in this repo's patterns, so an
      // interpolation after one is not exotic. The skip tested a single
      // preceding character, so an escaped backslash hid the `${`.
      expect(verdict("const r = new RegExp(`a\\\\${attacker}b`);")).toBe(
        "unreviewed",
      );
      // A genuinely escaped `\${` is not an interpolation and must stay literal.
      expect(verdict("const r = new RegExp(`a\\${notAnInterp}b`);")).toBe(
        "literal",
      );
    });

    it("does not accept a SCREAMING_CASE name that is not a file-level const", () => {
      // The test was the identifier's SHAPE. A parameter, a reassignable `let`,
      // and a constant read out of the environment or a request body all match
      // it — and the last two are attacker-reachable by definition.
      const asParam = `function f(PREFIX: string) { return new RegExp(\`^\${PREFIX}$\`); }`;
      expect(verdict(asParam)).toBe("unreviewed");
      const fromEnv = [
        "const BASE = process.env.BASE ?? '';",
        "const r = new RegExp(`^${BASE}$`);",
      ].join("\n");
      expect(verdict(fromEnv)).toBe("unreviewed");
      // A real file-level literal constant still passes.
      const real = [
        "const PREFIX = '[a-f0-9]';",
        "const r = new RegExp(`^${PREFIX}+$`);",
      ].join("\n");
      expect(verdict(real)).toBe("constant");
    });
  });

  it("classifies a construction inside a test file as test-only", () => {
    expect(verdict("const r = new RegExp(label);", "src/lib/a.test.ts")).toBe(
      "test-only",
    );
    expect(
      verdict("const r = new RegExp(label);", "src/lib/__tests__/b.test.ts"),
    ).toBe("test-only");
    // Playwright specs too — the rule fires in `e2e/` and the guard has to see
    // the same files it does.
    expect(
      verdict("const r = new RegExp(id);", "e2e/smoke/settings.spec.ts"),
    ).toBe("test-only");
  });

  it("spans a call broken across lines, which is how Prettier leaves them", () => {
    const src = [
      "const r = new RegExp(",
      '  `\\\\bDROP\\\\s+CONSTRAINT\\\\s+"?${constraint}"?`,',
      '  "gi",',
      ");",
    ].join("\n");
    expect(verdict(src)).toBe("unreviewed");
  });
});

describe("isTestFile", () => {
  it("covers all three shapes of test file in this repo, and nothing else", () => {
    expect(isTestFile("src/lib/a.test.ts")).toBe(true);
    expect(isTestFile("src/components/x/y.test.tsx")).toBe(true);
    expect(isTestFile("src/lib/__tests__/scoping.harness.test.ts")).toBe(true);
    expect(isTestFile("e2e/smoke/settings-disclosure.spec.ts")).toBe(true);
    // The distinction the whole `test-only` verdict rests on. A production file
    // misread as a test would be exempted from the one check that makes the
    // SAST demotion defensible.
    expect(isTestFile("src/lib/workspace.ts")).toBe(false);
    expect(isTestFile("src/lib/version-hygiene.ts")).toBe(false);
    expect(isTestFile("src/lib/latest.ts")).toBe(false);
  });
});

describe("regexpSiteKey", () => {
  it("is file plus argument, and nothing else", () => {
    expect(regexpSiteKey("src/lib/a.ts", "`^${X}$`")).toBe(
      "src/lib/a.ts::`^${X}$`",
    );
  });

  it("carries no line number, so a shifted line is the same site", () => {
    // The entire point of #234. Semgrep re-fingerprints on location, so a
    // finding already dismissed comes back as new when an unrelated edit moves
    // it. A key that moved with the line would make this guard's allowlist
    // rot the same way.
    const a = scanRegExpSites("src/lib/a.ts", "const r = new RegExp(x);");
    const b = scanRegExpSites(
      "src/lib/a.ts",
      "\n\n// something added above\nconst r = new RegExp(x);",
    );
    expect(a[0].key).toBe(b[0].key);
    expect(a[0].key).not.toMatch(/\d+$/);
  });
});

// ── The real tree ────────────────────────────────────────────────────────────

/**
 * Dynamic patterns in PRODUCTION code that have been read and accepted, each
 * with the argument for why the interpolated value cannot carry attacker input.
 *
 * Mirrors `REVIEWED_DYNAMIC_HOSTS` in `fetch-host-hygiene.test.ts`, deliberately:
 * that map is the model for "a demotion plus a guard plus a place where an
 * exception must be argued in review". Adding an entry here is the moment to
 * make that argument.
 *
 * Keyed WITHOUT line numbers, so an unrelated edit above one of these does not
 * silently drop it out of the allowlist — which is the exact failure mode #234
 * exists to remove.
 */
const REVIEWED_DYNAMIC_PATTERNS: Record<
  string,
  { count: number; reason: string }
> = {
  [`src/lib/migration-data-harness.ts::\`\\\\bDROP\\\\s+CONSTRAINT\\\\s+(?:IF\\\\s+EXISTS\\\\s+)?"?\${constraint}"?\``]:
    {
      count: 1,
      reason:
        "`constraint` is a Postgres identifier read out of this repo's own migration SQL under prisma/migrations, at test time. It never comes from a request, and a migration file is a reviewed artefact that a human wrote.",
    },
  [`src/lib/migration-data-harness.ts::\`\\\\bUPDATE\\\\s+"?\${table}"?\\\\b[^;]*?\\\\bSET\\\\b[^;]*?"?\${column}"?\\\\s*=\``]:
    {
      count: 1,
      reason:
        "`table` and `column` are Postgres identifiers from this repo's own migration SQL, evaluated at test time. Same argument as the DROP CONSTRAINT pattern above: no request can reach them.",
    },
};

/** Every `.ts`/`.tsx` under a root, excluding build output. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(root);
  return out;
}

describe("the real tree", () => {
  const repo = process.cwd();
  // Both roots the rule actually reports on. `e2e/` is not an afterthought:
  // Semgrep raised two findings in `e2e/smoke/settings-disclosure.spec.ts`, and
  // a scan that skipped the directory would report a clean tree while the rule
  // it compensates for kept firing there.
  const sites = ["src", "e2e"]
    .flatMap((root) => sourceFiles(join(repo, root)))
    .flatMap((file) =>
      scanRegExpSites(relative(repo, file), readFileSync(file, "utf8")),
    );

  it("finds the constructions that are actually there", () => {
    // The anti-vacuity assertion, and it is the one that makes every zero below
    // mean something. A scan that silently matched nothing would satisfy the
    // gate while asserting nothing at all — the failure shape this project has
    // recorded seven times.
    // EXACT, not a floor. It was `>= 15` against 25 real sites, which left the
    // guard free to lose 40% of its coverage and stay green — a floor is not a
    // control when the thing being guarded against is silently seeing less
    // (!319 review). Update this deliberately when a construction is added or
    // removed; that is the point.
    expect(sites.length).toBe(25);
    expect(sites.some((s) => s.verdict === "constant")).toBe(true);
    expect(sites.some((s) => s.verdict === "escaped")).toBe(true);
    expect(sites.some((s) => s.verdict === "test-only")).toBe(true);
  });

  it("no production construction builds a pattern from an unreviewed value", () => {
    const offenders = sites
      .filter((s) => s.verdict === "unreviewed")
      .filter((s) => !REVIEWED_DYNAMIC_PATTERNS[s.key]);
    expect(
      offenders.map((s) => s.key),
      "Add an entry to REVIEWED_DYNAMIC_PATTERNS with the argument for why this value cannot carry attacker input, or build the pattern from a module constant / escapeForRegExp instead.",
    ).toEqual([]);
  });

  /**
   * !319 review. A key is `file::argument`, so N byte-identical constructions
   * in one file collapse to ONE entry — and a second, unreviewed copy would
   * ride in free on the first one's reviewed reason. Demonstrated at the time
   * by appending a duplicate `DROP CONSTRAINT` construction to
   * `migration-data-harness.ts`: the guard stayed green.
   *
   * So each entry states how many sites it covers, and a new duplicate has to
   * be counted in deliberately.
   */
  it("an allowlist entry covers only as many sites as it says it does", () => {
    for (const [key, { count }] of Object.entries(REVIEWED_DYNAMIC_PATTERNS)) {
      const actual = sites.filter((s) => s.key === key).length;
      expect(actual, `${key} is allowed ${count} time(s)`).toBe(count);
    }
  });

  /**
   * The guard must see every file the demoted rule sees. This is the assertion
   * that makes the demotion honest, and it is not hypothetical: the first
   * version of the scanner silently skipped FOUR of these nine, because a regex
   * literal containing a quote (`/^(["'])(.*?)\\1/` in `version-hygiene.ts`)
   * desynchronised its quote tracking and everything below it read as string
   * content. It reported those files clean while Semgrep kept firing on them.
   *
   * The list is the real per-file breakdown of `eslint.detect-non-literal-regexp`
   * on `main`'s pipeline for `57a272a`, measured 2026-08-10 — 15 findings across
   * nine files.
   */
  it("sees every file the demoted SAST rule reports on", () => {
    const REPORTED_BY_SEMGREP = [
      "src/lib/__tests__/scoping.harness.test.ts",
      "src/lib/registry-prune.test.ts",
      "e2e/smoke/settings-disclosure.spec.ts",
      "src/lib/migration-data-harness.ts",
      "src/lib/dockerfile-hygiene.test.ts",
      "src/lib/git-env.test.ts",
      "src/lib/version-hygiene.ts",
      "src/lib/dockerfile-hygiene.ts",
      "src/components/dashboard/badge-grid.test.tsx",
    ];
    const scanned = new Set(sites.map((s) => s.file));
    expect(
      REPORTED_BY_SEMGREP.filter((f) => !scanned.has(f)),
      "the guard is blind to a file the rule it compensates for reports on",
    ).toEqual([]);

    // Presence is too weak on its own: `migration-data-harness.ts` carries 8
    // sites and would satisfy "seen" with 1. These are Semgrep's own per-file
    // counts for the nine files, and the guard must see at least as many.
    const SEMGREP_PER_FILE: Record<string, number> = {
      "src/lib/__tests__/scoping.harness.test.ts": 3,
      "src/lib/registry-prune.test.ts": 3,
      "e2e/smoke/settings-disclosure.spec.ts": 2,
      "src/lib/migration-data-harness.ts": 2,
      "src/lib/dockerfile-hygiene.test.ts": 1,
      "src/lib/git-env.test.ts": 1,
      "src/lib/version-hygiene.ts": 1,
      "src/lib/dockerfile-hygiene.ts": 2,
      "src/components/dashboard/badge-grid.test.tsx": 1,
    };
    for (const [file, atLeast] of Object.entries(SEMGREP_PER_FILE)) {
      const seen = sites.filter((s) => s.file === file).length;
      expect(
        seen,
        `${file}: Semgrep reports ${atLeast}`,
      ).toBeGreaterThanOrEqual(atLeast);
    }
  });

  it("every REVIEWED_DYNAMIC_PATTERNS entry is live and carries a real reason", () => {
    // A stale allowlist is worse than none: it reads as review that happened
    // and is describing code that no longer exists.
    const keys = new Set(sites.map((s) => s.key));
    for (const [key, { reason }] of Object.entries(REVIEWED_DYNAMIC_PATTERNS)) {
      expect(keys.has(key), `${key} is no longer in the tree`).toBe(true);
      expect(reason.length, `${key} needs a real argument`).toBeGreaterThan(60);
    }
  });
});
