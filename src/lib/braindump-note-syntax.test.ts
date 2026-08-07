import { describe, it, expect } from "vitest";
import { splitInlineNote } from "@/lib/braindump-note-syntax";
import { TASK_NOTE_MAX_LENGTH, normalizeTaskNote } from "@/lib/task-notes";

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
        splitInlineNote(
          "water the office plants {can under sink needs a wash}",
        ),
      ).toEqual({
        text: "water the office plants",
        note: "can under sink needs a wash",
      });
    });

    it("trims whitespace on BOTH sides of both halves", () => {
      expect(
        splitInlineNote("  water the plants   {  can under sink  }  "),
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

    /**
     * The invariant the module's own doc comment promises: **the emitted `text`
     * never re-splits.** Stated as a loop over every shape above rather than as
     * one example, because the failure it guards is silent and the single-group
     * example cannot reach it.
     *
     * Why it is load-bearing rather than tidy: the edit affordance pre-fills the
     * input with the STORED text, so "the user typed this fresh" and "this is
     * what we saved last time" arrive at `renameItem` as the same string. A
     * parser that splits its own output therefore erodes an item's text — and
     * OVERWRITES the note it already had — every time somebody opens the edit
     * field and saves without changing the trailing group.
     */
    const EVERY_SHAPE = [
      "water the office plants {can under sink needs a wash}",
      "fix the {foo} handler",
      "rename {old} to {new}.",
      "ship it {check {staging} first}",
      "deploy the {{VERSION}} chart {check values.yaml}",
      "fix {foo} {bar}",
      "update {config} {see the wiki}",
      "a} b {note}",
      "a} b} c}",
      "count the closing brace}",
      "water the plants {can under sink",
      "{just a note}",
      "explain the empty object {}",
      "buy milk",
      "",
    ];

    it.each(EVERY_SHAPE)("emits text that does not re-split: %j", (raw) => {
      const once = splitInlineNote(raw);
      expect(splitInlineNote(once.text)).toEqual({
        text: once.text,
        note: null,
      });
    });

    it("refuses rather than splitting when the residual text ends in a group", () => {
      // `fix {foo} {bar}` has a group at the very end, so the end-anchored rule
      // would fire — but the text it would leave behind (`fix {foo}`) ends in a
      // group of its own, so the split is not stable and the whole string stays
      // literal. Refusing is visible and costs a note; splitting is silent and
      // costs the text. #179 argues for the visible failure throughout.
      expect(splitInlineNote("fix {foo} {bar}")).toEqual({
        text: "fix {foo} {bar}",
        note: null,
      });
    });

    it("still splits when an earlier group is not at the end of the text", () => {
      // The refusal above must not swallow this: `{{VERSION}}` sits mid-text, so
      // the residual is stable and the trailing note is real.
      expect(
        splitInlineNote("deploy the {{VERSION}} chart {check values.yaml}"),
      ).toEqual({
        text: "deploy the {{VERSION}} chart",
        note: "check values.yaml",
      });
    });

    it("still splits when the residual ends in an UNMATCHED brace", () => {
      // The stability check asks "would this split again?", not "does it end in
      // `}`?". `a} b` ends in no group at all — its brace has no opener — so the
      // note is real and denying it would be over-strict.
      expect(splitInlineNote("a} b {note}")).toEqual({
        text: "a} b",
        note: "note",
      });
    });
  });

  /**
   * Astral-plane safety, which is a property of the SCAN rather than of taste.
   *
   * `matchingOpenBrace` walks UTF-16 code units and slices on the indices it
   * finds. That is only safe because `{` (U+007B) and `}` (U+007D) are BMP and a
   * surrogate half (U+D800–U+DFFF) can never compare equal to either — so a cut
   * point is always a whole code unit that is not part of a pair. The tests
   * below pin that reasoning, because the day somebody "optimises" this into an
   * offset arithmetic the symptom is a lone surrogate in the database and a
   * `char_length` budget that disagrees with the counter the user can see.
   */
  describe("astral-plane characters survive the scan", () => {
    /** A lone surrogate shows up as a single code point in the D800–DFFF block. */
    const loneSurrogates = (s: string) =>
      [...s].filter((c) => {
        const cp = c.codePointAt(0)!;
        return cp >= 0xd800 && cp <= 0xdfff;
      });

    it("splits around emoji on both sides of the braces", () => {
      const { text, note } = splitInlineNote(
        "pack the 🎒 {passport 🛂 and the tickets}",
      );
      expect(text).toBe("pack the 🎒");
      expect(note).toBe("passport 🛂 and the tickets");
      expect(loneSurrogates(text)).toEqual([]);
      expect(loneSurrogates(note!)).toEqual([]);
    });

    it("splits with an emoji flush against the opening brace", () => {
      // No separating space, so the character immediately before `{` is the low
      // half of a surrogate pair — the exact byte position a naive scan cuts.
      expect(splitInlineNote("🎒{passport}")).toEqual({
        text: "🎒",
        note: "passport",
      });
    });

    it("splits with an emoji flush against the closing brace", () => {
      expect(splitInlineNote("pack {🛂}")).toEqual({
        text: "pack",
        note: "🛂",
      });
    });

    it("handles a note made only of astral characters", () => {
      const { note } = splitInlineNote("pack {🛂🎒🧳}");
      expect(note).toBe("🛂🎒🧳");
      expect([...note!]).toHaveLength(3);
      expect(loneSurrogates(note!)).toEqual([]);
    });

    it("does not treat a surrogate half as a brace", () => {
      // A ZWJ sequence is several code points and eleven code units; none of them
      // may be mistaken for a delimiter.
      expect(splitInlineNote("call 👩‍👩‍👧‍👦 about the trip")).toEqual({
        text: "call 👩‍👩‍👧‍👦 about the trip",
        note: null,
      });
    });
  });

  /**
   * The 2000-code-point bound, exercised on the composed CAPTURE path.
   *
   * This module is deliberately syntax-only — the bound lives in exactly one
   * place, `normalizeTaskNote`, which is also what the DB CHECK
   * (`BrainDumpItem_notes_check`, `char_length` not `octet_length`) is asserted
   * against. Re-clamping here would be a second copy of the number, which is the
   * failure `task-notes.ts` was written to prevent.
   *
   * So what needs proving is not that the parser clamps, but that the parser
   * cannot hand `normalizeTaskNote` something it clamps WRONGLY — i.e. that the
   * two compose to a value the column will accept, counted in code points rather
   * than in bytes or UTF-16 units.
   */
  describe("the 2000-code-point bound, composed with normalizeTaskNote", () => {
    /** What capture and rename will do: split, then canonicalise the note. */
    const capture = (raw: string) => {
      const { text, note } = splitInlineNote(raw);
      return { text, note: normalizeTaskNote(note) };
    };

    const noteOf = (points: string, count: number) =>
      capture(`big paste {${points.repeat(count)}}`).note!;

    it("bound is 2000, so this file and the column cannot drift apart", () => {
      expect(TASK_NOTE_MAX_LENGTH).toBe(2000);
    });

    it("keeps a note one code point UNDER the bound intact", () => {
      expect([...noteOf("a", TASK_NOTE_MAX_LENGTH - 1)]).toHaveLength(1999);
    });

    it("keeps a note exactly AT the bound intact", () => {
      expect([...noteOf("a", TASK_NOTE_MAX_LENGTH)]).toHaveLength(2000);
    });

    it("clamps a note one code point OVER the bound", () => {
      expect([...noteOf("a", TASK_NOTE_MAX_LENGTH + 1)]).toHaveLength(2000);
    });

    it("counts CODE POINTS, not bytes — 2000 emoji are 8000 bytes and survive", () => {
      const note = noteOf("🛂", TASK_NOTE_MAX_LENGTH);
      expect([...note]).toHaveLength(2000);
      // An `octet_length`-style bound would have cut this to 500 emoji.
      expect(Buffer.byteLength(note, "utf8")).toBe(8000);
    });

    it("counts CODE POINTS, not UTF-16 units — 2000 emoji are 4000 units and survive", () => {
      const note = noteOf("🛂", TASK_NOTE_MAX_LENGTH);
      expect([...note]).toHaveLength(2000);
      // A `String.length` bound would have cut this to 1000 emoji.
      expect(note.length).toBe(4000);
    });

    it("clamps an over-long astral note without leaving a lone surrogate", () => {
      const note = noteOf("🛂", TASK_NOTE_MAX_LENGTH + 500);
      expect([...note]).toHaveLength(2000);
      expect(note.endsWith("🛂")).toBe(true);
      // A `slice(0, 2000)` on code units would end on half a pair.
      expect(note).not.toMatch(/[\ud800-\udbff]$/);
    });

    it("leaves the ITEM TEXT unbounded by this rule — it is a title, not a note", () => {
      // The bound belongs to the note column. A very long capture with no group
      // is still one long text, and it must not be silently truncated here.
      const long = "z".repeat(5000);
      expect(capture(long)).toEqual({ text: long, note: null });
    });
  });

  /**
   * The parser must not defeat the escaping the ICS and Google Tasks paths rely
   * on (`esc()` in src/lib/ics.ts, tightened for every line terminator during
   * the #154 review that shipped as !258).
   *
   * The only way a pure splitter can break a downstream escaper is by escaping
   * or unescaping something itself — a value that arrives pre-escaped gets
   * double-escaped by `esc`, and a value this module "helpfully" unescaped would
   * arrive at the serialiser as the attack it was. So the contract is verbatim
   * pass-through, asserted rather than assumed.
   */
  describe("does not interfere with the !258 escaping path", () => {
    it("passes RFC 5545 special characters through verbatim", () => {
      // `;` `,` and `\` are the three `esc()` escapes. None may be touched here.
      expect(splitInlineNote("book it {row 3; seat 4, aisle \\ side}")).toEqual(
        {
          text: "book it",
          note: "row 3; seat 4, aisle \\ side",
        },
      );
    });

    it("does not swallow a forged calendar property — it hands it on intact", () => {
      // The parser's job is to find the note, not to sanitise it. It must
      // neither drop this nor pre-escape it, or the layer that CAN reason about
      // RFC 5545 would see something other than what arrived.
      const { note } = splitInlineNote(
        "ring the dentist {09:00\r\nSUMMARY:forged}",
      );
      expect(note).toBe("09:00\r\nSUMMARY:forged");
    });

    it("the composed capture path folds the CR before it can end a content line", () => {
      // `normalizeTaskNote` collapses CRLF to a single LF, and `esc()` then
      // renders that LF as the literal two-character `\n` escape. The property
      // cannot be forged at either layer.
      const { note } = splitInlineNote(
        "ring the dentist {09:00\r\nSUMMARY:forged}",
      );
      expect(normalizeTaskNote(note)).toBe("09:00\nSUMMARY:forged");
    });

    it("strips C0 controls on the composed path, leaving nothing for esc to drop", () => {
      const { note } = splitInlineNote(
        "ring the dentist {09:00\x00\x07 sharp}",
      );
      expect(normalizeTaskNote(note)).toBe("09:00 sharp");
    });
  });
});
