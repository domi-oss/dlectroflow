// @vitest-environment jsdom
/**
 * #212 — "Back to inbox" in the breakdown editor dropped a step's text if the
 * write failed.
 *
 * The control is a per-step **eject**, not navigation: it takes one row out of
 * the unsaved proposal and captures its text as a fresh inbox item, staying on
 * the breakdown page. The old handler removed the row FIRST and then fired
 * `createBrainDumpItem` with an explicit `void`, so a rejection was discarded by
 * design — and because a proposal's steps are not persisted until the breakdown
 * is confirmed, that row's text existed nowhere else. Offline, a hung pod or a
 * deploy mid-session and the words were gone with nothing on screen saying so.
 *
 * The same shape #210 fixed for the capture bar and !294 for the shopping list:
 * an irreversible local delete sequenced before an unguarded server write. The
 * remedy here is the stronger one those two could not use — the row IS the
 * user's copy of the words and it is an editable field they are looking at, so
 * it simply stays put until the server confirms. Nothing has to be restored,
 * and nothing has to guess whether the user has since typed over it.
 *
 * Every other spec in `breakdown-chat.test.tsx` mocks `createBrainDumpItem` as
 * resolving, which is exactly why this survived — so these drive it the other
 * way.
 *
 * The last two blocks are Duo's review of !304, which found that the first cut
 * used the row's WORDS as its identity — the only thing available before the
 * editor minted keys. Both findings are that one fact: the words are not stable
 * across an edit, and they are not unique across rows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BreakdownChat,
  EJECT_TIMEOUT_MS,
  settledEject,
} from "@/components/breakdown/breakdown-chat";
// The module is mocked below; this binding is the mock, which is what the specs
// asserting on what crosses the wire need.
import { confirmBreakdown } from "@/app/actions/breakdown";
import type { Proposal } from "@/lib/breakdown";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/voice-provider", () => ({ useVoice: () => "plain" }));
vi.mock("@/app/actions/breakdown", () => ({
  confirmBreakdown: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/app/actions/google-schedule", () => ({
  pushStepsToGoogleTasks: vi.fn().mockResolvedValue({ ok: true, scheduled: 0 }),
}));
vi.mock("@/app/actions/ics-schedule", () => ({ scheduleViaIcs: vi.fn() }));
vi.mock("@/lib/download-ics", () => ({ downloadIcs: vi.fn() }));

const { createBrainDumpItem } = vi.hoisted(() => ({
  createBrainDumpItem: vi.fn(),
}));
vi.mock("@/app/actions/braindump", () => ({ createBrainDumpItem }));

const proposal: Proposal = {
  parentEmoji: "🗂️",
  steps: [
    { text: "First step", estMinutes: 10, subtaskEmoji: "🌱" },
    { text: "Second step", estMinutes: 15, subtaskEmoji: "🚀" },
  ],
};

beforeEach(() => {
  // #168's hazard: `vi.clearAllMocks()` resets calls but NOT implementations, so
  // a `mockRejectedValue` set by one spec would leak into the next. Reset the
  // implementation explicitly and let each spec state its own.
  createBrainDumpItem.mockReset();
  createBrainDumpItem.mockResolvedValue(undefined);
  vi.mocked(confirmBreakdown).mockClear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ body: null }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderChat(initial: Proposal = proposal) {
  return render(
    <BreakdownChat
      taskId="task-1"
      title="Plan the party"
      initialProposal={initial}
      google={{ configured: false, connected: false, needsReconnect: false }}
    />,
  );
}

const stepTexts = () =>
  screen
    .queryAllByLabelText("Step text")
    .map((el) => (el as HTMLInputElement).value);

/** The rows' estimates — the only thing telling two same-worded rows apart. */
const stepMinutes = () =>
  screen
    .queryAllByLabelText("Estimated minutes")
    .map((el) => (el as HTMLInputElement).value);

/** A hand-controlled `createBrainDumpItem` call: resolve or reject on cue. */
function deferWrite() {
  let settle!: () => void;
  let fail!: (e: unknown) => void;
  createBrainDumpItem.mockReturnValueOnce(
    new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    }),
  );
  const flush = async (run: () => void) => {
    await act(async () => {
      run();
      await Promise.resolve();
    });
  };
  return {
    settle: () => flush(settle),
    fail: (e: unknown) => flush(() => fail(e)),
  };
}

/** The first row's eject control, whichever state it is in. */
const ejectButton = (n = 0) =>
  screen.getAllByTitle(
    "Send back to the inbox as its own item to re-break-down",
  )[n];

/**
 * Replaces the `ejectedStepIndex` block !304 opened with.
 *
 * That function answered "which row says these words, preferring the index the
 * press came from", and three of its five specs pinned behaviour the review
 * retired rather than behaviour that regressed: preferring the hint, falling
 * back to a text match, and matching on trimmed text to FIND a row. Duo's two
 * findings are both that question being unanswerable — the words are neither
 * stable across an edit nor unique across rows. The two specs that were about
 * refusing to guess ("no such row" and the empty list) survive verbatim in
 * meaning, as `gone`.
 */
describe("settledEject — what a settled eject does to the list", () => {
  const steps = (...rows: [key: string, text: string][]) =>
    rows.map(([key, text]) => ({ key, text }));

  it("finds the row by its key, never by its words", () => {
    // Both rows say the same thing; only the key says which one was pressed.
    expect(
      settledEject(
        steps(["a", "Email the venue"], ["b", "Email the venue"]),
        "b",
        "Email the venue",
      ),
    ).toEqual({ kind: "remove", at: 1 });
  });

  it("finds the row wherever it has been dragged to since", () => {
    expect(
      settledEject(steps(["b", "second"], ["a", "first"]), "a", "first"),
    ).toEqual({
      kind: "remove",
      at: 1,
    });
  });

  it("compares trimmed text, because that is what was sent", () => {
    expect(settledEject(steps(["a", "  hello  "]), "a", "hello")).toEqual({
      kind: "remove",
      at: 0,
    });
  });

  it("says `edited` when the row is still there but says something else", () => {
    // Keeping the row is the point: it holds words the user typed while the
    // write was in the air, and the inbox holds the ones that were sent.
    expect(settledEject(steps(["a", "hello there"]), "a", "hello")).toEqual({
      kind: "edited",
      at: 0,
    });
  });

  it("says `gone` when that row is no longer in the list", () => {
    // The user deleted the row themselves while the write was outstanding.
    // Removing some other row would be the data loss this fix exists to stop —
    // and `gone` is deliberately not `edited`, because deleting it is what they
    // asked for and needs no announcement.
    expect(settledEject(steps(["b", "hello"]), "a", "hello")).toEqual({
      kind: "gone",
    });
  });

  it("says `gone` for an empty list", () => {
    expect(settledEject([], "a", "hello")).toEqual({ kind: "gone" });
  });
});

describe("BreakdownChat — a step eject that fails (#212)", () => {
  it("keeps the row when the write rejects, and says so", async () => {
    createBrainDumpItem.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(/couldn't send that to your inbox/i);
    // The words are quoted, so the notice is itself a copy of them even if the
    // user goes on to delete the row.
    expect(notice).toHaveTextContent(/First step/);
    // …and the row is still there, editable, exactly where it was.
    expect(stepTexts()).toEqual(["First step", "Second step"]);
  });

  it("does not remove the row until the write has actually landed", async () => {
    let settle!: () => void;
    createBrainDumpItem.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));
    // Mid-flight: the words are still on screen. This is the whole fix — the old
    // code had already dropped them by now.
    expect(stepTexts()).toEqual(["First step", "Second step"]);

    await act(async () => {
      settle();
      await Promise.resolve();
    });

    await waitFor(() => expect(stepTexts()).toEqual(["Second step"]));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers a Reload and no Retry when the bundle is stale", async () => {
    // A retry re-posts the same server-action id the running deployment has
    // already forgotten, so it can only fail the same way.
    const stale = new Error('Failed to find Server Action "40bef5efc6c8".');
    createBrainDumpItem.mockRejectedValue(stale);
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));

    expect(await screen.findByRole("alert")).toHaveTextContent(/app updated/i);
    expect(
      screen.getByRole("button", { name: /reload the page/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    expect(stepTexts()).toEqual(["First step", "Second step"]);
  });

  it("surfaces a write that never answers, once EJECT_TIMEOUT_MS elapses", async () => {
    vi.useFakeTimers();
    createBrainDumpItem.mockReturnValueOnce(new Promise<void>(() => {}));
    renderChat();

    // `fireEvent`, not `userEvent`: userEvent's own internal delays run on the
    // faked clock and never resolve while this test owns it.
    fireEvent.click(ejectButton(0));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(stepTexts()).toEqual(["First step", "Second step"]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EJECT_TIMEOUT_MS);
    });

    const notice = screen.getByRole("alert");
    // The verdict is genuinely unknown — a server action cannot be aborted from
    // the client, so the insert may still land. Claiming it did not would be the
    // same unverifiable statement, pointing the other way.
    expect(notice).toHaveTextContent(/may already be in your inbox/i);
    expect(notice).not.toHaveTextContent(/couldn't send that/i);
    // Keeping the row is the safe direction: a duplicate inbox item is one tap
    // to delete, a step nobody wrote down is not recoverable at all.
    expect(stepTexts()).toEqual(["First step", "Second step"]);
  });

  it("retries the same words and removes the row once they land", async () => {
    createBrainDumpItem.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));
    await screen.findByRole("alert");

    createBrainDumpItem.mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(createBrainDumpItem).toHaveBeenLastCalledWith("First step");
    expect(stepTexts()).toEqual(["Second step"]);
  });

  it("keeps Retry focusable while it runs — aria-disabled, never disabled", async () => {
    // WCAG 2.4.3: a `disabled` element cannot hold focus, so the browser drops
    // the user to <body> the moment the retry starts.
    createBrainDumpItem.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    renderChat();
    await user.click(ejectButton(0));
    await screen.findByRole("alert");

    let settle!: () => void;
    createBrainDumpItem.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    const retry = screen.getByRole("button", { name: /try again/i });
    await user.click(retry);

    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).not.toBeDisabled();
    expect(retry).toHaveFocus();

    await act(async () => {
      settle();
      await Promise.resolve();
    });
  });

  it("does not post twice when Retry is pressed again mid-flight", async () => {
    createBrainDumpItem.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    renderChat();
    await user.click(ejectButton(0));
    await screen.findByRole("alert");

    let settle!: () => void;
    createBrainDumpItem.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    const retry = screen.getByRole("button", { name: /try again/i });
    await user.click(retry);
    await user.click(retry);

    expect(createBrainDumpItem).toHaveBeenCalledTimes(2);

    await act(async () => {
      settle();
      await Promise.resolve();
    });
  });

  it("does not post twice when the row's own control is pressed again mid-flight", async () => {
    let settle!: () => void;
    createBrainDumpItem.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));
    await user.click(ejectButton(0));
    expect(createBrainDumpItem).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle();
      await Promise.resolve();
    });
  });

  it("shows the row's own control as busy while its write is outstanding", async () => {
    let settle!: () => void;
    createBrainDumpItem.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));
    // #169's harm was a press that produced nothing visible for as long as the
    // request hung. `aria-disabled` + `aria-busy`, never `disabled`, so the
    // control the user just pressed keeps focus.
    expect(ejectButton(0)).toHaveAttribute("aria-disabled", "true");
    expect(ejectButton(0)).toHaveAttribute("aria-busy", "true");
    expect(ejectButton(0)).not.toBeDisabled();
    // Only that row. A list-wide flag was #169.
    expect(ejectButton(1)).not.toHaveAttribute("aria-disabled", "true");

    await act(async () => {
      settle();
      await Promise.resolve();
    });
  });

  it("never nests a polite live region inside the assertive notice (#218)", async () => {
    createBrainDumpItem.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    renderChat();
    await user.click(ejectButton(0));
    const notice = await screen.findByRole("alert");

    let settle!: () => void;
    createBrainDumpItem.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    await user.click(screen.getByRole("button", { name: /try again/i }));

    // The wait rides `aria-describedby` off the pressed button instead — a
    // polite region inside an assertive one has no defined announcement.
    expect(notice.querySelector('[role="status"]')).toBeNull();
    expect(notice.querySelector("[aria-live]")).toBeNull();
    const retry = screen.getByRole("button", { name: /try again/i });
    const described = retry.getAttribute("aria-describedby")!.split(" ");
    expect(described.length).toBe(2);
    expect(
      described.map((id) => document.getElementById(id)?.textContent).join(" "),
    ).toMatch(/Sending…/);

    await act(async () => {
      settle();
      await Promise.resolve();
    });
  });

  it("carries the failure in text and an icon, not in colour alone (WCAG 1.4.1)", async () => {
    createBrainDumpItem.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    renderChat();
    await user.click(ejectButton(0));

    const notice = await screen.findByRole("alert");
    expect(notice.className).toContain("border-destructive/40");
    expect(notice.textContent).toMatch(/couldn't send that to your inbox/i);
    expect(notice.querySelector("svg")).not.toBeNull();
  });

  it("hands focus on, rather than to <body>, when the pressed row disappears", async () => {
    // WCAG 2.4.3: the control the user pressed unmounts with its row, so focus
    // has to go somewhere deliberate — the control that took its place.
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));

    await waitFor(() => expect(stepTexts()).toEqual(["Second step"]));
    expect(document.activeElement).not.toBe(document.body);
    expect(ejectButton(0)).toHaveFocus();
  });

  it("an empty row still just goes, with no write and no notice", async () => {
    const user = userEvent.setup();
    renderChat();
    await user.click(screen.getByRole("button", { name: "Add a step" }));
    expect(stepTexts()).toEqual(["First step", "Second step", ""]);

    await user.click(ejectButton(2));

    expect(createBrainDumpItem).not.toHaveBeenCalled();
    expect(stepTexts()).toEqual(["First step", "Second step"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/**
 * Duo review of !304, finding 1 — a row edited while its OWN eject is still in
 * flight.
 *
 * The first cut of #212 keyed the in-flight set and the "which row was this
 * about" lookup by the row's WORDS, because a proposed step has no id. Editing
 * the row changes the key out from under its own outstanding write, and all
 * three consequences below follow from that one fact.
 */
describe("BreakdownChat — a row edited mid-eject (!304 review)", () => {
  it("keeps the row's own control busy after the text is edited", async () => {
    const write = deferWrite();
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));
    await user.type(screen.getAllByLabelText("Step text")[0], " (revised)");

    // The write for these words is still outstanding, so the control that
    // started it must still say so — the row's identity is the row, not the
    // characters currently in its box.
    expect(ejectButton(0)).toHaveAttribute("aria-busy", "true");
    expect(ejectButton(0)).toHaveAttribute("aria-disabled", "true");
    expect(ejectButton(0)).toHaveTextContent("Sending…");

    await write.settle();
  });

  it("cannot be pressed a second time once the text has changed", async () => {
    // The duplicate-post path finding 1 opens: the guard is keyed by the words,
    // the words changed, so the second press sails past it and inserts again.
    const write = deferWrite();
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));
    await user.type(screen.getAllByLabelText("Step text")[0], " (revised)");
    await user.click(ejectButton(0));

    expect(createBrainDumpItem).toHaveBeenCalledTimes(1);
    expect(createBrainDumpItem).toHaveBeenCalledWith("First step");

    await write.settle();
  });

  it("keeps the edited row and says which wording reached the inbox", async () => {
    const write = deferWrite();
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));
    await user.type(screen.getAllByLabelText("Step text")[0], " (revised)");
    await write.settle();

    // The row is NOT removed. Removing it would destroy the words the user
    // typed while waiting, and the inbox holds the pre-edit copy — the same
    // data loss this issue is about, wearing the other hat. `inbox-view.tsx`
    // takes the identical line for the capture bar: restore "ONLY into a field
    // the user has not since typed into".
    expect(stepTexts()).toEqual(["First step (revised)", "Second step"]);
    // But it must not be silent: the user pressed a control, an item they
    // cannot see landed in their inbox, and the row in front of them now says
    // something else. Polite, not assertive — nothing failed.
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(/earlier wording/i);
    expect(notice).toHaveTextContent(/First step/);
    // No Retry: the write succeeded, so re-posting would make a real duplicate.
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /got it/i }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says nothing when the user deleted the row themselves mid-flight", async () => {
    // "Gone" and "edited" are different answers, and only the key can tell them
    // apart — deleting the row IS the outcome the user asked for, so a notice
    // here would be noise.
    const write = deferWrite();
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));
    await user.click(screen.getAllByTitle("Remove this step")[0]);
    await write.settle();

    expect(stepTexts()).toEqual(["Second step"]);
    expect(createBrainDumpItem).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("never lets the editor's row identity reach the server or the model", async () => {
    // The identity is a client-side concern. `buildUserPrompt` splices the
    // proposal into the prompt with `JSON.stringify`, so a key riding along
    // would be spent tokens and an identifier in a payload that is explicitly
    // free of them (see `BreakdownContext`'s privacy note).
    const user = userEvent.setup();
    renderChat();

    await user.click(screen.getByRole("button", { name: "More steps" }));
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const sent = JSON.parse(String(init?.body)) as {
      currentProposal: { steps: Record<string, unknown>[] };
    };
    for (const step of sent.currentProposal.steps) {
      expect(Object.keys(step).sort()).toEqual([
        "estMinutes",
        "subtaskEmoji",
        "text",
      ]);
    }

    await user.click(screen.getByRole("button", { name: "Looks right" }));
    await waitFor(() => expect(confirmBreakdown).toHaveBeenCalled());
    const [, confirmed] = vi.mocked(confirmBreakdown).mock.calls[0];
    for (const step of confirmed.steps as Record<string, unknown>[]) {
      expect(Object.keys(step).sort()).toEqual([
        "estMinutes",
        "subtaskEmoji",
        "text",
      ]);
    }
  });
});

/**
 * Duo review of !304, finding 2 — two rows that say exactly the same thing.
 *
 * A plan legitimately repeats itself ("Email the venue" twice, a week apart),
 * and with the words as the key those two rows are one row as far as every
 * eject decision is concerned.
 */
describe("BreakdownChat — rows sharing identical text (!304 review)", () => {
  const twins: Proposal = {
    parentEmoji: "🗂️",
    steps: [
      // Same words, different estimates — the estimate is the only thing that
      // can tell the assertions below which of the two survived.
      { text: "Email the venue", estMinutes: 10, subtaskEmoji: "✉️" },
      { text: "Email the venue", estMinutes: 25, subtaskEmoji: "✉️" },
      { text: "Book the cake", estMinutes: 15, subtaskEmoji: "🎂" },
    ],
  };

  it("busies only the row that was pressed", async () => {
    const write = deferWrite();
    const user = userEvent.setup();
    renderChat(twins);

    await user.click(ejectButton(0));

    expect(ejectButton(0)).toHaveAttribute("aria-busy", "true");
    expect(ejectButton(1)).not.toHaveAttribute("aria-busy", "true");
    expect(ejectButton(1)).not.toHaveAttribute("aria-disabled", "true");
    expect(ejectButton(1)).toHaveTextContent("Back to inbox");

    await write.settle();
  });

  it("does not swallow a press on the second row", async () => {
    const first = deferWrite();
    const second = deferWrite();
    const user = userEvent.setup();
    renderChat(twins);

    await user.click(ejectButton(0));
    await user.click(ejectButton(1));

    // Two rows, two independent inserts. Refusing the second is the silent
    // discard #169 exists to stop — the user presses and nothing happens, ever.
    expect(createBrainDumpItem).toHaveBeenCalledTimes(2);

    await first.settle();
    await second.settle();
    await waitFor(() => expect(stepTexts()).toEqual(["Book the cake"]));
  });

  it("removes the row that was pressed, not its twin", async () => {
    const write = deferWrite();
    const user = userEvent.setup();
    renderChat(twins);

    await user.click(ejectButton(1));
    await write.settle();

    await waitFor(() =>
      expect(stepTexts()).toEqual(["Email the venue", "Book the cake"]),
    );
    // The 25-minute twin is the one that went.
    expect(stepMinutes()).toEqual(["10", "15"]);
  });

  it("does not let one twin's success clear the other twin's failure", async () => {
    const failing = deferWrite();
    const user = userEvent.setup();
    renderChat(twins);

    await user.click(ejectButton(0));
    await failing.fail(new Error("offline"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't send that to your inbox/i,
    );

    const ok = deferWrite();
    await user.click(ejectButton(1));
    await ok.settle();

    // Row 1 landing says nothing about row 0, whose words never arrived. The
    // notice is the only thing on screen reporting that.
    await waitFor(() =>
      expect(stepTexts()).toEqual(["Email the venue", "Book the cake"]),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /couldn't send that to your inbox/i,
    );
  });
});
