// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * #154 — the calendar feed card, in Settings next to the integrations.
 *
 * Three things are defended here, and only the first is ordinary UI:
 *
 *  • **THE CAVEAT IS AT THE POINT OF COPYING.** The issue asks for it in those
 *    words, so it is asserted as behaviour: the copy control and the URL field
 *    are both `aria-describedby` the warning, which means a screen-reader user
 *    hears it as part of the control rather than as a paragraph they may have
 *    scrolled past. A wording change that quietly drops "anyone with this link"
 *    is exactly the regression nobody reviews for.
 *  • **REGENERATING AND TURNING OFF BOTH CONFIRM.** Each breaks a subscription
 *    that is working in somebody's calendar, and the failure is silent — no
 *    error, just a week that stops updating. One click is the wrong price.
 *  • **THE URL IS NEVER RENDERED BEFORE THERE IS ONE.** An account with no feed
 *    must show no field to copy, so there is nothing to paste that 404s.
 */
const { createMock, regenerateMock, disableMock, refreshMock } = vi.hoisted(
  () => ({
    createMock: vi.fn(),
    regenerateMock: vi.fn(),
    disableMock: vi.fn(),
    refreshMock: vi.fn(),
  }),
);
vi.mock("@/app/actions/calendar-feed", () => ({
  createCalendarFeed: createMock,
  regenerateCalendarFeed: regenerateMock,
  disableCalendarFeed: disableMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { CalendarFeed } from "./calendar-feed";

const URL_A = `https://dlectroflow.dev/api/ics/feed/${"A".repeat(43)}`;
const URL_B = `https://dlectroflow.dev/api/ics/feed/${"B".repeat(43)}`;

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockResolvedValue({ ok: true, url: URL_A });
  regenerateMock.mockResolvedValue({ ok: true, url: URL_B });
  disableMock.mockResolvedValue({ ok: true });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});
afterEach(cleanup);

const field = () => screen.getByLabelText(/calendar feed url/i);
const copyButton = () => screen.getByRole("button", { name: /copy/i });

describe("the card with no feed yet (#154)", () => {
  beforeEach(() => render(<CalendarFeed url={null} />));

  it("offers to create one and shows nothing to copy", () => {
    expect(
      screen.getByRole("button", { name: /create a calendar feed/i }),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/calendar feed url/i)).toBeNull();
  });

  it("creates the feed and refreshes so the server re-renders with it", async () => {
    await userEvent.click(
      screen.getByRole("button", { name: /create a calendar feed/i }),
    );
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(refreshMock).toHaveBeenCalled();
  });

  it("reports a lapsed session rather than failing silently", async () => {
    createMock.mockResolvedValue({ ok: false, error: "not_signed_in" });
    await userEvent.click(
      screen.getByRole("button", { name: /create a calendar feed/i }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/signed in/i);
  });
});

describe("the card with a live feed (#154)", () => {
  beforeEach(() => render(<CalendarFeed url={URL_A} />));

  it("shows the URL in a labelled, read-only field", () => {
    const input = field() as HTMLInputElement;
    expect(input.value).toBe(URL_A);
    expect(input.readOnly).toBe(true);
  });

  it("states the caveat AT the point of copying, not merely near it", () => {
    // The issue's wording: "with the caveat that anyone holding the URL can read
    // the feed stated plainly at the point of copying".
    const describedBy = copyButton().getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const warning = document.getElementById(describedBy!.split(" ")[0]);
    expect(warning?.textContent).toMatch(/anyone/i);
    expect(warning?.textContent).toMatch(
      /without signing in|no sign|not need to sign/i,
    );
    // The field points at the same explanation, so tabbing to either one hears it.
    expect(field().getAttribute("aria-describedby")).toContain(
      describedBy!.split(" ")[0],
    );
  });

  it("copies the URL and says so politely", async () => {
    await userEvent.click(copyButton());
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_A));
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/copied/i);
  });

  it("falls back to selecting the text when the clipboard is refused", async () => {
    // Safari and any non-secure context can reject writeText. Leaving the person
    // with a silent no-op and a URL they cannot get at is not an option.
    writeText.mockRejectedValue(new Error("denied"));
    await userEvent.click(copyButton());
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/select|copy it/i);
  });

  it("does not change the copy control's accessible name while it works", async () => {
    // A control whose name mutates under a screen reader is disorienting for
    // anyone navigating by name — the rule `export-data.tsx` states.
    const before = copyButton().textContent;
    await userEvent.click(copyButton());
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(copyButton().textContent).toBe(before);
  });
});

/** The question a confirm button is answering, found the way a screen reader
 *  reaches it — through the button's own `aria-describedby`. */
function questionFor(confirm: HTMLElement): string {
  const id = confirm.getAttribute("aria-describedby");
  expect(id).toBeTruthy();
  return document.getElementById(id!)?.textContent ?? "";
}

describe("regenerating is confirmed, not one-click (#154)", () => {
  beforeEach(() => render(<CalendarFeed url={URL_A} />));

  it("asks first, and says what breaks", async () => {
    await userEvent.click(screen.getByRole("button", { name: /regenerate/i }));
    const confirm = await screen.findByRole("button", {
      name: /yes, regenerate/i,
    });
    // Not "are you sure" — it names the consequence, which is the part that is
    // invisible otherwise: nothing errors, a calendar just stops updating.
    expect(questionFor(confirm)).toMatch(/stop updating/i);
    expect(regenerateMock).not.toHaveBeenCalled();
  });

  it("regenerates once confirmed", async () => {
    await userEvent.click(screen.getByRole("button", { name: /regenerate/i }));
    await userEvent.click(
      await screen.findByRole("button", { name: /yes, regenerate/i }),
    );
    await waitFor(() => expect(regenerateMock).toHaveBeenCalledTimes(1));
    expect(refreshMock).toHaveBeenCalled();
  });

  it("cancels without touching anything, and returns focus to the trigger", async () => {
    const trigger = screen.getByRole("button", { name: /regenerate/i });
    await userEvent.click(trigger);
    await userEvent.click(
      await screen.findByRole("button", { name: /cancel/i }),
    );

    expect(regenerateMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /regenerate/i }),
      ),
    );
  });
});

describe("turning the feed off is confirmed too (#154)", () => {
  beforeEach(() => render(<CalendarFeed url={URL_A} />));

  it("asks first, and says what breaks", async () => {
    await userEvent.click(screen.getByRole("button", { name: /turn off/i }));
    const confirm = await screen.findByRole("button", {
      name: /yes, turn it off/i,
    });
    expect(questionFor(confirm)).toMatch(/stop updating/i);
    expect(disableMock).not.toHaveBeenCalled();
  });

  it("turns it off once confirmed", async () => {
    await userEvent.click(screen.getByRole("button", { name: /turn off/i }));
    await userEvent.click(
      await screen.findByRole("button", { name: /yes, turn it off/i }),
    );
    await waitFor(() => expect(disableMock).toHaveBeenCalledTimes(1));
    expect(refreshMock).toHaveBeenCalled();
  });

  it("two questions can never be open at once", async () => {
    // Opening one confirmation replaces both triggers, the way Disconnect does
    // in `integrations-panel.tsx`. Two destructive questions side by side is how
    // somebody answers the wrong one.
    await userEvent.click(screen.getByRole("button", { name: /turn off/i }));
    expect(screen.queryByRole("button", { name: /^regenerate/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^turn off/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /yes, turn it off/i }),
    ).toBeTruthy();
  });
});

describe("accessibility of the controls (#154)", () => {
  it("draws a focus RING rather than swapping a background (WCAG 2.4.7)", () => {
    // #109 / #117 — the class of failure the automated gates structurally
    // cannot see, so it is asserted here instead.
    render(<CalendarFeed url={URL_A} />);
    for (const control of [
      field(),
      copyButton(),
      screen.getByRole("button", { name: /regenerate/i }),
      screen.getByRole("button", { name: /turn off/i }),
    ]) {
      expect(control.className).toMatch(/focus-visible:ring-2/);
    }
  });

  it("gives every icon aria-hidden, so no decorative glyph is announced", () => {
    const { container } = render(<CalendarFeed url={URL_A} />);
    for (const svg of container.querySelectorAll("svg")) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("keeps the confirmation question associated with the button answering it", async () => {
    render(<CalendarFeed url={URL_A} />);
    await userEvent.click(screen.getByRole("button", { name: /turn off/i }));
    const confirm = await screen.findByRole("button", {
      name: /yes, turn it off/i,
    });
    const questionId = confirm.getAttribute("aria-describedby");
    expect(questionId).toBeTruthy();
    expect(document.getElementById(questionId!)?.textContent).toMatch(/\?$/);
  });
});

describe("the explanation of what the feed carries (#154)", () => {
  it("names what is in it and what is not", () => {
    // The security note on the issue: the URL ends up in a calendar provider's
    // logs, so the feed carries step titles and times and nothing more. Saying
    // so is what lets somebody decide whether they want it at all.
    render(<CalendarFeed url={URL_A} />);
    const card = screen.getByTestId("calendar-feed-card");
    expect(within(card).getByText(/titles and times/i)).toBeTruthy();
  });
});
