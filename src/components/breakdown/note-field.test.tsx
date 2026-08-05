// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  NoteField,
  type NoteSaveResult,
} from "@/components/breakdown/note-field";
import { TASK_NOTE_MAX_LENGTH } from "@/lib/task-notes";

/**
 * #44 — the shared note disclosure, mounted once per task and once per step.
 *
 * The a11y assertions here are the substance, not a garnish. `a11y-class-hygiene`
 * can see a contrast or focus-indicator regression in this file's class strings
 * and axe can see a missing label, but NEITHER can see the failure this control
 * is most likely to have: "Note" repeated down a list of steps, giving a
 * screen-reader user twelve buttons with identical names and no way to tell
 * which step each belongs to. That one is only catchable by asserting the
 * accessible NAME, which is what most of the specs below do.
 */

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const onSave = vi.fn();

const renderField = (props?: Partial<Parameters<typeof NoteField>[0]>) =>
  render(
    <NoteField
      subject="Ship the thing"
      initialNote={null}
      onSave={onSave}
      voice="plain"
      autoSaveDelayMs={20}
      {...props}
    />,
  );

beforeEach(() => {
  onSave.mockImplementation(async (next: string | null) => ({
    ok: true as const,
    notes: next,
  }));
});

describe("NoteField — collapsed by default", () => {
  it("shows only the trigger when there is no note", () => {
    renderField();
    expect(screen.getByRole("button", { name: /^note for/i })).toBeTruthy();
    // The editor is not merely invisible — it is out of the a11y tree and the
    // tab order, which is what `hidden` the ATTRIBUTE buys over a CSS class.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("names the trigger after the thing it belongs to, not just 'Note'", () => {
    // The failure this prevents: a list of steps rendering twelve buttons all
    // called "Note". The visible label stays short, and the subject is
    // appended for assistive tech only.
    renderField();
    expect(
      screen.getByRole("button", { name: "Note for Ship the thing" }),
    ).toBeTruthy();
  });

  it("keeps the visible label INSIDE the accessible name (WCAG 2.5.3)", () => {
    // Label in Name: a voice-control user says what they can SEE. The name is
    // set explicitly (an sr-only span produced "Add notefor Ship the thing" —
    // see the component's comment), so the containment has to be asserted
    // rather than falling out of the markup.
    renderField();
    const trigger = screen.getByRole("button", { name: /^note for/i });
    const visible = (trigger.textContent ?? "").trim();
    const accessibleName = trigger.getAttribute("aria-label") ?? "";
    expect(visible).toBe("Note");
    expect(accessibleName.startsWith(visible)).toBe(true);
    // And the name really does resolve to that — `getByRole({ name })` computes
    // it with `dom-accessibility-api`, so this is the screen reader's answer
    // rather than an attribute being present.
    expect(
      screen.getByRole("button", { name: "Note for Ship the thing" }),
    ).toBe(trigger);
  });

  it("does the same in the playful voice, where the label carries an emoji", () => {
    // The emoji is part of the visible label, so it has to be part of the
    // accessible name too or 2.5.3 breaks in one voice and not the other.
    renderField({ voice: "playful" });
    // Not anchored: the playful name legitimately begins with the emoji.
    const trigger = screen.getByRole("button", { name: /note for/i });
    const visible = (trigger.textContent ?? "").trim();
    expect(visible).toBe("🗒️ Note");
    expect(trigger.getAttribute("aria-label")).toBe(
      "🗒️ Note for Ship the thing",
    );
  });

  it("uses ONE noun whether or not a note exists — never Add vs Edit", () => {
    // "Add" and "Edit" both describe a one-off action; this is a persistent
    // autosaving field. The switch also lied in a case #179 makes common — a
    // note carried in from a brain dump exists before anyone "added" anything —
    // and a fixed word stops the control changing width, and the row shifting,
    // on the first keystroke.
    renderField({ initialNote: null });
    const empty = (
      screen.getByRole("button", { name: /^note for/i }).textContent ?? ""
    ).trim();
    cleanup();
    renderField({ initialNote: "already written" });
    const filled = (
      screen.getByRole("button", { name: /^note for/i }).textContent ?? ""
    ).trim();
    expect(empty).toBe("Note");
    expect(filled).toBe("Note");
  });

  it("reports itself collapsed, and points at the region it controls", () => {
    renderField();
    const trigger = screen.getByRole("button", { name: /^note for/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const controls = trigger.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    // `aria-controls` has to RESOLVE even while collapsed, which is why the
    // body stays mounted behind `hidden` rather than being unmounted.
    expect(document.getElementById(controls as string)).not.toBeNull();
  });
});

describe("NoteField — an existing note is readable without expanding", () => {
  it("renders the saved note as text while collapsed", () => {
    // The whole point of the note is that it is THERE when you come back to the
    // task. Hiding it behind a tap would defeat the feature.
    renderField({ initialNote: "Bring the Figma link" });
    expect(screen.getByTestId("note-text").textContent).toBe(
      "Bring the Figma link",
    );
    // The collapsed editor is out of the a11y tree and the tab order, so the
    // note is present exactly once as far as a screen reader is concerned even
    // though the textarea below it is still mounted holding the same string.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps the same subject-named trigger once a note exists", () => {
    renderField({ initialNote: "Bring the Figma link" });
    expect(
      screen.getByRole("button", { name: "Note for Ship the thing" }),
    ).toBeTruthy();
  });

  it("preserves the line breaks a multi-line note was written with", () => {
    renderField({ initialNote: "one\ntwo" });
    const shown = screen.getByTestId("note-text");
    expect(shown.textContent).toBe("one\ntwo");
    // Rendered with `whitespace-pre-wrap`, so the break survives without the
    // note becoming HTML — it is plain text and stays plain text.
    expect(shown.className).toContain("whitespace-pre-wrap");
  });
});

describe("NoteField — expanding", () => {
  it("reveals a textarea and moves focus into it", async () => {
    const user = userEvent.setup();
    renderField();
    await user.click(screen.getByRole("button", { name: /^note for/i }));

    const box = screen.getByRole("textbox");
    expect(box).toBeTruthy();
    // Focus MANAGEMENT, not just reveal: a keyboard user who activated the
    // trigger would otherwise have to tab blindly forward to reach the field
    // they just asked for.
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it("flips aria-expanded on the same trigger, rather than swapping buttons", async () => {
    const user = userEvent.setup();
    renderField();
    const trigger = screen.getByRole("button", { name: /^note for/i });
    await user.click(trigger);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /note for Ship the thing/i })
          .getAttribute("aria-expanded"),
      ).toBe("true"),
    );
  });

  it("names the textarea programmatically — the placeholder is NOT the name", async () => {
    // The visible <label> is gone (owner: two stacked "Note" words for one
    // field is noise), so this name is load-bearing rather than belt-and-
    // braces. Asserted through `getByRole({ name })`, which computes it with
    // `dom-accessibility-api` — an attribute-level check would have passed on
    // all three mangled-name bugs this codebase produced in a day, including
    // this component's own "Add notefor Ship the thing".
    const user = userEvent.setup();
    renderField();
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    expect(
      screen.getByRole("textbox", { name: "Note for Ship the thing" }),
    ).toBeTruthy();
    // No stacked heading above the field any more.
    expect(document.querySelector("label")).toBeNull();
  });

  it("shows an example placeholder, and keeps the hint line as well", async () => {
    const user = userEvent.setup();
    renderField();
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    const box = screen.getByRole("textbox", {
      name: "Note for Ship the thing",
    });
    // An EXAMPLE of what a note is for, not a restatement of the word "Note".
    expect(box.getAttribute("placeholder")).toBe(
      "Anything worth knowing when you start…",
    );
    // The hint explains where the note travels to; the placeholder cannot.
    const describedBy = box.getAttribute("aria-describedby") as string;
    expect(
      document.getElementById(describedBy.split(" ")[0])?.textContent,
    ).toMatch(/calendar|Google Task/i);
  });

  it("paints the placeholder at an AA colour, not the sub-AA default", async () => {
    // MEASURED, not assumed. Tailwind's default placeholder is currentColor at
    // 50%, which is 3.22:1 on the light --background and 4.29:1 on the dark one
    // — both under the 4.5:1 AA floor. --muted-foreground is 5.27:1 / 9.13:1
    // and flips with the theme, so it needs no `dark:` partner.
    const user = userEvent.setup();
    renderField();
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    expect(
      screen.getByRole("textbox", { name: "Note for Ship the thing" })
        .className,
    ).toContain("placeholder:text-muted-foreground");
  });

  it("does not show the placeholder when a note arrived with content (#179)", async () => {
    // A placeholder only renders on an empty field, so a note carried in from a
    // brain dump simply never shows it. Pinned because it is the case most
    // likely to be overlooked, and because it is the reason the placeholder can
    // safely be an example rather than an instruction.
    const user = userEvent.setup();
    renderField({ initialNote: "came in from the brain dump" });
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    expect(
      screen.getByRole("textbox", { name: "Note for Ship the thing" }),
    ).toHaveProperty("value", "came in from the brain dump");
  });

  it("describes what the note is for, wired with aria-describedby", async () => {
    const user = userEvent.setup();
    renderField();
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    const box = screen.getByRole("textbox");
    const describedBy = box.getAttribute("aria-describedby") as string;
    expect(describedBy).toBeTruthy();
    const hint = document.getElementById(describedBy.split(" ")[0]);
    expect(hint?.textContent).toMatch(/calendar|Google Task/i);
  });

  it("bounds the field at the same length the column and the action do", async () => {
    const user = userEvent.setup();
    renderField();
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    expect(screen.getByRole("textbox").getAttribute("maxLength")).toBe(
      String(TASK_NOTE_MAX_LENGTH),
    );
  });

  it("collapses on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderField();
    const trigger = screen.getByRole("button", { name: /^note for/i });
    await user.click(trigger);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    // Focus must not be lost to the document body — that is where a keyboard
    // user's position disappears and they have to start tabbing from the top.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /note for Ship the thing/i }),
    );
  });
});

describe("NoteField — autosave", () => {
  it("saves once after the debounce, not once per keystroke", async () => {
    const user = userEvent.setup();
    renderField();
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    await user.type(screen.getByRole("textbox"), "call Sam");

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith("call Sam");
  });

  it("has no Save button — the field is the whole interaction", async () => {
    const user = userEvent.setup();
    renderField();
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull();
  });

  it("shows the shared saved affordance, matching the settings sections", async () => {
    const user = userEvent.setup();
    renderField();
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    await user.type(screen.getByRole("textbox"), "hi");
    await waitFor(() =>
      expect(
        document.querySelector('[data-save-status="saved"]'),
      ).not.toBeNull(),
    );
  });

  it("surfaces a failed save without disabling the field", async () => {
    onSave.mockResolvedValue({ ok: false as const, reason: "error" as const });
    const user = userEvent.setup();
    renderField();
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    await user.type(screen.getByRole("textbox"), "hi");

    await waitFor(() =>
      expect(
        document.querySelector('[data-save-status="error"]'),
      ).not.toBeNull(),
    );
    // Still editable: the user's text is the only copy that exists, so taking
    // the field away from them is how it gets lost.
    expect(screen.getByRole("textbox").hasAttribute("disabled")).toBe(false);
  });

  it("does not save on expand alone, when nothing was typed", async () => {
    const user = userEvent.setup();
    renderField({ initialNote: "unchanged" });
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    await new Promise((r) => setTimeout(r, 60));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("sends null when the note is cleared, so the column goes back to NULL", async () => {
    const user = userEvent.setup();
    renderField({ initialNote: "delete me" });
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    await user.clear(screen.getByRole("textbox"));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });

  it("adopts what the server actually stored, not what was typed", async () => {
    // The action trims, strips controls and clamps. A field that keeps showing
    // the pre-normalisation text is telling the user something untrue about
    // what is saved.
    onSave.mockResolvedValue({ ok: true as const, notes: "trimmed" });
    const user = userEvent.setup();
    renderField();
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    await user.type(screen.getByRole("textbox"), "  trimmed  ");

    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveProperty("value", "trimmed"),
    );
  });

  it("ignores a slow save that lands after a newer one", async () => {
    // Two flushes CAN be in flight at once: the debounce only guarantees one is
    // ever SCHEDULED, so typing again while a save is awaiting starts a second.
    // If the first then resolves last, adopting its `notes` would overwrite the
    // user's newer text with an older stored value — silent loss of the only
    // copy that exists.
    let release: ((v: NoteSaveResult) => void) | null = null;
    onSave
      .mockImplementationOnce(
        () => new Promise<NoteSaveResult>((r) => (release = r)),
      )
      .mockImplementationOnce(async () => ({
        ok: true as const,
        notes: "second",
      }));

    const user = userEvent.setup();
    renderField();
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    await user.type(screen.getByRole("textbox"), "first");
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "second");
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));

    // Now let the FIRST call finish, out of order and carrying stale text, and
    // WAIT for its continuation to actually run. Asserting straight after the
    // release passes without the stale write ever having been attempted, which
    // is a test that proves nothing.
    (release as unknown as (v: NoteSaveResult) => void)({
      ok: true,
      notes: "first",
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(screen.getByRole("textbox")).toHaveProperty("value", "second");
  });

  it("announces the remaining budget politely as the bound approaches", async () => {
    const user = userEvent.setup();
    renderField({ initialNote: "y".repeat(TASK_NOTE_MAX_LENGTH - 5) });
    await user.click(screen.getByRole("button", { name: /^note for/i }));

    const counter = screen.getByTestId("note-counter");
    expect(counter.textContent).toContain("5");
    expect(counter.getAttribute("role")).toBe("status");
    // Polite, not assertive: a count ticking down on every keystroke must not
    // interrupt what the screen reader is already saying.
    expect(counter.getAttribute("aria-live")).toBe("polite");
    // No `aria-label`. On a live region the NAME and the announced CONTENT are
    // different things, and a name that paraphrases the content ("characters
    // remaining" over "5 characters left") is how one gets said twice.
    expect(counter.hasAttribute("aria-label")).toBe(false);
  });

  it("stays quiet about the budget while there is plenty left", async () => {
    const user = userEvent.setup();
    renderField();
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    expect(screen.queryByTestId("note-counter")).toBeNull();
  });

  it("flushes a pending edit immediately on blur", async () => {
    // The debounce is a window in which the only copy of what the user typed
    // lives in component state. Clicking away, tabbing on, or navigating within
    // that window would lose it: the unmount cleanup CLEARS the timer rather
    // than firing it, because an async write from a cleanup cannot be awaited.
    // Blurring is the moment that reliably precedes all three.
    const user = userEvent.setup();
    renderField({ autoSaveDelayMs: 10_000 });
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    await user.type(screen.getByRole("textbox"), "nearly lost");
    expect(onSave).not.toHaveBeenCalled();

    await user.tab();

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("nearly lost"));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("does not save on blur when nothing is pending", async () => {
    // Otherwise merely opening the field and tabbing away writes the column.
    const user = userEvent.setup();
    renderField({ initialNote: "unchanged" });
    await user.click(screen.getByRole("button", { name: /^note for/i }));
    await user.tab();
    await new Promise((r) => setTimeout(r, 40));
    expect(onSave).not.toHaveBeenCalled();
  });
});
