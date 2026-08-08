// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { AddNoteButton } from "@/components/inbox/add-note-button";
import { splitInlineNote } from "@/lib/braindump-note-syntax";
import { touchTarget } from "@/lib/utils";
import type { Voice } from "@/lib/strings";

/**
 * #186 — the "add note" affordance on a brain-dump field.
 *
 * Two things are asserted here that no automated gate can see, and they are the
 * substance rather than the garnish:
 *
 *  1. **Where the caret lands.** The entire value of this button is that nobody
 *     has to reach the `{` key, and a caret one character out puts the note
 *     outside the braces — which reads, silently, as a longer title. Eyeballing
 *     it in a browser cannot be repeated; `selectionStart` can.
 *  2. **The accessible name contains the visible label** (WCAG 2.5.3), in both
 *     voices, so a voice-control user saying what they can see activates it. The
 *     pattern and the reasoning come from `note-field.test.tsx`.
 */

afterEach(cleanup);

/**
 * A real controlled input with the button beside it — the shape both call sites
 * have. The button writes through `onChange` and then places the caret in the
 * committed DOM, so a harness holding the state is the only way to exercise the
 * second half at all.
 */
function Harness({
  initial = "",
  voice = "plain",
  subject = "Brain dump",
}: {
  initial?: string;
  voice?: Voice;
  subject?: string;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div>
      <input
        ref={inputRef}
        aria-label="Brain dump"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <AddNoteButton
        subject={subject}
        value={value}
        inputRef={inputRef}
        onChange={setValue}
        voice={voice}
      />
    </div>
  );
}

const field = () => screen.getByRole("textbox") as HTMLInputElement;
const addNote = () => screen.getByRole("button", { name: /add note/i });

describe("AddNoteButton (#186)", () => {
  describe("a11y", () => {
    it("is a real button with the label as visible text", () => {
      render(<Harness initial="buy milk" />);
      const button = addNote();
      expect(button.tagName).toBe("BUTTON");
      // Not a submit: this control is inside no form, and a stray implicit
      // submit on the capture bar would be indistinguishable from Enter.
      expect(button.getAttribute("type")).toBe("button");
      expect((button.textContent ?? "").trim()).toBe("Add note");
    });

    it("keeps the visible label INSIDE the accessible name (WCAG 2.5.3)", () => {
      render(<Harness initial="buy milk" subject="Brain dump" />);
      const button = screen.getByRole("button", {
        name: "Add note for Brain dump",
      });
      const visible = (button.textContent ?? "").trim();
      expect(visible).toBe("Add note");
      // `getByRole({ name })` computes the name with `dom-accessibility-api`, so
      // the assertion above is the screen reader's answer and not an attribute
      // being present. The containment is what 2.5.3 needs.
      expect(button.getAttribute("aria-label")?.startsWith(visible)).toBe(true);
    });

    it("names the field it belongs to, so two mounted at once are distinguishable", () => {
      // The capture bar and an open row editor are on screen together, and
      // "Add note" twice is two buttons a screen-reader user cannot tell apart.
      render(<Harness initial="water the plants" subject="water the plants" />);
      expect(
        screen.getByRole("button", { name: "Add note for water the plants" }),
      ).toBeTruthy();
    });

    it("does the same in the playful voice, where the label carries an emoji", () => {
      render(<Harness initial="buy milk" voice="playful" />);
      const button = addNote();
      expect((button.textContent ?? "").trim()).toBe("🗒️ Add note");
      expect(button.getAttribute("aria-label")).toBe(
        "🗒️ Add note for Brain dump",
      );
    });

    it("carries the shared 44x44 touch target (WCAG 2.5.8)", () => {
      render(<Harness initial="buy milk" />);
      // The shared constant, not a hand-copied set of classes — the point of
      // `touchTarget` existing is that the floor is defined once.
      for (const token of touchTarget.split(" ")) {
        expect(addNote().className).toContain(token);
      }
    });

    it("is operable from the keyboard alone", async () => {
      const user = userEvent.setup();
      render(<Harness initial="buy milk" />);
      await user.click(field());
      await user.tab();
      expect(addNote()).toHaveFocus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(field()).toHaveValue("buy milk {}"));
    });

    it("is disabled while there is nothing to attach a note to", async () => {
      const user = userEvent.setup();
      render(<Harness initial="" />);
      expect(addNote()).toBeDisabled();
      await user.type(field(), "buy milk");
      expect(addNote()).not.toBeDisabled();
    });

    it("stays disabled for a whitespace-only field", () => {
      render(<Harness initial="   " />);
      expect(addNote()).toBeDisabled();
    });
  });

  describe("no trailing group — it appends one", () => {
    it("inserts the braces and leaves the caret between them", async () => {
      const user = userEvent.setup();
      render(<Harness initial="buy milk" />);
      await user.click(addNote());
      await waitFor(() => expect(field()).toHaveValue("buy milk {}"));
      // Index 10 is the `}`. A collapsed caret, so nothing is selected and the
      // next keystroke cannot replace anything.
      expect(field().selectionStart).toBe(10);
      expect(field().selectionEnd).toBe(10);
    });

    it("moves focus into the field so the note can just be typed", async () => {
      // Without this the caret is in the right place and the keyboard is aimed
      // at the button, which on a phone means the keyboard is not even up.
      const user = userEvent.setup();
      render(<Harness initial="buy milk" />);
      await user.click(addNote());
      await waitFor(() => expect(field()).toHaveFocus());
    });

    it("typing straight afterwards produces a note the parser reads", async () => {
      const user = userEvent.setup();
      render(<Harness initial="buy milk" />);
      await user.click(addNote());
      await waitFor(() => expect(field()).toHaveValue("buy milk {}"));
      await user.keyboard("2 pints");
      expect(field()).toHaveValue("buy milk {2 pints}");
      expect(splitInlineNote(field().value)).toEqual({
        text: "buy milk",
        note: "2 pints",
      });
    });
  });

  describe("an existing trailing group — it reuses that one", () => {
    it("puts the caret inside the group already there", async () => {
      const user = userEvent.setup();
      render(<Harness initial="buy milk {2 pints}" />);
      await user.click(addNote());
      await waitFor(() => expect(field()).toHaveFocus());
      expect(field()).toHaveValue("buy milk {2 pints}");
      expect(field().selectionStart).toBe(17);
    });

    it("appends nothing on a second press", async () => {
      // Idempotent, so a double tap on a phone cannot produce `{} {}`.
      const user = userEvent.setup();
      render(<Harness initial="buy milk" />);
      await user.click(addNote());
      await waitFor(() => expect(field()).toHaveValue("buy milk {}"));
      await user.click(addNote());
      await waitFor(() => expect(field()).toHaveValue("buy milk {}"));
      expect(field().selectionStart).toBe(10);
    });

    it("does not create a second group that would reassign the note", async () => {
      // Under #179's Decision 1 the LAST group is the note. Appending to
      // `fix {foo}` would have promoted a new `{bar}` to note and demoted
      // `{foo}` to text, silently changing what the person already had.
      const user = userEvent.setup();
      render(<Harness initial="fix {foo}" />);
      await user.click(addNote());
      await waitFor(() => expect(field()).toHaveFocus());
      expect(field()).toHaveValue("fix {foo}");
      expect(field().selectionStart).toBe(8);
      await user.keyboard(" and bar");
      expect(field()).toHaveValue("fix {foo and bar}");
      expect(splitInlineNote(field().value)).toEqual({
        text: "fix",
        note: "foo and bar",
      });
    });
  });
});
