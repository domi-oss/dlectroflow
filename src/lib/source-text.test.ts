import { describe, it, expect } from "vitest";
import {
  stripComments,
  stripShellComments,
  stripYamlComment,
} from "./source-text";

// These three moved here verbatim from manifest-hygiene.test.ts when #150 gave
// `stripComments` a second caller and its own module. The rest were added at
// the same time: with two scanners depending on it, "what exactly does this
// keep?" stopped being one module's private business.
describe("stripComments", () => {
  it("drops a line comment", () => {
    expect(stripComments('// import x from "ghost";\nconst a = 1;')).toBe(
      "\nconst a = 1;",
    );
  });

  it("drops a block comment spanning several lines", () => {
    expect(
      stripComments('/*\n * import x from "ghost";\n */\nconst a = 1;'),
    ).toBe("\nconst a = 1;");
  });

  it("does not truncate a line at the // inside a URL", () => {
    const source = 'const u = "https://example.test/x";';
    expect(stripComments(source)).toBe(source);
  });

  it("keeps the code before a trailing line comment", () => {
    expect(stripComments("const a = 1; // and why")).toBe("const a = 1; ");
  });

  it("keeps the code either side of an inline block comment", () => {
    expect(stripComments("const a = /* two */ 2;")).toBe("const a =  2;");
  });

  it("drops each of several block comments rather than everything between them", () => {
    // A greedy `.*` would swallow `keep` along with both comments, which is the
    // whole reason the block pattern is lazy.
    expect(stripComments("/* a */ keep /* b */")).toBe(" keep ");
  });

  it("leaves comment-free source untouched", () => {
    const source = "const a = 1;\nconst b = 2;\n";
    expect(stripComments(source)).toBe(source);
  });

  it("returns an empty string for empty input", () => {
    expect(stripComments("")).toBe("");
  });

  // Known limitation, written down so it is a decision rather than a surprise:
  // this is text-level, not a parser, so a comment opener inside a string
  // literal still reads as a comment. It errs towards seeing LESS, which is the
  // direction every caller can afford — a missed occurrence costs nothing until
  // the construct appears in real code, while a phantom one fails CI on
  // something that does not exist.
  it("over-strips a comment opener that appears inside a string literal", () => {
    expect(stripComments('const s = "a /* b"; const t = "c */ d";')).toBe(
      'const s = "a  d";',
    );
  });
});

describe("stripShellComments", () => {
  it("drops a whole-line comment", () => {
    expect(stripShellComments('# DAYS="${DAYS:-7}"\nDAYS="${DAYS:-30}"')).toBe(
      '\nDAYS="${DAYS:-30}"',
    );
  });

  it("drops a trailing comment and keeps the code before it", () => {
    expect(stripShellComments("DAYS=30 # and why")).toBe("DAYS=30 ");
  });

  // GitLab Duo on !261, verified against bash before acting: whitespace is not
  // the only thing that starts a word. Each of these was measured — `printf X
  // |#c` runs the pipe and drops the comment, `(#c` opens a subshell and drops
  // the comment, and `printf Z >#f` makes bash report a syntax error because
  // the redirect has no target rather than writing a file called `#f`.
  it.each([
    [";", "cmd;# gone"],
    ["&", "cmd &# gone"],
    ["|", "cmd |# gone"],
    ["(", "(# gone"],
    [")", "cmd)# gone"],
    ["<", "cmd <# gone"],
    [">", "cmd ># gone"],
  ])("treats `#` after %s as the start of a comment", (_char, source) => {
    expect(stripShellComments(source)).not.toContain("gone");
  });

  it("does not let a comment after `;` hide a real later binding", () => {
    // The failure the operator set exists to prevent: a commented-out example
    // read as live code, which is the whole point of stripping in the first
    // place. Without `;` in the set this returns the 7.
    const source = ':;# DAYS="${DAYS:-7}"\nDAYS="${DAYS:-30}"';
    expect(stripShellComments(source)).not.toContain("7");
    expect(stripShellComments(source)).toContain("30");
  });

  it.each(["$", "{", "}", "=", "-", "a", "1", "_"])(
    "does not treat `#` after %s as a comment",
    (char) => {
      const source = `keep${char}#still-here`;
      expect(stripShellComments(source)).toBe(source);
    },
  );

  it("keeps a `#` that is parameter expansion, not a comment", () => {
    // `${sub#=}` appears in this repo's own scripts. Treating it as a comment
    // would truncate the line and lose everything after it.
    const source = 'sub="${sub#=}"; echo "$sub"';
    expect(stripShellComments(source)).toBe(source);
  });

  it("keeps a `#` inside single quotes", () => {
    const source = "FILTER='severity#ERROR'";
    expect(stripShellComments(source)).toBe(source);
  });

  it("keeps a `#` inside double quotes", () => {
    const source = 'MSG="see #157 for why"';
    expect(stripShellComments(source)).toBe(source);
  });

  it("keeps a `#` that begins a word inside a quoted string spanning lines", () => {
    // The reason quote state is tracked across the whole input rather than per
    // line: a heredoc-ish multi-line string is common in these scripts, and a
    // line-anchored scanner would start each line believing it is unquoted.
    const source = 'BODY="one\n# two\nthree"';
    expect(stripShellComments(source)).toBe(source);
  });

  it("leaves comment-free source untouched", () => {
    const source = 'set -euo pipefail\nDAYS="${DAYS:-30}"\n';
    expect(stripShellComments(source)).toBe(source);
  });

  it("returns an empty string for empty input", () => {
    expect(stripShellComments("")).toBe("");
  });

  it("is not confused by an apostrophe inside a comment", () => {
    // A comment is consumed whole, so its quote characters never reach the
    // quote tracker. `don't` in a header cannot silently quote the rest of the
    // file — which is the failure a naive "track quotes, then strip" order has.
    expect(stripShellComments("# don't do this\nDAYS=30 # kept")).toBe(
      "\nDAYS=30 ",
    );
  });

  it("over-strips after an unbalanced quote in code, losing text rather than inventing it", () => {
    // Known limitation, written down so it is a decision rather than a
    // surprise: an unterminated quote in real code leaves everything after it
    // looking quoted, so later comments survive. A caller then reads a value it
    // should have ignored — but that value came from the file, and every caller
    // here compares it against another surface, so the mismatch fails loudly.
    expect(stripShellComments('echo "oops\nDAYS=30 # kept')).toBe(
      'echo "oops\nDAYS=30 # kept',
    );
  });
});

// Arrived here in #226, unchanged, when `ci-job-deps` became the second reader of
// `.gitlab-ci.yml` needing it — the trigger this module's own doc names for a
// move. It was previously private to `ci-schedule-guards`, exercised only through
// `guardedFlags`; those tests still stand and pin that the move changed nothing,
// while these say what the function itself promises.
describe("stripYamlComment", () => {
  it("drops a trailing comment and keeps the value before it", () => {
    expect(stripYamlComment("    action: stop # and why")).toBe(
      "    action: stop ",
    );
  });

  it("drops a whole-line comment, indented or at column 0", () => {
    expect(stripYamlComment("# a header")).toBe("");
    expect(stripYamlComment("  # an indented note")).toBe("  ");
  });

  it("keeps a `#` that does not begin a word", () => {
    // YAML's rule, and narrower than shell's: `a#b` is the scalar `a#b`. A
    // branch name or an anchor carrying a `#` must survive intact.
    expect(stripYamlComment("ref: release#1")).toBe("ref: release#1");
  });

  it("keeps a `#` inside single quotes", () => {
    const line = "    - if: '$CI_COMMIT_TITLE =~ / #191/'";
    expect(stripYamlComment(line)).toBe(line);
  });

  it("keeps a `#` inside double quotes", () => {
    const line = '    - job: "build#1"';
    expect(stripYamlComment(line)).toBe(line);
  });

  it("leaves a comment-free line untouched", () => {
    expect(stripYamlComment("  needs: []")).toBe("  needs: []");
  });

  it("returns an empty string for empty input", () => {
    expect(stripYamlComment("")).toBe("");
  });

  // ── Why this is not `stripShellComments` ──────────────────────────────────
  // #226 asked whether one `#` stripper could serve both callers. These two
  // measure the answer rather than leaving it as an argument in a docblock: each
  // function is wrong in the other's language, so collapsing them would reopen a
  // shipped fix in one direction or the other.
  it("does not borrow shell's operator word-starts, which truncate a YAML scalar", () => {
    // `;` is in shell's measured word-start set (!261) and correctly so. In YAML
    // it is an ordinary scalar character, so shell's rule loses everything after
    // it — a value read as half of itself, silently.
    expect(stripYamlComment("ref: a;#b")).toBe("ref: a;#b");
    expect(stripShellComments("ref: a;#b")).toBe("ref: a;");
  });

  it("does not borrow shell's whole-input quote tracking, which would spread #226 file-wide", () => {
    // A YAML plain scalar may contain an apostrophe, and `.gitlab-ci.yml` is a
    // long file. Tracking quotes across the whole input leaves that apostrophe
    // open forever, so every comment BELOW it stops being stripped — which is
    // precisely #226's defect, no longer confined to one line. Per-line, the same
    // apostrophe costs only its own line.
    const yml = "name: Domi's review app\n    action: stop # kept";
    expect(yml.split("\n").map(stripYamlComment).join("\n")).toBe(
      "name: Domi's review app\n    action: stop ",
    );
    expect(stripShellComments(yml)).toBe(yml);
  });
});
