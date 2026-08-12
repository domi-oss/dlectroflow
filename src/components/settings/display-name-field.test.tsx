// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { saveMock, refreshMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  refreshMock: vi.fn(),
}));

// The factory replaces the module wholesale, so anything the component tree
// reaches has to be here or it is `undefined` at call time (#160). This component
// reaches exactly one export of it.
//
// `MAX_DISPLAY_NAME_LENGTH` is deliberately NOT mocked: it lives in
// `@/lib/constants` rather than beside the action, because a `"use server"`
// module may only export async functions. That is the better arrangement for this
// spec too — the `maxLength` assertion below reads the real bound instead of a
// stub that could agree with a wrong number.
vi.mock("@/app/actions/account", () => ({
  saveDisplayName: saveMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { MAX_DISPLAY_NAME_LENGTH } from "@/lib/constants";
import { DisplayNameField } from "./display-name-field";

beforeEach(() => {
  vi.clearAllMocks();
  saveMock.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

// 40ms rather than the real 600, so the specs are fast — and rather than 0,
// because at 0 the timer fires BETWEEN keystrokes and a four-character burst
// issues four writes. That would make every `mockRejectedValueOnce` below assert
// on a first attempt whose failure the three successes after it have already
// cleared. `userEvent` deadlocks under `vi.useFakeTimers()`, so the delay is a
// prop — the same escape hatch `AgingSection`'s `autoSaveDelayMs` exists for.
const props = {
  displayName: null,
  voice: "plain",
  autoSaveDelayMs: 40,
} as const;

const field = () => screen.getByLabelText(/your name/i);

describe("DisplayNameField (#252)", () => {
  it("seeds from the stored name", () => {
    render(<DisplayNameField {...props} displayName="Domi" />);
    expect(field()).toHaveValue("Domi");
  });

  it("shows an empty field for an account that never set one", () => {
    render(<DisplayNameField {...props} />);
    expect(field()).toHaveValue("");
  });

  it("auto-saves what was typed, with no Save button to find", async () => {
    render(<DisplayNameField {...props} />);
    await userEvent.type(field(), "Domi");
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith("Domi"));
    // The convention every other settings section follows: no submit control.
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  // The debounce is the point — one write per pause, not one per keystroke, on a
  // field that revalidates the whole app layout.
  it("writes once for a burst of typing, not once per keystroke", async () => {
    render(<DisplayNameField {...props} />);
    await userEvent.type(field(), "Domi");
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith("Domi");
  });

  it("clears the name when the field is emptied", async () => {
    render(<DisplayNameField {...props} displayName="Domi" />);
    await userEvent.clear(field());
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith(""));
  });

  // The label is rendered by the app SHELL, so the header would keep saying the
  // old thing until a navigation without this.
  it("refreshes so the header picks the new name up", async () => {
    render(<DisplayNameField {...props} />);
    await userEvent.type(field(), "Domi");
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });

  it("caps the field's length at the action's own bound", () => {
    render(<DisplayNameField {...props} />);
    // Read from the real constant, not a literal: one number, so the field and
    // the server cannot disagree about what is acceptable — the field stops
    // accepting rather than letting the write fail.
    expect(field()).toHaveAttribute(
      "maxlength",
      String(MAX_DISPLAY_NAME_LENGTH),
    );
  });
});

describe("DisplayNameField — accessibility (#252)", () => {
  it("associates the label and the hint with the input", () => {
    render(<DisplayNameField {...props} />);
    const input = field();
    // The hint is not decoration: it is the only place the reader learns that
    // this shows in the header on every page and that emptying it is the way
    // back. An unassociated hint is invisible to a screen reader on the field.
    expect(input).toHaveAccessibleDescription(/what the header calls you/i);
  });

  it("meets the 44px minimum height for a text field", () => {
    render(<DisplayNameField {...props} />);
    expect(field().className).toContain("min-h-11");
  });

  it("is a single-line text input, with autocorrect off", () => {
    render(<DisplayNameField {...props} />);
    const input = field();
    expect(input.tagName).toBe("INPUT");
    expect(input).toHaveAttribute("type", "text");
    // A name is not a word to be spell-corrected or auto-capitalised, and this
    // one ends up in the header of every page.
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("autocapitalize", "off");
  });
});

/**
 * A failed save says so — and does NOT put the server's value back.
 *
 * #227's audit added a rollback to the three sections whose controls are
 * toggles. `AgingSection` deliberately has none, and states why: its inputs are
 * free-entry fields, so the value on screen is the user's own in-progress typing
 * and restoring the server's would DELETE what they are still writing. This field
 * is that shape, so it follows `AgingSection` and not the toggles — and the spec
 * is here so the next audit reads the missing rollback as the decision it is.
 */
describe("DisplayNameField — when the write fails", () => {
  it("says the save failed rather than looking like it worked", async () => {
    saveMock.mockRejectedValueOnce(new Error("offline"));
    render(<DisplayNameField {...props} />);
    await userEvent.type(field(), "Domi");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't save/i,
    );
  });

  // A refused write is a failure even though it did not throw: the action
  // returns `{ ok: false }` for a name the server will not store, and a
  // component that only catches rejections reports success for it.
  it("treats a refusal as a failure, not as a save", async () => {
    saveMock.mockResolvedValueOnce({ ok: false, error: "invalid_name" });
    render(<DisplayNameField {...props} />);
    await userEvent.type(field(), "Domi");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't save/i,
    );
  });

  it("leaves what the user typed on screen", async () => {
    saveMock.mockRejectedValueOnce(new Error("offline"));
    render(<DisplayNameField {...props} displayName="Old" />);
    await userEvent.clear(field());
    await userEvent.type(field(), "New");
    await screen.findByRole("alert");
    expect(field()).toHaveValue("New");
  });

  it("clears the message once a later save lands", async () => {
    saveMock.mockRejectedValueOnce(new Error("offline"));
    render(<DisplayNameField {...props} />);
    await userEvent.type(field(), "Do");
    await screen.findByRole("alert");

    await userEvent.type(field(), "mi");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(saveMock).toHaveBeenLastCalledWith("Domi");
  });

  it("says nothing at all when the save works", async () => {
    render(<DisplayNameField {...props} />);
    await userEvent.type(field(), "Domi");
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
