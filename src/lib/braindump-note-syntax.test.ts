import { describe, it, expect } from "vitest";
import {
  splitInlineNote,
  inlineNoteSource,
  inlineNoteInsertion,
  resolveInlineNoteEdit,
  type InlineNoteSplit,
} from "@/lib/braindump-note-syntax";
import { TASK_NOTE_MAX_LENGTH, normalizeTaskNote } from "@/lib/task-notes";

/**
 * Every shape the parser has an opinion about, in one list.
 *
 * Used by three different loops below, which is the point: the failures this
 * module can have are silent, and a property asserted over one example is a
 * property asserted over the one example that cannot reach the failure. That is
 * exactly how the erosion bug shipped — the colocated test had a single-group
 * happy path, and a single group cannot re-split.
 *
 * Module scope rather than inside a `describe` so the save-layer suite runs the
 * same shapes through the round trip that the parser suite runs through the
 * split.
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
];

/** True when every `{` in `s` closes, and no `}` arrives before its `{`. */
const balanced = (s: string) => {
  let depth = 0;
  for (const ch of s) {
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
};

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

  /**
   * Decision 1, read literally: **only a group at the very end counts.** Nothing
   * else. The rule people are told has one clause, and a parser that quietly
   * adds a second is a second rule nobody was told.
   *
   * An earlier version of this module carried that second clause — it refused a
   * split whose own output would split again, so `fix {foo} {bar}` stayed
   * entirely literal. The refusal was there to stop a real erosion bug on the
   * rename path, and #179 decided against paying for it in the syntax. The bug
   * is closed at the SAVE layer instead; see the `resolveInlineNoteEdit` suite
   * at the foot of this file for the loop that now cannot lose anything.
   */
  describe("only the LAST group counts — Decision 1, literally", () => {
    it("splits the trailing group and leaves an earlier one in the text", () => {
      expect(splitInlineNote("fix {foo} {bar}")).toEqual({
        text: "fix {foo}",
        note: "bar",
      });
    });

    it("does the same when both groups are words rather than placeholders", () => {
      expect(splitInlineNote("update {config} {see the wiki}")).toEqual({
        text: "update {config}",
        note: "see the wiki",
      });
    });

    it("emits text that CAN itself re-split, by decision rather than by accident", () => {
      // Pinned so nobody restores the refusal as a "fix". Re-parsing the emitted
      // text is exactly the thing the save layer is built never to do; a parser
      // that also refused it would cost a note in a shape people type, to
      // prevent something that is already impossible upstream.
      const once = splitInlineNote("fix {foo} {bar}");
      expect(once).toEqual({ text: "fix {foo}", note: "bar" });
      expect(splitInlineNote(once.text)).toEqual({ text: "fix", note: "foo" });
    });

    it("splits when an earlier group is not at the end of the text", () => {
      expect(
        splitInlineNote("deploy the {{VERSION}} chart {check values.yaml}"),
      ).toEqual({
        text: "deploy the {{VERSION}} chart",
        note: "check values.yaml",
      });
    });

    it("splits when the text left behind ends in an UNMATCHED brace", () => {
      // `a} b` has a `}` with no opener, which is literal text and not a group.
      // Nothing about the trailing note is affected by it.
      expect(splitInlineNote("a} b {note}")).toEqual({
        text: "a} b",
        note: "note",
      });
    });

    it("re-parsing a single-group result is still a no-op", () => {
      // The common case, and the one the old test used as its only example:
      // `water the plants` has no group of its own, so nothing re-splits. It is
      // kept because it is the shape almost every real capture has — just no
      // longer mistaken for a general property.
      const once = splitInlineNote("water the plants {can under sink}");
      expect(splitInlineNote(once.text)).toEqual({
        text: "water the plants",
        note: null,
      });
    });

    it("never emits a note whose braces are unbalanced", () => {
      // A property of the SCAN, and the one the save-layer reconstruction relies
      // on: `matchingOpenBrace` only returns a `{` at depth zero, so the region
      // between the two braces is a balanced string by construction. Asserted
      // over the awkward shapes as well as the ordinary ones, because it is what
      // makes `inlineNoteSource` able to put a note back where it came from.
      for (const raw of [...EVERY_SHAPE, "x {a}b}", "x {{a}b}", "x {a{b}"]) {
        const { note } = splitInlineNote(raw);
        if (note === null) continue;
        expect(balanced(note)).toBe(true);
      }
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

/**
 * The save layer (#179) — where the erosion is actually stopped.
 *
 * `splitInlineNote` is deliberately not idempotent: `fix {foo} {bar}` emits text
 * that would split again. That is harmless for a CAPTURE, which sees each string
 * once, and fatal for a RENAME, which re-parses whatever the edit input hands
 * back. So the round trip is closed by the two functions the rename path uses
 * together:
 *
 *   stored ──inlineNoteSource──▶ what the input holds ──resolveInlineNoteEdit──▶ stored
 *
 * Every test below is a face of one invariant: **going round that loop without
 * touching the input changes nothing** — not the text, not the note. That is a
 * property of the loop, so it is asserted over the whole shape table rather than
 * over the one example that motivated it.
 */
describe("the save layer (#179)", () => {
  /**
   * Stored pairs, including two this parser can never produce.
   *
   * The unbalanced-note rows (`a}b`) matter precisely because they are
   * unreachable through capture: they are what an IMPORT, a future note editor,
   * or a hand-written row could put in the column, and the loop has to be a
   * no-op for them too or the first save on such a row destroys it.
   */
  const STORED: InlineNoteSplit[] = [
    { text: "water the plants", note: null },
    { text: "water the plants", note: "can under sink" },
    { text: "fix {foo}", note: "bar" },
    { text: "update {config}", note: "see the wiki" },
    { text: "deploy the {{VERSION}} chart", note: "check values.yaml" },
    { text: "a} b", note: "note" },
    { text: "ship it", note: "check {staging} first" },
    { text: "count the closing brace}", note: null },
    { text: "fix", note: "a}b" },
    { text: "fix {foo}", note: "a}b" },
  ];

  describe("inlineNoteSource — one honest string for the input to hold", () => {
    it("is the text alone when there is no note", () => {
      expect(inlineNoteSource({ text: "buy milk", note: null })).toBe(
        "buy milk",
      );
    });

    it("reconstructs the string a capture would have been given", () => {
      expect(inlineNoteSource({ text: "fix {foo}", note: "bar" })).toBe(
        "fix {foo} {bar}",
      );
    });

    it.each(EVERY_SHAPE)(
      "round-trips whatever the parser stored for %j",
      (raw) => {
        const stored = splitInlineNote(raw);
        expect(splitInlineNote(inlineNoteSource(stored))).toEqual(stored);
      },
    );

    it("refuses to compose a note whose braces would not survive re-parsing", () => {
      // THE case that decided the design. A note carrying an unbalanced `}`
      // cannot be put back between braces: `fix {a}b}` has no `{` to match its
      // final `}`, the backward scan runs off the start, and the whole string is
      // literal — so an unchanged save would have replaced the text with that
      // junk AND dropped the note.
      expect(splitInlineNote("fix {a}b}")).toEqual({
        text: "fix {a}b}",
        note: null,
      });
      // Verified before it is offered, so the input holds the bare text instead
      // and the note stays in the column untouched.
      expect(inlineNoteSource({ text: "fix", note: "a}b" })).toBe("fix");
      expect(inlineNoteSource({ text: "fix {foo}", note: "a}b" })).toBe(
        "fix {foo}",
      );
    });
  });

  describe("an unchanged edit-and-save is a no-op", () => {
    it.each(STORED)("on both text and note, for %j", (stored) => {
      expect(resolveInlineNoteEdit(inlineNoteSource(stored), stored)).toEqual(
        stored,
      );
    });

    it.each(STORED)(
      "also when the input was pre-filled with the BARE text, for %j",
      (stored) => {
        // Belt as well as braces. The reconstruction is what the input should
        // hold, but a surface offering only the stored text — which is what
        // every edit affordance did before this — must not erode either, or the
        // fix depends on every future call site remembering.
        expect(resolveInlineNoteEdit(stored.text, stored)).toEqual(stored);
      },
    );

    it.each(STORED)("and stays a no-op over five saves, for %j", (stored) => {
      // Once is not the property. Erosion was one group per save, so a fix that
      // survived a single round trip and drifted on the second would look
      // identical in a one-shot test.
      let current = stored;
      for (let i = 0; i < 5; i++) {
        current = resolveInlineNoteEdit(inlineNoteSource(current), current);
      }
      expect(current).toEqual(stored);
    });

    it("closes the exact path that used to lose data", () => {
      // Capture `fix {foo} {bar}`, open the editor, save without typing.
      // Before: the input showed `fix {foo}`, the rename re-parsed it to text
      // `fix` + note `foo`, and `bar` was gone — repeatable until the text was
      // empty.
      const stored = splitInlineNote("fix {foo} {bar}");
      expect(stored).toEqual({ text: "fix {foo}", note: "bar" });
      expect(inlineNoteSource(stored)).toBe("fix {foo} {bar}");
      expect(resolveInlineNoteEdit("fix {foo} {bar}", stored)).toEqual(stored);
      expect(resolveInlineNoteEdit("fix {foo}", stored)).toEqual(stored);
    });
  });

  describe("a note is never replaced by text out of the text field", () => {
    it("keeps the note when only the text half is edited", () => {
      expect(
        resolveInlineNoteEdit("repair {foo} {bar}", {
          text: "fix {foo}",
          note: "bar",
        }),
      ).toEqual({ text: "repair {foo}", note: "bar" });
    });

    it("keeps the note when the edit leaves no trailing group at all", () => {
      expect(
        resolveInlineNoteEdit("water the plants today", {
          text: "water the plants",
          note: "can under sink",
        }),
      ).toEqual({ text: "water the plants today", note: "can under sink" });
    });

    it("keeps the note when a brace is mistyped", () => {
      // A dropped `}` must not read as "delete the note". Same refusal to guess
      // the parser makes about unbalanced braces, one layer up.
      expect(
        resolveInlineNoteEdit("water the plants {can under sink", {
          text: "water the plants",
          note: "can under sink",
        }),
      ).toEqual({
        text: "water the plants {can under sink",
        note: "can under sink",
      });
    });

    it("keeps a note the input could not show", () => {
      expect(
        resolveInlineNoteEdit("repair the parser", {
          text: "fix",
          note: "a}b",
        }),
      ).toEqual({ text: "repair the parser", note: "a}b" });
    });

    it("writes the note only when the submitted string ends in a real group", () => {
      expect(
        resolveInlineNoteEdit("fix {foo} {other}", {
          text: "fix {foo}",
          note: "bar",
        }),
      ).toEqual({ text: "fix {foo}", note: "other" });
    });

    it("adds a note to an item that had none", () => {
      expect(
        resolveInlineNoteEdit("buy milk {2 pints}", {
          text: "buy milk",
          note: null,
        }),
      ).toEqual({ text: "buy milk", note: "2 pints" });
    });

    it("treats an empty submission as no edit at all", () => {
      const stored: InlineNoteSplit = { text: "buy milk", note: "2 pints" };
      expect(resolveInlineNoteEdit("   ", stored)).toEqual(stored);
    });

    it("emptying the group does NOT delete the note — the one cost, stated", () => {
      // `{}` is not a note (the parser refuses it), so this arrives as "no
      // trailing group", and no group means the text field said nothing about
      // the note. Deleting a note therefore needs a note affordance rather than
      // the title field.
      //
      // Chosen deliberately over the alternative: clearing the note whenever the
      // group goes means a mistyped brace destroys it, and the note here is the
      // only copy. This way it is still in the column and reappears in the input
      // the next time the editor opens, which is visible and recoverable.
      expect(
        resolveInlineNoteEdit("buy milk {}", {
          text: "buy milk",
          note: "2 pints",
        }),
      ).toEqual({ text: "buy milk {}", note: "2 pints" });
    });
  });
});

/**
 * The "add note" affordance's one piece of syntax knowledge (#186).
 *
 * The button exists because `{` and `}` are two or three taps deep in a phone's
 * symbol keyboard, and because nothing on screen otherwise says the syntax
 * exists. It puts the braces in and the caret between them; everything about
 * WHERE that is lives here rather than in the component, so the caret and the
 * parser cannot disagree about where a note starts.
 *
 * The function reasons about BRACES; `splitInlineNote` decides whether those
 * braces are a note. That split matters for `buy milk {}` — an empty group is
 * not a note, but it is very much an existing trailing group, and appending a
 * second one to it is the failure this whole function exists to avoid.
 */
describe("inlineNoteInsertion (#186)", () => {
  describe("no trailing group — append one", () => {
    it("appends a space, the braces, and puts the caret between them", () => {
      expect(inlineNoteInsertion("buy milk")).toEqual({
        value: "buy milk {}",
        caret: 10,
      });
    });

    it("drops trailing whitespace rather than doubling the separator", () => {
      expect(inlineNoteInsertion("buy milk   ")).toEqual({
        value: "buy milk {}",
        caret: 10,
      });
    });

    it("adds no separator when there is nothing to separate from", () => {
      // Unreachable through the button, which is disabled on an empty field —
      // a note has to be a note ABOUT something. Defined anyway, because a
      // total function is one less thing for a caller to get wrong.
      expect(inlineNoteInsertion("")).toEqual({ value: "{}", caret: 1 });
    });

    it("appends when the only `}` has no opener", () => {
      // Not a group: `splitInlineNote` reads it as literal text, so the button
      // must not treat it as somewhere to put a note.
      expect(inlineNoteInsertion("count the closing brace}")).toEqual({
        value: "count the closing brace} {}",
        caret: 26,
      });
    });

    it("appends when the group is mid-string", () => {
      expect(inlineNoteInsertion("fix the {foo} handler")).toEqual({
        value: "fix the {foo} handler {}",
        caret: 23,
      });
    });

    it("appends when a group is followed by punctuation", () => {
      expect(inlineNoteInsertion("rename {old} to {new}.")).toEqual({
        value: "rename {old} to {new}. {}",
        caret: 24,
      });
    });

    it("composes into a string the parser reads as a note", () => {
      // The whole point, end to end: type into the caret position and the
      // result is what the person meant. Asserted against the real parser so
      // the button cannot drift away from the syntax it is a shortcut for.
      const { value, caret } = inlineNoteInsertion("buy milk");
      const typed = `${value.slice(0, caret)}2 pints${value.slice(caret)}`;
      expect(typed).toBe("buy milk {2 pints}");
      expect(splitInlineNote(typed)).toEqual({
        text: "buy milk",
        note: "2 pints",
      });
    });
  });

  describe("an existing trailing group — reuse it, never append a second", () => {
    it("puts the caret inside the group that is already there", () => {
      expect(inlineNoteInsertion("buy milk {2 pints}")).toEqual({
        value: "buy milk {2 pints}",
        caret: 17,
      });
    });

    it("reuses an EMPTY group, so pressing twice cannot make `{} {}`", () => {
      const once = inlineNoteInsertion("buy milk");
      expect(once.value).toBe("buy milk {}");
      expect(inlineNoteInsertion(once.value)).toEqual(once);
    });

    it("ignores trailing whitespace after the group", () => {
      expect(inlineNoteInsertion("buy milk {2 pints}   ")).toEqual({
        value: "buy milk {2 pints}",
        caret: 17,
      });
    });

    it("lands after the last character of a group containing braces", () => {
      expect(inlineNoteInsertion("ship it {check {staging} first}")).toEqual({
        value: "ship it {check {staging} first}",
        caret: 30,
      });
    });

    it("does not append a second group — that would reassign which one is the note", () => {
      // The case the requirement turns on. Under Decision 1 the LAST group is
      // the note, so appending to `fix {foo}` would silently promote a brand new
      // `{bar}` to note and demote `{foo}` to text. Reusing the existing group
      // keeps the note the person is looking at.
      const { value, caret } = inlineNoteInsertion("fix {foo}");
      expect({ value, caret }).toEqual({ value: "fix {foo}", caret: 8 });

      const typed = `${value.slice(0, caret)} and bar${value.slice(caret)}`;
      expect(typed).toBe("fix {foo and bar}");
      expect(splitInlineNote(typed)).toEqual({
        text: "fix",
        note: "foo and bar",
      });

      // What appending would have produced instead, for contrast.
      expect(splitInlineNote("fix {foo} {bar}")).toEqual({
        text: "fix {foo}",
        note: "bar",
      });
    });

    it("puts the caret in the braces even when they are not (yet) a note", () => {
      // `{just a note}` has no text in front of it, so the parser refuses it —
      // but the braces are still there, and a second pair would not help.
      expect(inlineNoteInsertion("{just a note}")).toEqual({
        value: "{just a note}",
        caret: 12,
      });
    });
  });

  it("always leaves the caret on the closing brace, for every shape", () => {
    // One property rather than fourteen assertions: whatever branch was taken,
    // the character the caret sits in front of is the group's `}`. A caret that
    // landed outside the braces would silently append the note to the title.
    for (const raw of EVERY_SHAPE) {
      const { value, caret } = inlineNoteInsertion(raw);
      expect(value[caret]).toBe("}");
      expect(value.slice(caret)).toBe("}");
    }
  });
});
