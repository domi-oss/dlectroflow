import { describe, it, expect } from "vitest";
import { TASK_NOTE_MAX_LENGTH, normalizeTaskNote } from "./task-notes";
import { buildScheduleNote } from "./scheduling/note";

describe("TASK_NOTE_MAX_LENGTH", () => {
  it("leaves room for the whole composed envelope inside Google's 8192 cap", () => {
    // The bound is not arbitrary, and the reasoning is pinned here as well as in
    // 20260805120000_task_and_step_notes: the scheduled artifact carries a
    // context line + the task note + the step note + the focus prompt + an
    // absolute URL, and the Google Tasks API rejects a `notes` value over 8192
    // characters. A bound that could fill that cap would turn a long note into
    // a FAILED schedule rather than a truncated one.
    //
    // Duo review (!270): this used to assert `TASK_NOTE_MAX_LENGTH * 4 < 8192`,
    // which is the SINGLE-note margin. Since #44 ships both grains, the binding
    // case is both notes full at once, and the 4x figure both overstated the
    // headroom's meaning and contradicted `scheduling/note.ts`, which already
    // said 2x.
    expect(TASK_NOTE_MAX_LENGTH).toBe(2000);

    // Measured against a real composed artifact rather than a restatement of
    // the arithmetic — the envelope is whatever `buildScheduleNote` actually
    // emits, plus the context line `encode-reclaim.ts` puts in front of it.
    // A guessed constant here would drift the moment either string changes.
    const full = "y".repeat(TASK_NOTE_MAX_LENGTH);
    const context = `${"t".repeat(200)} — step 99 of 99 · est. 120m`;
    const composed = `${context}\n${buildScheduleNote({
      origin: "https://dlectroflow.dev",
      voice: "playful",
      stepId: "c".repeat(30),
      taskNote: full,
      stepNote: `${full}!`, // differs, so the dedupe cannot collapse the two
    })}`;

    expect(composed.length).toBeLessThan(8192);
    // And the headroom is the ~2x the comments claim, not the ~4x they used to.
    expect(8192 / composed.length).toBeGreaterThan(1.8);
    expect(8192 / composed.length).toBeLessThan(2.2);
  });
});

describe("normalizeTaskNote", () => {
  it("returns null for absent, empty and whitespace-only input", () => {
    // Null, not "": the column is nullable and "nobody has written a note" has
    // to stay distinguishable from "somebody wrote one and cleared it", because
    // the note is only threaded into a scheduled artifact when it is present.
    expect(normalizeTaskNote(null)).toBeNull();
    expect(normalizeTaskNote(undefined)).toBeNull();
    expect(normalizeTaskNote("")).toBeNull();
    expect(normalizeTaskNote("   \n\t  ")).toBeNull();
  });

  it("trims the outer whitespace but keeps the interior shape", () => {
    expect(normalizeTaskNote("  call before 5\n\nbring the Figma link  ")).toBe(
      "call before 5\n\nbring the Figma link",
    );
  });

  it("normalises CRLF and bare CR to a single LF", () => {
    // A textarea submits CRLF per the HTML spec, and a bare CR is what a
    // hand-rolled POST can send. Both mean one line ending; storing them
    // verbatim would make the same note render with a different line count
    // depending on how it was written.
    expect(normalizeTaskNote("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("strips C0 control characters, keeping tab and newline", () => {
    // Defence in depth for the scheduled artifact. `esc()` in src/lib/ics.ts
    // already drops these on the ICS path, but the Google Tasks path has no
    // such filter, and a control character in a note is meaningless in every
    // surface that renders it.
    expect(normalizeTaskNote("a\x00b\x07c\x1bd\x7fe\tf\ng")).toBe(
      "abcde\tf\ng",
    );
  });

  it("clamps an over-long note to the bound rather than throwing", () => {
    // The textarea carries `maxLength`, so reaching this means a scripted POST.
    // Clamping keeps autosave working; throwing would leave the field stuck in
    // its error state, and the DB CHECK is the backstop either way.
    const clamped = normalizeTaskNote("x".repeat(TASK_NOTE_MAX_LENGTH + 500));
    expect(clamped).toHaveLength(TASK_NOTE_MAX_LENGTH);
  });

  it("clamps AFTER stripping, so removed controls do not eat the budget", () => {
    const raw = "\x00".repeat(500) + "y".repeat(TASK_NOTE_MAX_LENGTH);
    expect(normalizeTaskNote(raw)).toBe("y".repeat(TASK_NOTE_MAX_LENGTH));
  });

  it("re-trims after clamping, so a note never ends mid-whitespace", () => {
    const raw = "z".repeat(TASK_NOTE_MAX_LENGTH - 1) + "  tail";
    expect(normalizeTaskNote(raw)).toBe("z".repeat(TASK_NOTE_MAX_LENGTH - 1));
  });

  it("clamps in CODE POINTS, so an emoji is never cut in half", () => {
    // Two reasons this is not a `.slice()`. Postgres `char_length()` — what the
    // CHECK constraint measures — counts characters, so a UTF-16 slice and the
    // constraint disagree about the same string. And a slice landing between
    // the surrogates of an astral character stores a lone half nothing can
    // render.
    const raw = "a".repeat(TASK_NOTE_MAX_LENGTH - 1) + "🧠" + "b";
    const clamped = normalizeTaskNote(raw);
    expect(clamped).toBe("a".repeat(TASK_NOTE_MAX_LENGTH - 1) + "🧠");
    expect([...(clamped as string)]).toHaveLength(TASK_NOTE_MAX_LENGTH);
    expect(clamped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
