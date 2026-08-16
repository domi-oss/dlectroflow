// @vitest-environment jsdom
/**
 * #238 — a re-plan silently discards edits made while it is streaming.
 *
 * A re-plan (**Fewer steps**, **More steps**, or free-text feedback) streams an
 * answer computed from a snapshot of the plan taken when the request went out,
 * and then **replaces the step list wholesale** with it. Every control that can
 * change the list is held for the duration — `disabled={busy}` — except the ones
 * inside a row, which are not held by anything. So an edit made in the seconds
 * between the press and the answer is overwritten with no notice at all: nothing
 * reaches the server and nothing is duplicated, but the user's work is gone and
 * the app never said a word about it.
 *
 * ## The five unguarded controls, and why the count matters
 *
 * #238's body names **two** (the row's step-text input and the ✕) and states
 * that "the gap is exactly two controls". It is five, and every one of them
 * routes to a state updater the answer then discards:
 *
 *   | control                    | handler                     |
 *   | -------------------------- | --------------------------- |
 *   | `EmojiPicker`              | `updateStep(subtaskEmoji)`  |
 *   | row step-text `<input>`    | `updateStep(text)`          |
 *   | `estMinutes` `<input>`     | `updateStep(estMinutes)`    |
 *   | ✕ Remove this step         | `removeStep`                |
 *   | ⠿ drag grip + row drop     | `moveStep`                  |
 *
 * The last one is in neither #238's body nor the roadmap entry that corrected
 * it, which is why this file drives all five rather than the ones a summary
 * happened to list. `replanDivergence` is unit-tested on synthetic rows
 * alongside, the shape `settledEject` uses, so the comparison can be exercised
 * without the component.
 *
 * ## What is asserted, and what is deliberately not
 *
 * The remedy is #238's third option — **let the edits happen and say so**. It is
 * the one the issue leans on and the only one consistent with the reason the row
 * controls are unheld in the first place: the row is the user's copy of their
 * own words, and a field that goes dead mid-sentence loses work just as surely
 * as one that gets overwritten (that reason is written into `ejectStep`, and
 * #212 exists because of it). So an edited row is **kept**, appended to the
 * answer, and a `role="status"` notice says the rest of the list was replaced.
 *
 * A deletion and a reorder cannot be "kept" — there is no row left to carry, and
 * the answer's rows are a fresh list with no identity mapping back to the ones
 * they replaced (that mapping is option B, and `!304`'s minted keys make it
 * possible without solving it). Those two are therefore **announced only**,
 * which is the honest half of the same answer: the user is told their change is
 * not in the new plan, rather than discovering it later.
 *
 * The last block is the control on the claim above it. "Five are unguarded" is
 * only a finding if the others are actually held, so those seven are driven
 * through the same stream window and asserted held — a zero that never queried
 * anything is not a result.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BreakdownChat,
  replanDivergence,
} from "@/components/breakdown/breakdown-chat";
import type { Proposal, StreamEvent } from "@/lib/breakdown";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/voice-provider", () => ({ useVoice: () => "plain" }));
vi.mock("@/app/actions/breakdown", () => ({
  confirmBreakdown: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/app/actions/braindump", () => ({
  createBrainDumpItem: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/app/actions/google-schedule", () => ({
  pushStepsToGoogleTasks: vi.fn().mockResolvedValue({ ok: true, scheduled: 0 }),
}));
vi.mock("@/app/actions/ics-schedule", () => ({ scheduleViaIcs: vi.fn() }));
vi.mock("@/lib/download-ics", () => ({ downloadIcs: vi.fn() }));

const proposal: Proposal = {
  parentEmoji: "🗂️",
  steps: [
    { text: "First step", estMinutes: 10, subtaskEmoji: "🌱" },
    { text: "Second step", estMinutes: 15, subtaskEmoji: "🚀" },
  ],
};

beforeEach(() => {
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

/**
 * A `/api/breakdown` re-plan whose answer is withheld until the spec releases
 * it, so the edit under test happens INSIDE the stream window.
 *
 * The answer is a **fresh two-step plan**, not an echo of the snapshot: #238 is
 * about a wholesale replacement, and rows that coincide with the ones they
 * replaced would make "was the edit kept?" unanswerable. `!304`'s sibling
 * harness (`heldReplanEchoingSnapshot` in `breakdown-chat.eject.test.tsx`) echoes
 * on purpose because that MR was about a row surviving in the snapshot; this one
 * needs the opposite.
 */
function heldReplan(
  answer: Proposal = {
    parentEmoji: "📋",
    steps: [
      { text: "Planned A", estMinutes: 20, subtaskEmoji: "🎯" },
      { text: "Planned B", estMinutes: 25, subtaskEmoji: "📝" },
    ],
  },
) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const encoder = new TextEncoder();
  const event: StreamEvent = { type: "steps", data: answer };
  const fetchMock = vi.fn(async () => {
    let delivered = false;
    return {
      body: {
        getReader: () => ({
          read: async () => {
            if (delivered) return { done: true, value: undefined };
            await held;
            delivered = true;
            return {
              done: false,
              value: encoder.encode(`${JSON.stringify(event)}\n`),
            };
          },
        }),
      },
    };
  });
  return {
    fetchMock,
    /** Let the answer land, and let React commit everything it causes. */
    release: async () => {
      release();
      // Two flushes: one for the reader's `await`, one for the state the event
      // handler raises. `findBy*` below would paper over a missing second flush.
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
    },
  };
}

const stepTexts = () =>
  screen
    .queryAllByLabelText("Step text")
    .map((el) => (el as HTMLInputElement).value);

const stepMinutes = () =>
  screen
    .queryAllByLabelText("Estimated minutes")
    .map((el) => (el as HTMLInputElement).value);

const moreSteps = () => screen.getByRole("button", { name: "More steps" });

/** The notice #238 adds: one `role="status"`, above the list. */
const replanNotice = () =>
  screen
    .queryAllByRole("status")
    .find((el) => /while you were editing/i.test(el.textContent ?? "")) ?? null;

/** Start a re-plan and leave its stream open. */
async function openStream(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => {
    fireEvent.click(moreSteps());
    await Promise.resolve();
  });
}

describe("#238 — an edit made while a re-plan streams", () => {
  it("keeps a step-text edit when the answer lands", async () => {
    renderChat();
    const { fetchMock, release } = heldReplan();
    await openStream(fetchMock);

    const user = userEvent.setup();
    await user.type(screen.getAllByLabelText("Step text")[0], " (revised)");
    expect(stepTexts()[0]).toBe("First step (revised)");

    await release();

    // The answer's own rows are there, AND the edited row survives it.
    expect(stepTexts()).toContain("First step (revised)");
    expect(stepTexts()).toContain("Planned A");
  });

  it("keeps an estimated-minutes edit when the answer lands", async () => {
    renderChat();
    const { fetchMock, release } = heldReplan();
    await openStream(fetchMock);

    fireEvent.change(screen.getAllByLabelText("Estimated minutes")[1], {
      target: { value: "45" },
    });
    expect(stepMinutes()[1]).toBe("45");

    await release();

    expect(stepMinutes()).toContain("45");
  });

  it("keeps an emoji pick when the answer lands", async () => {
    renderChat();
    const { fetchMock, release } = heldReplan();
    await openStream(fetchMock);

    const user = userEvent.setup();
    await user.click(screen.getAllByLabelText("Choose emoji")[0]);
    await user.click(screen.getByRole("option", { name: "emoji 🔥" }));

    await release();

    expect(
      screen
        .getAllByLabelText("Choose emoji")
        .map((el) => el.textContent?.trim()),
    ).toContain("🔥");
  });

  it("says so when a row deleted mid-stream comes back in the answer", async () => {
    renderChat();
    const { fetchMock, release } = heldReplan();
    await openStream(fetchMock);

    fireEvent.click(screen.getAllByLabelText("Remove this step")[0]);
    expect(stepTexts()).toEqual(["Second step"]);

    await release();

    // Nothing can carry a deletion across a wholesale replacement, so the only
    // honest remedy is to stop it being silent.
    expect(replanNotice()).not.toBeNull();
  });

  it("says so when a reorder made mid-stream is replaced by the answer", async () => {
    renderChat();
    const { fetchMock, release } = heldReplan();
    await openStream(fetchMock);

    const grip = screen.getAllByLabelText("Drag to reorder")[1];
    const rows = screen.getAllByRole("listitem");
    fireEvent.dragStart(grip);
    fireEvent.dragOver(rows[0]);
    fireEvent.drop(rows[0]);
    expect(stepTexts()).toEqual(["Second step", "First step"]);

    await release();

    expect(replanNotice()).not.toBeNull();
  });

  it("announces the replacement politely, and never inside another live region", async () => {
    renderChat();
    const { fetchMock, release } = heldReplan();
    await openStream(fetchMock);

    const user = userEvent.setup();
    await user.type(screen.getAllByLabelText("Step text")[0], " (revised)");
    await release();

    const notice = replanNotice();
    expect(notice).not.toBeNull();
    // `role="status"`, not `alert`: nothing failed. The write never happened,
    // the plan is not corrupt, and interrupting a screen reader mid-sentence
    // would overstate a divergence report (#218, and the `edited` eject notice
    // takes the same view of the same class of event).
    expect(notice).toHaveAttribute("role", "status");
    // `write-notice-hygiene` rule D: politeness inherits across the subtree, so
    // a live region inside a live region has no defined announcement. The eject
    // notice is a sibling of this one, never its ancestor.
    expect(notice!.closest("[role='alert']")).toBeNull();
    expect(notice!.parentElement?.closest("[role='status']")).toBeNull();
  });

  it("is dismissible, and hands focus on rather than dropping it to <body>", async () => {
    renderChat();
    const { fetchMock, release } = heldReplan();
    await openStream(fetchMock);

    const user = userEvent.setup();
    await user.type(screen.getAllByLabelText("Step text")[0], " (revised)");
    await release();

    const dismiss = screen.getByRole("button", { name: "Got it" });
    dismiss.focus();
    await user.click(dismiss);

    expect(replanNotice()).toBeNull();
    // WCAG 2.4.3 — the control the user was standing on has been destroyed by
    // its own press, so focus must be placed rather than left to fall to
    // <body>. Same hand-off the `edited` eject notice's "Got it" makes.
    expect(document.activeElement).not.toBe(document.body);
  });

  it("stays quiet when nothing was touched during the stream", async () => {
    renderChat();
    const { fetchMock, release } = heldReplan();
    await openStream(fetchMock);
    await release();

    // The overwhelmingly common case. A notice here would be an announcement
    // about nothing, on every single re-plan.
    expect(replanNotice()).toBeNull();
    expect(stepTexts()).toEqual(["Planned A", "Planned B"]);
  });
});

/**
 * The control on the finding above: seven siblings in this same component ARE
 * held for the stream's duration, which is what makes the five unheld ones an
 * inconsistency rather than the design.
 *
 * Driven through the same open stream, because `disabled` is a rendered fact and
 * asserting it off the source would be reading the claim rather than the
 * behaviour.
 */
describe("#238 — the controls that are correctly held while a re-plan streams", () => {
  it("holds all seven of the list-level controls", async () => {
    renderChat();
    const { fetchMock, release } = heldReplan();
    // Before the stream, so the box is still writable: "Send" also carries
    // `!freeText.trim()`, and an empty box would leave it disabled after the
    // release for a reason that has nothing to do with the stream — which would
    // make the lift-again assertion below unable to fail for the right reason.
    const user = userEvent.setup();
    await user.type(
      screen.getByPlaceholderText("Tell Claude how to adjust…"),
      "shorter please",
    );
    await openStream(fetchMock);

    const held = [
      screen.getByPlaceholderText("Tell Claude how to adjust…"),
      screen.getByRole("button", { name: "Send" }),
      screen.getByRole("button", { name: "Looks right" }),
      screen.getByRole("button", { name: "Fewer steps" }),
      screen.getByRole("button", { name: "More steps" }),
      screen.getByRole("button", { name: "Add a step" }),
      screen.getByRole("button", { name: "Remove step" }),
    ];
    for (const control of held) expect(control).toBeDisabled();

    // And they lift again, so `toBeDisabled` above is measuring the stream and
    // not some permanent state of the fixture.
    await release();
    for (const control of held) expect(control).not.toBeDisabled();
  });
});

/**
 * `replanDivergence` on synthetic rows — the pure half, exercisable without the
 * component. Same shape as `settledEject`'s specs and every hygiene module in
 * `src/lib`: a parser that can only be driven through its caller cannot be shown
 * to fail.
 */
describe("replanDivergence", () => {
  const base = [
    { key: "a", text: "One", estMinutes: 5, subtaskEmoji: "🌱" },
    { key: "b", text: "Two", estMinutes: 10, subtaskEmoji: "🚀" },
  ];

  it("reports nothing when the list is untouched", () => {
    expect(replanDivergence(base, base)).toEqual({
      kept: [],
      removed: 0,
      reordered: false,
    });
  });

  it("keeps a row whose text changed", () => {
    const now = [{ ...base[0], text: "One (revised)" }, base[1]];
    expect(replanDivergence(base, now).kept).toEqual([now[0]]);
  });

  it("keeps a row whose estimate changed", () => {
    const now = [base[0], { ...base[1], estMinutes: 45 }];
    expect(replanDivergence(base, now).kept).toEqual([now[1]]);
  });

  it("keeps a row whose emoji changed", () => {
    const now = [{ ...base[0], subtaskEmoji: "🔥" }, base[1]];
    expect(replanDivergence(base, now).kept).toEqual([now[0]]);
  });

  it("counts a removed row, and has nothing to keep for it", () => {
    const d = replanDivergence(base, [base[1]]);
    expect(d).toEqual({ kept: [], removed: 1, reordered: false });
  });

  it("sees a reorder of the same rows", () => {
    expect(replanDivergence(base, [base[1], base[0]])).toEqual({
      kept: [],
      removed: 0,
      reordered: true,
    });
  });

  it("compares by key, never by text — two rows can say the same thing", () => {
    // The trap `!304` was built to close, restated for this comparison: with the
    // words as identity, editing `b` to say what `a` says reads as "nothing
    // changed" for one row and "vanished" for the other.
    const now = [base[0], { ...base[1], text: "One" }];
    expect(replanDivergence(base, now)).toEqual({
      kept: [now[1]],
      removed: 0,
      reordered: false,
    });
  });

  it("ignores rows the answer added under fresh keys", () => {
    // Not reachable today — "Add a step" is `disabled={busy}` — but the
    // comparison must not report an unknown key as a change, or a future
    // affordance would make every re-plan announce itself.
    const now = [
      ...base,
      { key: "c", text: "New", estMinutes: 5, subtaskEmoji: "•" },
    ];
    expect(replanDivergence(base, now)).toEqual({
      kept: [],
      removed: 0,
      reordered: false,
    });
  });
});
