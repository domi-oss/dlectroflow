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
 * Blocks two and three are Duo's review of !304, which found that the first cut
 * used the row's WORDS as its identity — the only thing available before the
 * editor minted keys. Both findings are that one fact: the words are not stable
 * across an edit, and they are not unique across rows.
 *
 * The fourth block is the follow-up finding, on the notice those keys are shared
 * through: identity decided which row a notice BELONGS to, and one branch of the
 * updater was still writing to that single slot without asking.
 *
 * The last two blocks are the round after that, and they are the same shape once
 * more — a single slot shared by rows that can be in flight at the same time.
 * The notice's Retry is one button, so the ref pointing at it can be another
 * row's by the time an earlier retry lands; and "Looks right" was not asking
 * about in-flight ejects at all, so a row could be saved into the plan while its
 * own words were on their way to the inbox.
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

/** The confirm control — the one press that persists the whole plan. */
const confirmButton = () => screen.getByRole("button", { name: "Looks right" });

/**
 * The texts that reached BOTH destinations: the saved plan (`confirmBreakdown`)
 * and the inbox (`createBrainDumpItem`).
 *
 * A step's words belong in one or the other and never in both. The two are
 * unrelated records with no link between them, so a step in both is a duplicate
 * nothing in the app will ever reconcile — the user has to spot it and delete
 * one by hand, having been told about neither.
 *
 * The inbox side counts writes that **resolved**, not writes that were
 * attempted, and the distinction is the point rather than pedantry: an eject
 * that rejects put nothing in the inbox, so its row is the only copy of those
 * words and belongs in the saved plan. A write still pending is counted as
 * neither, which is the same thing the UI says out loud on a timeout — the
 * client cannot know, and asserting either way here would be inventing a fact.
 */
const inBothPlaces = () => {
  const planned = new Set(
    vi
      .mocked(confirmBreakdown)
      .mock.calls.flatMap(([, sent]) => sent.steps.map((s) => s.text.trim())),
  );
  const settled = createBrainDumpItem.mock.settledResults;
  const landed = (createBrainDumpItem.mock.calls as unknown[][])
    .filter((_, i) => settled[i]?.type === "fulfilled")
    .map((call) => String(call[0]));
  return [...new Set(landed.filter((text) => planned.has(text)))];
};

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

/**
 * Duo review of !304 (raised on the !311 scaffold) — the notice slot is one
 * slot, and one branch of the updater was writing to it without looking.
 *
 * The two branches above already agree that a notice belongs to the row it
 * names: a settled eject clears the notice only when it is that row's own. The
 * `edited` branch did not read `prev` at all, so a row diverging mid-flight
 * overwrote whatever was there — including another row's still-unresolved
 * failure, which is the one notice on screen carrying a Retry.
 *
 * Which way the slot goes is decided by what is lost. An `edited` notice
 * reports something already over — both copies are safe, and its only control
 * dismisses it — so displacing it costs an announcement. A failure notice is
 * the live state of an eject that has not happened yet, and displacing that
 * costs the user the action.
 */
describe("BreakdownChat — two rows contending for the notice (!311 review)", () => {
  it("does not let one row's mid-flight edit displace another's failure", async () => {
    const failing = deferWrite();
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));
    await failing.fail(new Error("offline"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't send that to your inbox/i,
    );

    // Row 1 now ejects and is edited while its write is in the air, so it
    // settles `edited` — an outcome that has nothing to say about row 0.
    const edited = deferWrite();
    await user.click(ejectButton(1));
    await user.type(screen.getAllByLabelText("Step text")[1], " (revised)");
    await edited.settle();

    // Both rows keep their words: row 0 because its write never landed, row 1
    // because it holds what the user typed while waiting.
    await waitFor(() =>
      expect(stepTexts()).toEqual(["First step", "Second step (revised)"]),
    );
    // And row 0's failure is still the notice, still quoting row 0's words.
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent(/couldn't send that to your inbox/i);
    expect(notice).toHaveTextContent(/First step/);
    expect(screen.queryByRole("status")).toBeNull();

    // Still actionable, and still aimed at row 0 — the point of keeping it.
    await user.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(stepTexts()).toEqual(["Second step (revised)"]));
    expect(createBrainDumpItem).toHaveBeenLastCalledWith("First step");
  });

  it("still replaces a row's own failure notice when that row diverges", async () => {
    // The guard is row identity, not "never overwrite": this row's own notice
    // is exactly the one an `edited` outcome supersedes, and leaving the
    // failure up would tell the user nothing arrived when it just did.
    createBrainDumpItem.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));
    await screen.findByRole("alert");

    // Retry re-sends the words the notice remembers, so editing the row first
    // makes that retry land on wording the row no longer says.
    await user.type(screen.getAllByLabelText("Step text")[0], " (revised)");
    const retried = deferWrite();
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await retried.settle();

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(/earlier wording/i);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(stepTexts()).toEqual(["First step (revised)", "Second step"]);
  });
});

/**
 * Duo review of !304, finding 1 — the Retry the ref points at is whichever
 * notice is up NOW, not the one whose retry is still in the air.
 *
 * The notice is one slot and its failure branch writes to that slot
 * unconditionally, deliberately: a failure reports a press the user just made,
 * and yielding to an older notice would leave that press with nothing visible.
 * So while one row's retry is outstanding, another row's eject can fail and take
 * the slot — and because the button is re-rendered rather than remounted, the
 * shared `retryEjectRef` still resolves to it and it still holds focus. Handing
 * focus onwards from there moves the user off a live Retry, for a row that left
 * the list somewhere else on the page (WCAG 3.2.2, and 2.4.3's spirit — focus
 * should follow the thing that went, not jump away from the thing that stayed).
 */
describe("BreakdownChat — a retry that outlives its own notice (!304 review)", () => {
  it("does not move focus off a Retry that now belongs to another row", async () => {
    // Row 1 goes first and hangs; row 0 goes second and fails outright, so the
    // notice is row 0's and row 1's write is still in the air behind it.
    const slow = deferWrite();
    createBrainDumpItem.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(1));
    await user.click(ejectButton(0));
    expect(await screen.findByRole("alert")).toHaveTextContent(/First step/);

    const retried = deferWrite();
    const retry = screen.getByRole("button", { name: /try again/i });
    await user.click(retry);
    expect(retry).toHaveFocus();

    // Row 1's write now fails, and its notice takes the slot. Same button, no
    // remount, so the user is still standing on it — but it is row 1's Retry.
    await slow.fail(new Error("offline"));
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent(/Second step/);
    expect(notice).not.toHaveTextContent(/First step/);
    expect(retry).toHaveFocus();

    // Row 0's retry lands and its row leaves the list. Nothing the user can see
    // has moved under them, so nothing should move their focus either.
    await retried.settle();
    await waitFor(() => expect(stepTexts()).toEqual(["Second step"]));
    expect(retry).toHaveFocus();
    // …and the control they are standing on still does what it says: row 1's
    // words never arrived, and this is the only thing on screen that can resend
    // them.
    const resent = deferWrite();
    await user.click(retry);
    expect(createBrainDumpItem).toHaveBeenLastCalledWith("Second step");
    await resent.settle();
  });

  it("still hands focus on when the Retry is the one that was pressed", async () => {
    // The guard is row identity, not "never move focus". A retry whose own row
    // is still the notice's row is the ordinary case, and there the pressed
    // control unmounts with the row — so focus has to go somewhere deliberate
    // rather than to <body> (WCAG 2.4.3).
    createBrainDumpItem.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    renderChat();
    await user.click(ejectButton(0));
    await screen.findByRole("alert");

    const retried = deferWrite();
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await retried.settle();

    await waitFor(() => expect(stepTexts()).toEqual(["Second step"]));
    expect(document.activeElement).not.toBe(document.body);
    expect(ejectButton(0)).toHaveFocus();
  });
});

/**
 * Duo review of !304, finding 2 — "Looks right" while a row's eject is still in
 * the air.
 *
 * #212's fix is that the row STAYS until the write lands, and `confirmBreakdown`
 * saves every row that has text. Put those together and a confirm across the gap
 * writes the step into the plan while the very same words are on their way to
 * the inbox: two copies, in two places nothing links, from one press. It is
 * worse than a visible duplicate, because the editor has been replaced by the
 * saved view by the time the write settles — the row removal lands on a screen
 * that is gone, and so does any notice that would have said a word about it.
 *
 * The remedy is the in-flight set the eject path already keeps, not a second
 * mechanism: while it is non-empty the press is refused and the control says
 * why, and the moment it drains the plan can be saved as before.
 */
describe("BreakdownChat — confirming mid-eject (!304 review)", () => {
  it("never puts the same step in the plan and the inbox at once", async () => {
    const write = deferWrite();
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));
    await user.click(confirmButton());
    await write.settle();

    expect(inBothPlaces()).toEqual([]);
  });

  it("saves the plan as soon as the eject has landed", async () => {
    // The gate is a wait, not a refusal — otherwise it would be its own trap.
    const write = deferWrite();
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));
    await user.click(confirmButton());
    expect(confirmBreakdown).not.toHaveBeenCalled();

    await write.settle();
    await waitFor(() => expect(stepTexts()).toEqual(["Second step"]));
    await user.click(confirmButton());

    await waitFor(() => expect(confirmBreakdown).toHaveBeenCalledTimes(1));
    const [, sent] = vi.mocked(confirmBreakdown).mock.calls[0];
    // The ejected row is in the inbox and nowhere else; the one left behind is
    // in the plan and nowhere else.
    expect(sent.steps.map((s) => s.text)).toEqual(["Second step"]);
    expect(createBrainDumpItem).toHaveBeenCalledExactlyOnceWith("First step");
    expect(inBothPlaces()).toEqual([]);
  });

  it("saves the plan again once a failed eject has settled, row and all", async () => {
    // Nothing reached the inbox, so the row is the only copy and belongs in the
    // plan. A gate that stayed up after a failure would strand it there.
    const write = deferWrite();
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));
    await write.fail(new Error("offline"));
    await screen.findByRole("alert");
    await user.click(confirmButton());

    await waitFor(() => expect(confirmBreakdown).toHaveBeenCalledTimes(1));
    const [, sent] = vi.mocked(confirmBreakdown).mock.calls[0];
    expect(sent.steps.map((s) => s.text)).toEqual([
      "First step",
      "Second step",
    ]);
    expect(inBothPlaces()).toEqual([]);
  });

  it("says why it is held, and stays focusable while it is (WCAG 2.4.3)", async () => {
    const write = deferWrite();
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));

    const confirm = confirmButton();
    // `aria-disabled`, never `disabled`: this button is disabled by a press on a
    // DIFFERENT control, so a real `disabled` can take focus out from under a
    // user standing on it and drop them to <body>.
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(confirm).not.toBeDisabled();
    // And the refusal is never silent (#169) — the reason rides
    // `aria-describedby`, the same mechanism the notice's Retry uses for its
    // in-flight line, rather than a second live region (#218).
    const describedBy = confirm.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(
      /still being sent to your inbox/i,
    );

    await write.settle();
    await waitFor(() => expect(stepTexts()).toEqual(["Second step"]));
    expect(confirmButton()).not.toHaveAttribute("aria-disabled", "true");
    expect(confirmButton().getAttribute("aria-describedby")).toBeNull();
  });
});

/**
 * Duo review of !304, round four — a control inside the notice that destroys the
 * notice, and with it itself.
 *
 * The same WCAG 2.4.3 shape !303 settled for `task-steps.tsx` and
 * `focus-timer.tsx`: `aria-disabled` covers a control that is merely HELD, and
 * can do nothing for one that ceases to exist. Round three swapped both eject
 * controls and the Retry to `aria-disabled` and stopped there, because the two
 * ways the notice can vanish under the user were not on the list.
 *
 * "Got it" is the plain one — its only job is `setEjectNotice(null)`, so the
 * press unmounts the button being pressed. The other arrives through finding 2's
 * path: a retry whose row the user deleted meanwhile settles `gone`, which
 * clears the notice, which takes the Retry with it.
 *
 * The case that LOOKS like a third and is not is pinned here too: a retry
 * settling `edited` swaps Retry for "Got it" in the same slot, and React updates
 * that `<button>` in place rather than remounting it, so focus never leaves. A
 * hand-off there would be a focus move with nothing to justify it (WCAG 3.2.2).
 */
describe("BreakdownChat — a notice control that unmounts itself (!304 review)", () => {
  /** Get to the `edited` notice: eject row 0, type into it mid-flight, land. */
  async function divergedRow0(user: ReturnType<typeof userEvent.setup>) {
    const write = deferWrite();
    await user.click(ejectButton(0));
    await user.type(screen.getAllByLabelText("Step text")[0], " (revised)");
    await write.settle();
    return screen.findByRole("status");
  }

  it("hands focus to the row's own control when Got it withdraws the notice", async () => {
    const user = userEvent.setup();
    renderChat();
    await divergedRow0(user);

    // The notice does not take focus when it appears — the user is mid-sentence
    // in the row it is about (WCAG 3.2.2, and the notice's own comment).
    expect(screen.getAllByLabelText("Step text")[0]).toHaveFocus();
    await user.click(screen.getByRole("button", { name: /got it/i }));

    // Asserted first, so the focus claim below cannot pass vacuously on a
    // notice that never went away.
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    // The row the notice named — kept, precisely so the words typed while
    // waiting survive — and its own eject control, which is the same action.
    expect(stepTexts()).toEqual(["First step (revised)", "Second step"]);
    expect(ejectButton(0)).toHaveFocus();
  });

  it("hands focus to the row it named, not to whichever row is first", async () => {
    // Keyed, like every other per-row record in this file. A hand-off that
    // always went to row 0 would pass the spec above and still land the user on
    // a row the notice was never about.
    const user = userEvent.setup();
    renderChat();

    const write = deferWrite();
    await user.click(ejectButton(1));
    await user.type(screen.getAllByLabelText("Step text")[1], " (revised)");
    await write.settle();
    await screen.findByRole("status");

    await user.click(screen.getByRole("button", { name: /got it/i }));

    expect(screen.queryByRole("status")).toBeNull();
    expect(stepTexts()).toEqual(["First step", "Second step (revised)"]);
    expect(ejectButton(1)).toHaveFocus();
    expect(ejectButton(0)).not.toHaveFocus();
  });

  it("falls through to Add a step when the row it named has gone too", async () => {
    // The row is kept by the `edited` branch, not pinned there: the user can
    // still delete it while the notice is up, and then there is no row control
    // to receive the hand-off.
    const user = userEvent.setup();
    renderChat();
    await divergedRow0(user);

    await user.click(screen.getAllByTitle("Remove this step")[0]);
    expect(stepTexts()).toEqual(["Second step"]);

    await user.click(screen.getByRole("button", { name: /got it/i }));

    expect(screen.queryByRole("status")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("button", { name: "Add a step" })).toHaveFocus();
  });

  it("leaves focus where it was when the press did not come from it", async () => {
    // 2.4.3 asks where focus goes when the focused control is destroyed — it
    // does not license taking focus off something else. Safari does not focus a
    // button on click, so this is the ordinary mouse case there, and yanking
    // the user out of the field they were typing in would be 3.2.2's harm.
    const user = userEvent.setup();
    renderChat();
    await divergedRow0(user);

    const field = screen.getAllByLabelText("Step text")[1];
    field.focus();
    fireEvent.click(screen.getByRole("button", { name: /got it/i }));

    expect(screen.queryByRole("status")).toBeNull();
    expect(field).toHaveFocus();
  });

  it("still resends the words after the row itself has been deleted", async () => {
    // Duo's finding 2, answered by pinning rather than by guarding. Once the row
    // is gone the notice holds the ONLY copy of those words, so a Retry that
    // refused because "the row no longer exists" would destroy them — #212's
    // harm exactly, and the notice's failure branch offers no other way out.
    const failed = deferWrite();
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));
    await failed.fail(new Error("offline"));
    await screen.findByRole("alert");

    await user.click(screen.getAllByTitle("Remove this step")[0]);
    expect(stepTexts()).toEqual(["Second step"]);

    const retried = deferWrite();
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await retried.settle();

    expect(createBrainDumpItem).toHaveBeenLastCalledWith("First step");
    // And it passes in silence: `gone` is the outcome the user asked for, so
    // there is nothing left to announce and nothing left to retry.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(stepTexts()).toEqual(["Second step"]);
  });

  it("hands focus on when that retry's own notice clears beneath it", async () => {
    // The focus half of the path above: clearing the notice unmounts the Retry
    // the user is standing on. Nothing took the deleted row's place, so the
    // landing spot is the one control that is always mounted.
    const failed = deferWrite();
    const user = userEvent.setup();
    renderChat();

    await user.click(ejectButton(0));
    await failed.fail(new Error("offline"));
    await screen.findByRole("alert");
    await user.click(screen.getAllByTitle("Remove this step")[0]);

    const retried = deferWrite();
    const retry = screen.getByRole("button", { name: /try again/i });
    await user.click(retry);
    expect(retry).toHaveFocus();
    await retried.settle();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("button", { name: "Add a step" })).toHaveFocus();
  });

  it("does not move focus when Retry becomes Got it in the same slot", async () => {
    // Not a third case, and pinned so it does not acquire a hand-off it does not
    // need: React updates the one `<button>` in place across the branch swap, so
    // the user is already standing on the control that replaced theirs.
    createBrainDumpItem.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    renderChat();
    await user.click(ejectButton(0));
    await screen.findByRole("alert");
    await user.type(screen.getAllByLabelText("Step text")[0], " (revised)");

    const retried = deferWrite();
    const retry = screen.getByRole("button", { name: /try again/i });
    await user.click(retry);
    await retried.settle();

    await screen.findByRole("status");
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("button", { name: /got it/i })).toHaveFocus();
  });
});
