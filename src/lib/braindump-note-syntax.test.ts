import { describe, it, expect } from "vitest";
import { splitInlineNote } from "@/lib/braindump-note-syntax";

/**
 * #179 — the inline note syntax, exercised as a pure function.
 *
 * The parser has one job and a very large blast radius: it runs on EVERY
 * capture and every rename, and a false positive silently removes text the
 * person typed. So the cases below are weighted towards "must NOT fire" rather
 * than towards the happy path — the happy path has one shape and the refusals
 * have many.
 */
describe("splitInlineNote (#179)", () => {
  describe("a trailing brace group splits", () => {
    it("splits the issue's own example", () => {
      expect(
        splitInlineNote("water the office plants {can under sink needs a wash}"),
      ).toEqual({
        text: "water the office plants",
        note: "can under sink needs a wash",
      });
    });

    it("trims whitespace on BOTH sides of both halves", () => {
      expect(splitInlineNote("  water the plants   {  can under sink  }  ")
      ).toEqual({
        text: "water the plants",
        note: "can under sink",
      });
    });

    it("keeps braces that are nested INSIDE the trailing group", () => {
      // The group is found by matching depth, not by the first `{` seen, so a
      // note may itself contain a brace pair without being cut short.
      expect(splitInlineNote("ship it {check {staging} first}")).toEqual({
        text: "ship it",
        note: "check {staging} first",
      });
    });

    it("survives a mid-string brace group in front of a real trailing one", () => {
      // The case that decides between a backward depth-scan and a naive
      // "first `{`" search: a template placeholder EARLIER in the string must
      // stay in the text, not become the start of the note.
      expect(
        splitInlineNote("deploy the {{VERSION}} chart {check values.yaml}"),
      ).toEqual({
        text: "deploy the {{VERSION}} chart",
        note: "check values.yaml",
      });
    });

    it("preserves internal line breaks in the note", () => {
      expect(splitInlineNote("pack {passport\nchargers}")).toEqual({
        text: "pack",
        note: "passport\nchargers",
      });
    });

    it("does not require a space before the group", () => {
      expect(splitInlineNote("call Sam{before 5}")).toEqual({
        text: "call Sam",
        note: "before 5",
      });
    });
  });

  describe("a brace group anywhere else does NOT split", () => {
    it("leaves a mid-string group alone — the issue's counter-example", () => {
      expect(splitInlineNote("fix the {foo} handler")).toEqual({
        text: "fix the {foo} handler",
        note: null,
      });
    });

    it("leaves a group followed by punctuation alone", () => {
      // `}` is not the last character, so the strict rule does not fire. That
      // is the point: strictness is what makes an escape character unnecessary.
      expect(splitInlineNote("rename {old} to {new}.")).toEqual({
        text: "rename {old} to {new}.",
        note: null,
      });
    });

    it("leaves a bare placeholder mid-sentence alone", () => {
      expect(splitInlineNote("write the {TBD} section by Friday")).toEqual({
        text: "write the {TBD} section by Friday",
        note: null,
      });
    });
  });

  describe("unbalanced braces stay literal", () => {
    it("an unclosed group is literal — nothing ends the string", () => {
      expect(splitInlineNote("water the plants {can under sink")).toEqual({
        text: "water the plants {can under sink",
        note: null,
      });
    });

    it("a closing brace with no opener is literal", () => {
      expect(splitInlineNote("count the closing brace}")).toEqual({
        text: "count the closing brace}",
        note: null,
      });
    });

    it("a trailing `}` whose scan runs off the start is literal", () => {
      // Depth never returns to zero, so there is no group — the whole string
      // is text, braces included.
      expect(splitInlineNote("a} b} c}")).toEqual({
        text: "a} b} c}",
        note: null,
      });
    });
  });

  describe("an empty group yields no note, and stays literal", () => {
    it.each(["{}", "{ }", "{\n  \t }"])(
      "leaves %j in the text rather than eating it",
      (group) => {
        expect(splitInlineNote(`explain the empty object ${group}`)).toEqual({
          text: `explain the empty object ${group}`,
          note: null,
        });
      },
    );
  });

  describe("a group cannot consume the whole item", () => {
    it("refuses to split when nothing would be left as text", () => {
      // An item with no text is not an item — it would render as a blank row
      // whose only content is hidden behind a disclosure.
      expect(splitInlineNote("{just a note}")).toEqual({
        text: "{just a note}",
        note: null,
      });
    });

    it("refuses when only whitespace would be left as text", () => {
      expect(splitInlineNote("   {just a note}")).toEqual({
        text: "{just a note}",
        note: null,
      });
    });
  });

  describe("degenerate input", () => {
    it.each(["", "   ", "\n\t "])("returns empty text for %j", (raw) => {
      expect(splitInlineNote(raw)).toEqual({ text: "", note: null });
    });

    it("leaves a plain capture completely untouched", () => {
      expect(splitInlineNote("buy milk")).toEqual({
        text: "buy milk",
        note: null,
      });
    });
  });

  describe("idempotence", () => {
    it("re-parsing a split result is a no-op — the rename path re-runs this", () => {
      // `renameItem` re-parses on every edit (#179). If parsing the ALREADY
      // parsed text produced a second split, an item's text would erode one
      // brace group per edit.
      const once = splitInlineNote("water the plants {can under sink}");
      expect(splitInlineNote(once.text)).toEqual({
        text: "water the plants",
        note: null,
      });
    });
  });
});
