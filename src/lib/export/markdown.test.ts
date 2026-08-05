import { describe, it, expect } from "vitest";
import { tasksMarkdown } from "./markdown";
import { makeSnapshot, makeEmptySnapshot } from "./__tests__/fixture";

const snapshot = makeSnapshot();
const md = tasksMarkdown(snapshot);

describe("tasks.md — the human tier", () => {
  it("opens with a heading and says when it was exported", () => {
    expect(md.startsWith("# dlectroflow — tasks\n")).toBe(true);
    expect(md).toContain("2026-08-03T09:30:00.000Z");
  });

  it("gives every task its own heading, carrying the emoji and the title", () => {
    // Markdown, not CSV, is the human tier — this is the file that has to still
    // be readable with no tooling at all.
    expect(md).toContain('## 🚀 Ship "the thing",');
    expect(md).toContain("## Renew the passport");
    expect(md).toContain("## Tidy the garage");
  });

  it("keeps a multi-line title on one heading line", () => {
    // A raw newline inside a `##` line ends the heading and turns the rest into a
    // paragraph, so the title is flattened for the heading — and the untouched
    // version is still in export.json.
    const headings = md.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toHaveLength(3);
    expect(headings[0]).toBe(
      '## 🚀 Ship "the thing", with a newline; and a 🚀',
    );
  });

  it("nests every step under its own task, in order, with its state", () => {
    // The property the whole tier exists for: CSV cannot do this.
    const section = md.slice(md.indexOf("## 🚀"), md.indexOf("## Renew"));
    expect(section).toContain("- [x] 📝 Draft the outline, then stop");
    expect(section).toContain("- [ ] Write it");
    expect(section.indexOf("Draft the outline")).toBeLessThan(
      section.indexOf("Write it"),
    );
    // A stepless task's section must not sprout an empty Steps list.
    const passport = md.slice(md.indexOf("## Renew"), md.indexOf("## Tidy"));
    expect(passport).not.toContain("### Steps");
  });

  it("indents a step's continuation lines so the list item does not break", () => {
    // "Write it\nacross two lines" — an unindented second line ends the list.
    expect(md).toContain("- [ ] Write it\n      across two lines");
  });

  it("states each step's estimate and its scheduled time", () => {
    expect(md).toContain("15 min");
    expect(md).toContain("scheduled 2026-07-02T09:00:00.000Z");
  });

  it("records each task's status, dates and stable id", () => {
    expect(md).toContain("- Status: active");
    expect(md).toContain("- Created: 2026-07-01T09:00:00.000Z");
    expect(md).toContain("- Due: 2026-07-05T17:00:00.000Z");
    expect(md).toContain("- Priority: high");
    expect(md).toContain("- Hours: work");
    // The id is what makes a re-import idempotent, so it travels in the human
    // tier too rather than only in the machine one.
    expect(md).toContain("`task-1`");
  });

  it("omits the lines a task has no value for, rather than printing empty ones", () => {
    const garage = md.slice(md.indexOf("## Tidy the garage"));
    expect(garage).not.toContain("- Due:");
    expect(garage).not.toContain("- Priority:");
  });

  it("carries the user's own note, quoted, in its own section (#44)", () => {
    // The note is content the data subject typed, so Art. 20 puts it in the
    // human tier and not only in `export.json`. It is quoted rather than
    // inlined as a `- Note:` fact for the same reason the coaching turns are:
    // it is multi-line prose, and a fact list that grows a paragraph stops
    // being scannable. `csv-files.ts` states the matching decision for the
    // spreadsheet tier — free-text prose lives in `tasks.md` and `export.json`.
    expect(md).toContain("### Note");
    expect(md).toContain("> Bring the Figma link");
    // Blockquoted line-by-line, so a blank line inside the note cannot end the
    // quote and leave the rest rendering as body text.
    expect(md).toContain("> call before 5");
  });

  it("gives a task with no note no Note heading", () => {
    const garage = md.slice(md.indexOf("## Tidy the garage"));
    expect(garage).not.toContain("### Note");
  });

  it("carries a STEP's own note, nested under that step (#44)", () => {
    // Both grains are the user's content, so both are in the human tier.
    // Indented under the step's list item rather than given its own heading:
    // it belongs to one bullet, and a heading would detach it from the step it
    // annotates.
    const steps = md.slice(md.indexOf("### Steps"));
    expect(steps).toContain("the login page, not the marketing one");
    expect(steps).toMatch(
      /Draft the outline, then stop[^\n]*\n\s+- Note: the login page, not the marketing one/,
    );
  });

  it("leaves a step with no note unannotated", () => {
    const steps = md.slice(md.indexOf("### Steps"));
    const secondStep = steps.slice(steps.indexOf("Write it"));
    expect(secondStep).not.toContain("- Note:");
  });

  it("includes the coaching conversation, attributed and in order", () => {
    // Agreed on the issue: the turns are the most personal content in the
    // database and squarely data "provided by the data subject" (Art. 20).
    expect(md).toContain("### Coaching conversation");
    // The speaker label carries the turn's timestamp, so a conversation read
    // years later still says when it happened. "dlectroflow", not "Assistant":
    // name the thing the person was talking to, not the database's role string.
    expect(md).toContain("**You** — 2026-07-01T09:00:30.000Z");
    expect(md).toContain("**dlectroflow** — 2026-07-01T09:00:45.000Z");
    expect(md.indexOf("I keep putting this off")).toBeLessThan(
      md.indexOf("Two steps."),
    );
  });

  it("quotes a multi-paragraph coaching message so it stays attached to its turn", () => {
    // "Two steps.\n\nFirst, draft an outline." — as plain text the blank line
    // detaches the second paragraph from the speaker label above it.
    expect(md).toContain("> Two steps.\n>\n> First, draft an outline.");
  });

  it("gives a task with no conversation no conversation heading", () => {
    const passport = md.slice(md.indexOf("## Renew"), md.indexOf("## Tidy"));
    expect(passport).not.toContain("### Coaching conversation");
  });

  it("ends with a single trailing newline", () => {
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });

  it("says so in prose when there are no tasks, instead of producing an empty file", () => {
    const empty = tasksMarkdown(makeEmptySnapshot());
    expect(empty).toContain("# dlectroflow — tasks");
    expect(empty).toContain("No tasks");
    expect(empty).not.toContain("## ");
  });
});
