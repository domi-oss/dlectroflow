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
   * First adversarial round on !319. Seven of ten constructions written to defeat
   * this guard passed it green, and these are the four that mattered. Each is the
   * ordinary way somebody would actually write the unsafe thing.
   *
   * (This block cited `!293` until the second round; that is an unrelated MR
   * about production alerting, and a cross-reference nobody can follow is worse
   * than none.)
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

    it("does not accept a const declared only inside a fixture string", () => {
      // Second !319 round. The check was a raw line scan over the whole file, so
      // a declaration written inside a template-literal FIXTURE vouched for a
      // name it never bound — and this repo's hygiene tests are made of source
      // fixtures, which makes the shape ordinary rather than exotic. Fails OPEN,
      // which is why it is here rather than in a docblock.
      const src = [
        "const FIXTURE = `",
        'const PREFIX = "safe";',
        "`;",
        "function f(PREFIX: string) { return new RegExp(`^${PREFIX}$`); }",
      ].join("\n");
      expect(verdict(src)).toBe("unreviewed");
    });

    it("does not accept a block-scoped const as a file-level one", () => {
      // The line scan trimmed, so an indented `const` inside a function body
      // satisfied a check whose whole claim is "file-level".
      const src = [
        "function g() {",
        '  const PREFIX = "safe";',
        "  return PREFIX;",
        "}",
        "function f(PREFIX: string) { return new RegExp(`^${PREFIX}$`); }",
      ].join("\n");
      expect(verdict(src)).toBe("unreviewed");
    });
  });

  it("accepts an EXPORTED file-level literal constant", () => {
    // `export const NAME = …` is a file-level const, and the check only matched
    // a bare `const`. So every exported SCREAMING_CASE literal in the repo —
    // there are dozens — was rejected, with a failure message telling the reader
    // to build the pattern from a module constant, which is what they had done
    // (!319 review).
    expect(
      verdict(
        [
          'export const PREFIX = "[a-f0-9]";',
          "const r = new RegExp(`^${PREFIX}+$`);",
        ].join("\n"),
      ),
    ).toBe("constant");
  });

  it("treats a regex-literal argument as literal, but not one used as a value", () => {
    // `new RegExp(/re/, "gi")` is the idiom for re-flagging a written-out
    // pattern; it is as literal as a string and was reported `unreviewed`.
    expect(verdict('const r = new RegExp(/^[a-z]+$/, "gi");')).toBe("literal");
    // What must not ride in on that: this starts with a `/` too.
    expect(verdict("const r = new RegExp(/^a/.source + raw);")).toBe(
      "unreviewed",
    );
  });

  it("counts only the parens that are code inside an escapeForRegExp call", () => {
    // Duo raised exactly this on !319 — "string literals passed to
    // escapeForRegExp could themselves contain parens" — and the first fix
    // closed the open half and left this one. A `)` inside the escaped value's
    // own string ended the call early, so a genuine single call read as
    // unreviewed.
    expect(verdict('const r = new RegExp(`^${escapeForRegExp(")")}$`);')).toBe(
      "escaped",
    );
    // …and the shape that must not pass still does not.
    expect(
      verdict('const r = new RegExp(`^${escapeForRegExp(")") + raw}$`);'),
    ).toBe("unreviewed");
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

/**
 * !319 review, second round. One invariant, and it is the tokeniser's whole
 * remaining weakness in `.tsx`: **a construct that does not terminate on its own
 * line was never that construct.** Neither a regex literal nor a `'`/`"` string
 * can contain a raw newline, so treating an unterminated one as open and running
 * the skip to the end of the line made the scanner blind to everything after it
 * on that line. For a compensating control that is the worst failure available,
 * because the SAST demotion stays whether the guard looks or not — the same
 * fault as the four files the first version missed, in a different disguise.
 */
describe("codeMask — an unterminated single-line construct was never one", () => {
  it("sees a construction after a JSX closing tag on the same line", () => {
    // `</span>`'s `/` follows a `<`, which is a position where a regex may
    // legally open — so the skip ran to the newline and swallowed the rest.
    const src = [
      "export function C({ attacker }: { attacker: string }) {",
      "  const label = <span>hi</span>; const r = new RegExp(attacker);",
      "  return label && r;",
      "}",
    ].join("\n");
    expect(scanRegExpSites("src/components/x/c.tsx", src)).toHaveLength(1);
  });

  it("sees a construction after an apostrophe in JSX text on the same line", () => {
    // The `'` in ordinary prose read as a string opener. JSX text is not
    // JavaScript, so no tokeniser can know it is in text — but it can know that
    // a string which never closes on its line is not a string.
    const src = [
      "export function C({ attacker }: { attacker: string }) {",
      "  const label = <p>don't</p>; const r = new RegExp(attacker);",
      "  return label && r;",
      "}",
    ].join("\n");
    expect(scanRegExpSites("src/components/x/c.tsx", src)).toHaveLength(1);
  });

  it("still treats a real regex literal and a real string as non-code", () => {
    // The other direction, and the reason the fix is "unterminated" rather than
    // "stop skipping": a terminated construct must stay invisible.
    expect(
      scanRegExpSites("src/lib/a.ts", "const re = /new RegExp\\(x\\)/;"),
    ).toEqual([]);
    expect(
      scanRegExpSites("src/lib/a.ts", 'const s = "new RegExp(x)";'),
    ).toEqual([]);
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

  it("survives a re-wrap, which is the whole re-fingerprint claim", () => {
    // A repo-wide reformat is the documented way triaged SAST findings come back
    // as new (`CLAUDE.md`), and this MR's argument is that the guard cannot do
    // that. Line-independence is not enough on its own — the key embeds the
    // argument's TEXT, so Prettier re-wrapping a long call must still produce the
    // same key. Whitespace runs are collapsed for exactly this reason.
    const oneLine = 'const r = new RegExp(`^${A}\\\\s+b$`, "i");';
    const wrapped = [
      "const r = new RegExp(",
      "  `^${A}\\\\s+b$`,",
      '  "i",',
      ");",
    ].join("\n");
    const [a] = scanRegExpSites("src/lib/a.ts", oneLine);
    const [b] = scanRegExpSites("src/lib/a.ts", wrapped);
    expect(b.key).toBe(a.key);
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
  "src/lib/renovate-hygiene.ts::source": {
    count: 1,
    reason:
      "`source` is the inside of a `matchMessage` read out of .gitlab/renovate.json — a versioned, reviewed config file — and it is compiled only by renovate-hygiene.test.ts, which is the module's sole caller. Nothing at runtime reaches this function: it ships in src/lib/ because that is where this repo keeps the pure half of every file-parsing guard, not because a request path uses it. The construction is deliberately a compile of a config value rather than a module constant, because the guard's whole job is to evaluate whatever pattern the config actually carries the way Renovate would (#243); a literal here would only prove the file contains a string somebody typed. An uncompilable pattern is caught and reported by unevaluatableMatchMessages rather than thrown, and the colocated test asserts that list is empty.",
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
    // EXACT, not a floor. It was `>= 15` against 25 real sites at the time, which left the
    // guard free to lose 40% of its coverage and stay green — a floor is not a
    // control when the thing being guarded against is silently seeing less
    // (!319 review). Update this deliberately when a construction is added or
    // removed; that is the point.
    //
    // Which means an unrelated MR that adds a `new RegExp` anywhere in `src/` or
    // `e2e/` fails HERE, in a file it never touched. That is not theoretical: it
    // went 25 → 28 on the rebase onto `973919f`, and **the delta was not the +1
    // predicted**. `!306` (#225) was expected to add one and its merged form adds
    // none; `!318` (#200) added three to `legal-footer.test.tsx` instead — the
    // very three findings this MR cites as the footer's. Re-count, never assume a
    // delta. The message below is what turns the failure from a puzzle into a
    // one-line fix, so keep it attached to the assertion.
    //
    // 28 → 29 on #233: `FROM_OR_JOIN_TABLE` in `migration-data-harness.ts`, which
    // classifies as `constant` like every other pattern in that module — its source
    // is assembled once at module load from the file-level `IDENT` literal and
    // nothing a caller passes ever reaches it. Taken from the scanner's OWN recount
    // rather than from 28 + 1, which is what this comment asks for.
    expect(
      sites.length,
      "A `new RegExp` was added to or removed from src/ or e2e/. That is fine — " +
        "re-count and bump this number to match, and do not assume the delta " +
        "(it was +3 on the last rebase, from a file nobody expected). It is " +
        "exact on purpose: a floor would let the scanner silently go blind and " +
        "stay green. If the count went DOWN and you did not delete a " +
        "construction, the tokeniser has stopped seeing one, which is the bug " +
        "this guard exists to prevent.",
    ).toBe(29);
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
   * version of the scanner silently skipped FOUR of these, because a regex
   * literal containing a quote (`/^(["'])(.*?)\\1/` in `version-hygiene.ts`)
   * desynchronised its quote tracking and everything below it read as string
   * content. It reported those files clean while Semgrep kept firing on them.
   *
   * The list is the real per-file breakdown of `eslint.detect-non-literal-regexp`
   * on `main`'s pipeline `2700` (`da32bf9`), measured 2026-08-11 — **18 findings
   * across ten files**, and it reads `success`, which matters because the
   * scan-result policy needs a FINISHED baseline to diff against. `d768832` is the
   * current merge base and its own run was still going, so the newest finished one
   * is cited deliberately rather than the newest one.
   *
   * Re-measured on `2700` and identical to the previous reading, file for file.
   * `!325`, `!327` and `!328` between them add no `new RegExp` to `src/` or `e2e/`,
   * which is why it held — checked each time, never assumed.
   *
   * **This snapshot rots, and it rotted inside a day.** Measured first on
   * `57a272a` it was 15 across nine; the rebase onto `973919f` added
   * `legal-footer.test.tsx` (3, from `!318`) and dropped `dockerfile-hygiene.ts`
   * from 2 to 1. Re-measure it when this test fails rather than deleting the
   * entry that no longer matches — a per-file count going DOWN is Semgrep
   * changing its mind, which is fine; the guard seeing fewer is not, and that is
   * what the exact total above catches.
   */
  it("sees every file the demoted SAST rule reports on", () => {
    const REPORTED_BY_SEMGREP = [
      "src/components/legal/legal-footer.test.tsx",
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
    // counts for the ten files, and the guard must see at least as many.
    const SEMGREP_PER_FILE: Record<string, number> = {
      "src/components/legal/legal-footer.test.tsx": 3,
      "src/lib/__tests__/scoping.harness.test.ts": 3,
      "src/lib/registry-prune.test.ts": 3,
      "e2e/smoke/settings-disclosure.spec.ts": 2,
      "src/lib/migration-data-harness.ts": 2,
      "src/lib/dockerfile-hygiene.test.ts": 1,
      "src/lib/git-env.test.ts": 1,
      "src/lib/version-hygiene.ts": 1,
      "src/lib/dockerfile-hygiene.ts": 1,
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
