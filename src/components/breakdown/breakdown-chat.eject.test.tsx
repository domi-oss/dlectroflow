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
  ejectedStepIndex,
} from "@/components/breakdown/breakdown-chat";
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
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ body: null }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderChat() {
  return render(
    <BreakdownChat
      taskId="task-1"
      title="Plan the party"
      initialProposal={proposal}
      google={{ configured: false, connected: false, needsReconnect: false }}
    />,
  );
}

const stepTexts = () =>
  screen
    .queryAllByLabelText("Step text")
    .map((el) => (el as HTMLInputElement).value);

/** The first row's eject control, whichever state it is in. */
const ejectButton = (n = 0) =>
  screen.getAllByTitle(
    "Send back to the inbox as its own item to re-break-down",
  )[n];

describe("ejectedStepIndex — which row a settled eject is about", () => {
  const steps = (...texts: string[]) =>
    texts.map((text) => ({ text, estMinutes: 5, subtaskEmoji: "🌱" }));

  it("prefers the row the press came from", () => {
    expect(ejectedStepIndex(steps("a", "b", "a"), "a", 2)).toBe(2);
  });

  it("falls back to the first row that still says those words", () => {
    // The hint is stale — the user reordered or deleted rows while the write was
    // in flight — so the index is re-derived from the words rather than trusted.
    expect(ejectedStepIndex(steps("b", "a"), "a", 0)).toBe(1);
  });

  it("compares trimmed text, because that is what was sent", () => {
    expect(ejectedStepIndex(steps("  a  "), "a", null)).toBe(0);
  });

  it("removes nothing when no row says those words any more", () => {
    // The user deleted the row themselves while the write was outstanding.
    // Removing some other row would be the data loss this fix exists to stop.
    expect(ejectedStepIndex(steps("b", "c"), "a", 0)).toBe(-1);
  });

  it("removes nothing from an empty list", () => {
    expect(ejectedStepIndex([], "a", 0)).toBe(-1);
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
