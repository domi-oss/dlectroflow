import { describe, it, expect } from "vitest";
import { stripComments } from "./source-text";

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
