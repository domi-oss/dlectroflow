// @vitest-environment jsdom
/**
 * #238 — a re-plan used to silently discard edits made while it was streaming.
 *
 * A re-plan (**Fewer steps**, **More steps**, or free-text feedback) streams an
 * answer computed from a snapshot of the plan taken when the request went out,
 * and then **replaces the step list wholesale** with it. Every control around
 * the list was held for the duration — `disabled={busy}` — but the five inside a
 * row were held by nothing, so an edit made in the seconds between the press and
 * the answer was overwritten with no notice at all. Nothing reached the server
 * and nothing was duplicated; the loss was confined to the stream window, which
 * is exactly why it was silent.
 *
 * ## The five, and why the count is part of the fix
 *
 * #238's body names **two** and states that "the gap is exactly two controls",
 * warning that an earlier summary got it wrong. It is five, and all five sit
 * inside the same `<li>`:
 *
 *   | control                    | handler                     |
 *   | -------------------------- | --------------------------- |
 *   | ⠿ drag grip + row drop     | `moveStep`                  |
 *   | `EmojiPicker`              | `updateStep(subtaskEmoji)`  |
 *   | row step-text `<input>`    | `updateStep(text)`          |
 *   | `estMinutes` `<input>`     | `updateStep(estMinutes)`    |
 *   | ✕ Remove this step         | `removeStep`                |
 *
 * The drag grip is in neither the issue body nor the roadmap entry that
 * corrected it, which is why this file drives all five rather than the ones a
 * summary happened to list. The sharpest evidence that this was an oversight
 * rather than a design: the ✕ is the immediate next sibling of "Back to inbox",
 * which has waited for the plan since `!304`.
 *
 * ## What is asserted
 *
 * **The controls are frozen for the stream's duration** — the owner's decision,
 * taken over the two alternatives with its cost stated: the editor feels dead
 * for the few seconds the answer takes. So these specs assert the edit is
 * **impossible**, not that it is preserved. An earlier revision of this file
 * asserted the latter, against a merge-and-announce implementation that was
 * built and then replaced by that decision.
 *
 * The freeze rides the same `busy` the seven surrounding controls already use,
 * so the whole editor now waits on one fact and lifts on one event.
 *
 * Three things carry as much weight as the freeze itself:
 *
 *   - **Everything lifts again**, on the failure and fallback paths as well as
 *     the happy one. A control frozen forever by an errored stream is a worse
 *     bug than the one being fixed.
 *   - **The reason is reachable.** The ✕ keeps `aria-disabled` rather than
 *     `disabled` precisely so it stays focusable and can carry the explanation
 *     for the whole row; the other four leave the tab order.
 *   - **The eject guarantee is untouched.** A row still keeps the user's words
 *     while its own write is in the air. That is #212's written decision on a
 *     different code path, and freezing is scoped to the re-plan stream.
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
import { BreakdownChat } from "@/components/breakdown/breakdown-chat";
import { t } from "@/lib/strings";
import type { Proposal, StreamEvent } from "@/lib/breakdown";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/voice-provider", () => ({ useVoice: () => "plain" }));
vi.mock("@/app/actions/breakdown", () => ({
  confirmBreakdown: vi.fn().mockResolvedValue(undefined),
}));
const { createBrainDumpItem } = vi.hoisted(() => ({
  createBrainDumpItem: vi.fn(),
}));
vi.mock("@/app/actions/braindump", () => ({ createBrainDumpItem }));
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
  // #168's hazard: `vi.clearAllMocks()` resets calls but NOT implementations,
  // so a deferred write set by one spec would leak into the next.
  createBrainDumpItem.mockReset();
  createBrainDumpItem.mockResolvedValue(undefined);
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

const ANSWER: Proposal = {
  parentEmoji: "📋",
  steps: [
    { text: "Planned A", estMinutes: 20, subtaskEmoji: "🎯" },
    { text: "Planned B", estMinutes: 25, subtaskEmoji: "📝" },
  ],
};

/**
 * A `/api/breakdown` re-plan whose answer is withheld until the spec releases
 * it, so every assertion below happens INSIDE the stream window.
 *
 * The answer is a fresh plan rather than an echo of the snapshot: #238 is about
 * a wholesale replacement, and rows that coincided with the ones they replaced
 * would make "did the edit survive?" unanswerable. `!304`'s sibling harness
 * (`heldReplanEchoingSnapshot`) echoes on purpose, because that MR was about a
 * row surviving IN the snapshot; this one needs the opposite.
 */
function heldReplan(event: StreamEvent = { type: "steps", data: ANSWER }) {
  let release!: () => void;
  let fail!: (e: unknown) => void;
  const held = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const encoder = new TextEncoder();
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
  // Two flushes: one for the reader's `await`, one for the state its event
  // raises. A single flush would leave assertions racing the second commit.
  const settle = async (run: () => void) => {
    run();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  };
  return {
    fetchMock,
    release: () => settle(release),
    /** The stream dies mid-flight — the path that must still lift the hold. */
    fail: () => settle(() => fail(new Error("stream died"))),
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

const rowText = (n = 0) => screen.getAllByLabelText("Step text")[n];
const rowMinutes = (n = 0) => screen.getAllByLabelText("Estimated minutes")[n];
const rowEmoji = (n = 0) => screen.getAllByLabelText("Choose emoji")[n];
const rowRemove = (n = 0) => screen.getAllByLabelText("Remove this step")[n];
const rowGrip = (n = 0) => screen.getAllByLabelText("Drag to reorder")[n];

/** Start a re-plan and leave its stream open. */
async function openStream(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "More steps" }));
    await Promise.resolve();
  });
}

describe("#238 — the five row controls are held while a re-plan streams", () => {
  it("freezes the step-text input, so the edit cannot be made at all", async () => {
    renderChat();
    const { fetchMock, release } = heldReplan();
    await openStream(fetchMock);

    expect(rowText(0)).toBeDisabled();
    // Driven, not merely inspected: `disabled` is the mechanism, the guarantee
    // is that the value does not move. Through `userEvent`, which honours
    // `disabled` the way a browser does — `fireEvent.change` dispatches
    // straight at the node and lands on a disabled input, so it would pass
    // against no fix at all.
    const user = userEvent.setup();
    await user.type(rowText(0), "typed anyway");
    expect(stepTexts()[0]).toBe("First step");

    await release();
    expect(stepTexts()).toEqual(["Planned A", "Planned B"]);
  });

  it("freezes the estimated-minutes input", async () => {
    renderChat();
    const { fetchMock, release } = heldReplan();
    await openStream(fetchMock);

    expect(rowMinutes(1)).toBeDisabled();
    const user = userEvent.setup();
    await user.type(rowMinutes(1), "45");
    expect(stepMinutes()[1]).toBe("15");

    await release();
    expect(stepMinutes()).toEqual(["20", "25"]);
  });

  it("freezes the emoji picker, and does not leave a live grid over a held trigger", async () => {
    renderChat();
    const { fetchMock, release } = heldReplan();
    await openStream(fetchMock);

    expect(rowEmoji(0)).toBeDisabled();
    // The popover must be gone as well as the trigger held — a grid floating
    // over a disabled swatch is a control that is unavailable and operable at
    // the same time.
    expect(screen.queryByRole("listbox", { name: "Emoji" })).toBeNull();

    await release();
    expect(rowEmoji(0)).not.toBeDisabled();
  });

  it("refuses the ✕ press without dropping the user to <body>", async () => {
    renderChat();
    const { fetchMock, release } = heldReplan();
    await openStream(fetchMock);

    const remove = rowRemove(0);
    expect(remove).toHaveAttribute("aria-disabled", "true");
    // `aria-disabled`, not `disabled`: it must still take focus, or the reason
    // it carries for the whole row is unreachable (WCAG 2.4.3, and the same
    // call "Back to inbox" beside it makes).
    remove.focus();
    expect(remove).toHaveFocus();

    const user = userEvent.setup();
    await user.click(remove);
    expect(stepTexts()).toEqual(["First step", "Second step"]);

    await release();
    expect(rowRemove(0)).toHaveAttribute("aria-disabled", "false");
  });

  it("freezes the drag grip at both ends of the drag", async () => {
    renderChat();
    const { fetchMock, release } = heldReplan();
    await openStream(fetchMock);

    expect(rowGrip(1)).toHaveAttribute("draggable", "false");
    expect(rowGrip(1)).toHaveAttribute("aria-disabled", "true");

    // Both ends. Guarding only the grip would let a drag STARTED before the
    // stream land after it — `dragIndex` survives, and the drop is what calls
    // `moveStep`.
    const rows = screen.getAllByRole("listitem");
    fireEvent.dragStart(rowGrip(1));
    fireEvent.dragOver(rows[0]);
    fireEvent.drop(rows[0]);
    expect(stepTexts()).toEqual(["First step", "Second step"]);

    await release();
    expect(rowGrip(1)).toHaveAttribute("draggable", "true");
  });

  it("says why, on the one control in the row that can still be focused", async () => {
    renderChat();
    const { fetchMock, release } = heldReplan();
    await openStream(fetchMock);

    // The reason has to RESOLVE — an `aria-describedby` pointing at nothing is
    // the failure this is guarding, so reading the text through the id is the
    // assertion. One paragraph for every control the same event holds, which is
    // `breakdown.ejectHeld`'s rule applied to the hold pointing this way.
    const id = rowRemove(0).getAttribute("aria-describedby");
    expect(id).not.toBeNull();
    const reason = document.getElementById(id!)?.textContent ?? "";
    expect(reason).toBe(t("breakdown.planHeld", "plain"));
    // It names both consequences: the edit that cannot be overwritten, and the
    // step that cannot land in two places.
    expect(reason).toMatch(/land on top of an edit/i);

    await release();
    expect(rowRemove(0).getAttribute("aria-describedby")).toBeNull();
  });
});

describe("#238 — the hold lifts on every path out of the stream", () => {
  /** Everything the editor holds, row controls and their seven siblings. */
  const frozen = () => [
    rowText(0),
    rowText(1),
    rowMinutes(0),
    rowMinutes(1),
    rowEmoji(0),
    rowEmoji(1),
    screen.getByPlaceholderText("Tell Claude how to adjust…"),
    screen.getByRole("button", { name: "Send" }),
    screen.getByRole("button", { name: "Looks right" }),
    screen.getByRole("button", { name: "Fewer steps" }),
    screen.getByRole("button", { name: "More steps" }),
    screen.getByRole("button", { name: "Add a step" }),
    screen.getByRole("button", { name: "Remove step" }),
  ];

  /** Typed first, so "Send" is not left disabled by its own empty-box clause. */
  async function primeFeedbackBox() {
    const user = userEvent.setup();
    await user.type(
      screen.getByPlaceholderText("Tell Claude how to adjust…"),
      "shorter please",
    );
  }

  it("holds all thirteen during the stream and releases all thirteen after", async () => {
    renderChat();
    await primeFeedbackBox();
    const { fetchMock, release } = heldReplan();
    await openStream(fetchMock);

    for (const control of frozen()) expect(control).toBeDisabled();
    expect(rowRemove(0)).toHaveAttribute("aria-disabled", "true");
    expect(rowGrip(0)).toHaveAttribute("draggable", "false");

    await release();

    for (const control of frozen()) expect(control).not.toBeDisabled();
    expect(rowRemove(0)).toHaveAttribute("aria-disabled", "false");
    expect(rowGrip(0)).toHaveAttribute("draggable", "true");
  });

  it("releases everything when the stream dies, rather than freezing the editor forever", async () => {
    renderChat();
    await primeFeedbackBox();
    const { fetchMock, fail } = heldReplan();
    await openStream(fetchMock);
    for (const control of frozen()) expect(control).toBeDisabled();

    await fail();

    // The plan is unchanged, so every row is once again the only copy of its
    // words — an editor still frozen here is a worse bug than the one #238 is.
    for (const control of frozen()) expect(control).not.toBeDisabled();
    expect(rowRemove(0)).toHaveAttribute("aria-disabled", "false");
    expect(stepTexts()).toEqual(["First step", "Second step"]);
    // And the edit that was refused a moment ago now lands.
    fireEvent.change(rowText(0), { target: { value: "First step, edited" } });
    expect(stepTexts()[0]).toBe("First step, edited");
  });

  it("releases everything on a fallback plan too", async () => {
    renderChat();
    await primeFeedbackBox();
    // The provider gave up and the server sent a hand-built starter plan. It
    // arrives down the same stream and replaces the list just as wholesale,
    // after a window that is usually LONGER — it is sent only once the attempt
    // has failed.
    const { fetchMock, release } = heldReplan({
      type: "fallback",
      reason: "quota",
      data: {
        parentEmoji: "🗂️",
        steps: [{ text: "Starter step", estMinutes: 10, subtaskEmoji: "•" }],
      },
    });
    await openStream(fetchMock);
    for (const control of frozen()) expect(control).toBeDisabled();

    await release();

    expect(stepTexts()).toEqual(["Starter step"]);
    expect(rowText(0)).not.toBeDisabled();
    expect(rowRemove(0)).toHaveAttribute("aria-disabled", "false");
  });
});

/**
 * #212's guarantee, re-asserted from #238's side.
 *
 * The freeze is scoped to the re-plan stream and must not reach the eject path,
 * where the row deliberately stays editable while its own write is in the air —
 * the row is the only copy of those words, and taking the field away would be
 * #212's own data loss with the hands swapped. `!304` owns the full set; this is
 * the one spec that would catch #238's fix over-reaching into it.
 */
describe("#238 does not freeze a row during its own eject", () => {
  it("leaves the step text editable while the eject write is outstanding", async () => {
    // Held open, or the write resolves and takes the row with it before there
    // is anything to type into — which is the state #212's remedy is about.
    let settle!: () => void;
    createBrainDumpItem.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    renderChat();
    const user = userEvent.setup();
    await user.click(
      screen.getAllByTitle(
        "Send back to the inbox as its own item to re-break-down",
      )[0],
    );
    expect(createBrainDumpItem).toHaveBeenCalledWith("First step");

    // No re-plan is in flight, so nothing here is held: the words the user
    // types while they wait are the whole point of #212's remedy, and #238's
    // freeze must not reach this path.
    expect(rowText(0)).not.toBeDisabled();
    expect(rowMinutes(0)).not.toBeDisabled();
    expect(rowEmoji(0)).not.toBeDisabled();
    await user.type(rowText(0), " (revised)");
    expect(stepTexts()[0]).toBe("First step (revised)");

    await act(async () => {
      settle();
      await Promise.resolve();
    });
  });
});
