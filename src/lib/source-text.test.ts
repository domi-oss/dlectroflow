import { describe, it, expect } from "vitest";
import { stripComments, stripShellComments } from "./source-text";

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
