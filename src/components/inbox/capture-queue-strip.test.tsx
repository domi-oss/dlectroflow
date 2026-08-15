// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CaptureQueueStrip } from "@/components/inbox/capture-queue-strip";
import type { CaptureQueueApi, DiscardOutcome } from "@/lib/use-capture-queue";
import type { QueuedCapture, StrandedGroup } from "@/lib/capture-queue";

/**
 * #175 — the strip's own contract.
 *
 * The two live regions are deliberately NOT here — they are siblings in
 * `inbox-view.tsx`, so `write-notice-hygiene`'s rules D and E can see them (both
 * reason about one file's JSX tree). What this file owns is everything the guards
 * cannot see: which words are shown, which are not, and where focus goes.
 */

const LIVE = "ws-live";

function capture(over: Partial<QueuedCapture> = {}): QueuedCapture {
  return {
    clientKey: "k1",
    text: "ring mum about the boiler",
    workspaceId: LIVE,
    capturedAt: 1_000,
    ...over,
  };
}

function api(over: Partial<CaptureQueueApi> = {}): CaptureQueueApi {
  return {
    mine: [],
    stranded: [],
    flushing: false,
    inFlight: () => false,
    enqueueCapture: () => ({ ok: true, clientKey: "k-new" }),
    flush: vi.fn().mockResolvedValue({ saved: [] }),
    discard: vi.fn().mockResolvedValue("discarded" as DiscardOutcome),
    announcement: null,
    clearAnnouncement: () => {},
    savedTicket: 0,
    ...over,
  };
}

function strip(over: Partial<CaptureQueueApi> = {}, onReturnFocus = vi.fn()) {
  const value = api(over);
  render(
    <CaptureQueueStrip
      api={value}
      voice="plain"
      savingRegionId="saving-region"
      now={100_000}
      onReturnFocus={onReturnFocus}
    />,
  );
  return { value, onReturnFocus };
}

beforeEach(() => vi.clearAllMocks());
// `render` appends to document.body and nothing cleans it up globally — the
// repo's convention is an explicit `afterEach(cleanup)` per jsdom file.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("capture queue strip — content is conditional, height is zero (#175)", () => {
  it("renders nothing at all when nothing is waiting", () => {
    strip();
    expect(screen.queryByTestId("capture-queue-strip")).not.toBeInTheDocument();
  });

  it("names the count without expanding anything", () => {
    strip({ mine: [capture({ clientKey: "a" }), capture({ clientKey: "b" })] });

    expect(
      screen.getByRole("button", { name: /2 waiting to save/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("ring mum about the boiler"),
    ).not.toBeInTheDocument();
  });

  it("tracks aria-expanded on the toggle, both values", async () => {
    // WCAG 4.1.2. The strip's premise is that the words stay readable on demand,
    // so a toggle that does not report its state leaves a screen-reader user
    // unable to tell whether the queue is on screen.
    strip({ mine: [capture()] });
    const toggle = screen.getByRole("button", { name: /1 waiting to save/ });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the words and their age once expanded", async () => {
    strip({ mine: [capture({ capturedAt: 40_000 })] });
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );

    expect(screen.getByText("ring mum about the boiler")).toBeInTheDocument();
    expect(screen.getByText("1m ago")).toBeInTheDocument();
  });
});

describe("capture queue strip — a stranded group is counted, never revealed (#175)", () => {
  const group = (over: Partial<StrandedGroup> = {}): StrandedGroup => ({
    state: "unmarked",
    count: 2,
    clientKeys: ["x", "y"],
    ...over,
  });

  it("shows a count and no text for another session's captures", async () => {
    strip({ stranded: [group()] });
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );

    expect(
      screen.getByText(/2 captures from an earlier sign-in/),
    ).toBeInTheDocument();
  });

  it("offers the sign-in on a session-expired group", async () => {
    strip({ stranded: [group({ state: "session-expired" })] });
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );

    expect(screen.getByText(/Sign in and these will save/)).toBeInTheDocument();
  });

  it("withdraws the sign-in once the session has changed", async () => {
    // The remedy has been taken and did not work, so the copy must stop
    // repeating it. Without this arm, a strip that always offers the sign-in
    // passes the test above.
    strip({ stranded: [group({ state: "session-changed" })] });
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );

    expect(
      screen.getByText(/can't be saved to this account any more/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Sign in and these will save/),
    ).not.toBeInTheDocument();
  });

  it("says signing in will not help a revoked account", async () => {
    strip({ stranded: [group({ state: "account-revoked" })] });
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );

    expect(
      screen.getByText(/This account can no longer save/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Sign in and these will save/),
    ).not.toBeInTheDocument();
  });

  it("names its discard control by the COUNT, never by any text", async () => {
    // The whole point of this control is that the words cannot be shown, so the
    // confirm is made against the count instead.
    strip({ stranded: [group({ count: 3 })] });
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Discard: 3" }));

    expect(
      screen.getByRole("button", { name: "Discard for good: 3" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/The words can't be shown/)).toBeInTheDocument();
  });

  it("discards a whole group by its keys", async () => {
    const { value } = strip({ stranded: [group({ clientKeys: ["x", "y"] })] });
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: /^Discard: / }));
    await userEvent.click(
      screen.getByRole("button", { name: /^Discard for good: / }),
    );

    expect(value.discard).toHaveBeenCalledWith(["x", "y"]);
  });
});

describe("capture queue strip — Retry (#175)", () => {
  it("fires a flush", async () => {
    const { value } = strip({ mine: [capture()] });
    await userEvent.click(screen.getByRole("button", { name: "Retry now" }));

    expect(value.flush).toHaveBeenCalledTimes(1);
  });

  it("takes aria-disabled while a flush is in flight, not disabled", async () => {
    // A `disabled` element cannot hold focus, so the browser would drop it to
    // <body> the moment the flush starts.
    strip({ mine: [capture()], flushing: true });
    const retry = screen.getByRole("button", { name: "Retry now" });

    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).not.toBeDisabled();
  });

  it("Enter on an aria-disabled Retry fires NOTHING", async () => {
    // ⚠️ The attribute is not the control. Asserted by counting flushes rather
    // than by reading the DOM, because the attribute is what a test that only
    // checks markup sees — and it does not stop activation.
    const { value } = strip({ mine: [capture()], flushing: true });
    const retry = screen.getByRole("button", { name: "Retry now" });
    retry.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    await userEvent.click(retry);

    expect(value.flush).not.toHaveBeenCalled();
  });

  it("describes Retry with the polite region, so the wait is reachable on focus", () => {
    strip({ mine: [capture()] });
    expect(screen.getByRole("button", { name: "Retry now" })).toHaveAttribute(
      "aria-describedby",
      "saving-region",
    );
  });
});

describe("capture queue strip — Discard takes a two-step confirm (#175)", () => {
  it("does not reach the network on the first press", async () => {
    const { value } = strip({ mine: [capture()] });
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Discard: ring mum/ }),
    );

    expect(value.discard).not.toHaveBeenCalled();
    expect(value.flush).not.toHaveBeenCalled();
  });

  it("moves focus into the confirm, so it is not invisible until hunted for", async () => {
    strip({ mine: [capture()] });
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Discard: ring mum/ }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Discard for good: ring mum/ }),
      ).toHaveFocus(),
    );
  });

  it("names the confirm by what is being discarded", async () => {
    strip({ mine: [capture({ text: "find the passport" })] });
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Discard: find the passport" }),
    );

    expect(
      screen.getByRole("button", {
        name: "Discard for good: find the passport",
      }),
    ).toBeInTheDocument();
    // Not a delete from the server: a discarded capture was never saved, and the
    // copy must not imply either.
    expect(screen.getByText(/They were never saved/)).toBeInTheDocument();
  });

  it("discards exactly one entry", async () => {
    const { value } = strip({
      mine: [
        capture({ clientKey: "a" }),
        capture({ clientKey: "b", text: "second" }),
      ],
    });
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Discard: second/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Discard for good: second/ }),
    );

    expect(value.discard).toHaveBeenCalledWith(["b"]);
  });

  it("returns focus to the Discard control on cancel", async () => {
    // A cancel that drops focus is the same defect arriving on the path where
    // the user chose to change nothing.
    strip({ mine: [capture()] });
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Discard: ring mum/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Discard: ring mum/ }),
      ).toHaveFocus(),
    );
  });

  it("refuses without a confirm when a POST is already in flight for that entry", async () => {
    // Said rather than the control silently disabled: the flush is bounded by
    // CAPTURE_FLUSH_TIMEOUT_MS, so the wait is short and nameable. This is the
    // courtesy check — the guard is the hook's re-check at confirm-resolution.
    const { value } = strip({
      mine: [capture()],
      inFlight: () => true,
    });
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Discard: ring mum/ }),
    );

    expect(value.discard).toHaveBeenCalledWith(["k1"]);
    expect(
      screen.queryByRole("button", { name: /^Discard for good/ }),
    ).not.toBeInTheDocument();
  });

  it("moves focus to a NAMED control after a discard, never to <body>", async () => {
    // Entry 1 of 3, where the strip stays mounted — so the unmount path never
    // runs and the browser would otherwise drop focus to <body> (WCAG 2.4.3).
    // Asserted after the list re-renders without the entry.
    const entries = [
      capture({ clientKey: "a", text: "first" }),
      capture({ clientKey: "b", text: "second" }),
      capture({ clientKey: "c", text: "third" }),
    ];
    const value = api({ mine: entries });
    const { rerender } = render(
      <CaptureQueueStrip
        api={value}
        voice="plain"
        savingRegionId="saving-region"
        now={100_000}
        onReturnFocus={vi.fn()}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Discard: second/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Discard for good: second/ }),
    );

    rerender(
      <CaptureQueueStrip
        api={api({ mine: [entries[0]!, entries[2]!] })}
        voice="plain"
        savingRegionId="saving-region"
        now={100_000}
        onReturnFocus={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
      expect(
        screen.getByRole("button", { name: /^Discard: third/ }),
      ).toHaveFocus();
    });
  });

  it("hands focus back to the capture input when the strip is about to unmount", async () => {
    const onReturnFocus = vi.fn();
    const value = api({ mine: [capture()] });
    const { rerender } = render(
      <CaptureQueueStrip
        api={value}
        voice="plain"
        savingRegionId="saving-region"
        now={100_000}
        onReturnFocus={onReturnFocus}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Discard: ring mum/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Discard for good/ }),
    );

    rerender(
      <CaptureQueueStrip
        api={api({ mine: [] })}
        voice="plain"
        savingRegionId="saving-region"
        now={100_000}
        onReturnFocus={onReturnFocus}
      />,
    );

    await waitFor(() => expect(onReturnFocus).toHaveBeenCalled());
  });

  /**
   * Duo review round 2 on `!348` — and it becomes reachable the moment the strip
   * has a caller, which is what this MR's wiring does.
   *
   * The hand-off effect was keyed on `[confirming, mine, stranded, onReturnFocus]`
   * and re-focused the confirm on **every** run where `confirming !== null`.
   * `mine`/`stranded` are derived arrays, so any re-render of whatever mounts the
   * hook changed their identity — and in `inbox-view.tsx` that includes **every
   * keystroke in the capture field**, because the input is controlled. So: open a
   * Discard confirm, click into the capture box, type one character, and focus is
   * yanked out of the box and back onto "Discard for good". WCAG 3.2.2 On Input —
   * an unrequested change of context — and it fires on the most ordinary keypress
   * in the app.
   *
   * Nothing here traps focus inside the confirm, deliberately: the user is allowed
   * to leave it and come back. That is precisely why re-focusing has to be keyed on
   * the confirm OPENING rather than on anything the queue derives.
   *
   * The sibling input stands in for the capture field. Asserting on a sibling
   * rather than on `document.body` is the point — dropping to `<body>` is the other
   * focus defect, and a test that only checked "focus left the confirm" would pass
   * on it.
   */
  it("does not re-steal focus to an open confirm on an unrelated re-render", async () => {
    const props = (over: Partial<CaptureQueueApi> = {}) => (
      <>
        <input aria-label="Brain dump" />
        <CaptureQueueStrip
          api={api({ mine: [capture()], ...over })}
          voice="plain"
          savingRegionId="saving-region"
          now={100_000}
          onReturnFocus={vi.fn()}
        />
      </>
    );
    const { rerender } = render(props());
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Discard: ring mum/ }),
    );
    const confirm = screen.getByRole("button", {
      name: /^Discard for good: ring mum/,
    });
    await waitFor(() => expect(confirm).toHaveFocus());

    // The user changes their mind about answering right now and goes back to
    // typing — the confirm stays open behind them, which is allowed.
    const input = screen.getByRole("textbox", { name: "Brain dump" });
    await userEvent.click(input);
    expect(input).toHaveFocus();

    // One keystroke in the capture field. Identical queue contents, fresh derived
    // arrays — exactly what the real hook hands down on every render.
    rerender(props());

    await waitFor(() => expect(input).toHaveFocus());
    expect(confirm).not.toHaveFocus();
  });

  /**
   * The non-vacuous control for the case above. Both assertions there are about
   * focus NOT moving, which is also what a strip that had stopped focusing its
   * confirm at all would produce — and that regression would reintroduce
   * "a confirm invisible to a screen reader until it is hunted for".
   *
   * So: the same unrelated re-render, with the confirm opened AFTER it. Focus must
   * still arrive.
   */
  it("still focuses a confirm opened after an unrelated re-render", async () => {
    const props = () => (
      <>
        <input aria-label="Brain dump" />
        <CaptureQueueStrip
          api={api({ mine: [capture()] })}
          voice="plain"
          savingRegionId="saving-region"
          now={100_000}
          onReturnFocus={vi.fn()}
        />
      </>
    );
    const { rerender } = render(props());
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );
    rerender(props());

    await userEvent.click(
      screen.getByRole("button", { name: /^Discard: ring mum/ }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Discard for good: ring mum/ }),
      ).toHaveFocus(),
    );
  });

  it("can empty a queue of 20 permanently-blocked entries back to a usable state", async () => {
    // The dead-end this control exists to prevent: without it a stranded long
    // capture consumes the origin-wide byte cap for ever, and the next offline
    // capture is refused with a wait for something that can never happen.
    const blocked = Array.from({ length: 20 }, (_, i) => `k${i}`);
    const value = api({
      stranded: [{ state: "account-revoked", count: 20, clientKeys: blocked }],
    });
    render(
      <CaptureQueueStrip
        api={value}
        voice="plain"
        savingRegionId="saving-region"
        now={100_000}
        onReturnFocus={vi.fn()}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Discard: 20" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Discard for good: 20" }),
    );

    expect(value.discard).toHaveBeenCalledWith(blocked);
  });
});

describe("capture queue strip — a restored refusal is static text (#175)", () => {
  it("renders the sentence with the entry rather than announcing it", async () => {
    // `blockedBy` is persisted so the reason survives the reload a discarded tab
    // forces, which means the assertive region would go empty→filled on EVERY
    // page load and interrupt with news of something that did not just happen.
    // Nothing in this component is a live region — that is the property.
    strip({ mine: [capture({ blockedBy: "account-revoked" })] });
    await userEvent.click(
      screen.getByRole("button", { name: /waiting to save/ }),
    );

    expect(
      screen.getByText(/This account can no longer save/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
