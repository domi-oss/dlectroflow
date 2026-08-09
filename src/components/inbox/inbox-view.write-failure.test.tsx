// @vitest-environment jsdom
/**
 * #225 — the nineteen inbox row writes that failed silently.
 *
 * Its own file rather than more of `inbox-view.test.tsx` (4300 lines already),
 * following the split `inbox-view.drag.test.tsx` and `inbox-view.hydration.test.tsx`
 * established. The mock block is duplicated because a Vitest `vi.mock` factory is
 * per-file; that is the cost of the split and it is the same cost those two pay.
 *
 * Several of these specs exist because !294 paid for them over six review rounds
 * on the identical defect on the shopping list. They are named for the lesson
 * rather than for the mechanism, so a future refactor that reintroduces the
 * mechanism fails on a sentence that says what went wrong.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  act,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { InboxView } from "@/components/inbox/inbox-view";
import type { Item } from "@/components/inbox/bucket";
import type { AgingSettings } from "@/lib/aging";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("@/app/actions/braindump", () => ({
  createBrainDumpItem: vi.fn().mockResolvedValue(undefined),
  triageBrainDumpItem: vi.fn().mockResolvedValue(undefined),
  snoozeBrainDumpItem: vi.fn().mockResolvedValue(undefined),
  deleteBrainDumpItem: vi.fn().mockResolvedValue(undefined),
  keepAsTask: vi.fn().mockResolvedValue(undefined),
  markReminded: vi.fn().mockResolvedValue(undefined),
  freshenItem: vi.fn().mockResolvedValue(undefined),
  dismissPrompt: vi.fn().mockResolvedValue(undefined),
  completeItem: vi.fn().mockResolvedValue(undefined),
  reopenItem: vi.fn().mockResolvedValue(undefined),
  moveToReview: vi.fn().mockResolvedValue(undefined),
  requestBreakdown: vi.fn().mockResolvedValue(undefined),
  ensureFocusStep: vi.fn().mockResolvedValue(null),
  renameItem: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/app/actions/breakdown", () => ({
  startBreakdown: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/app/actions/settings", () => ({
  dismissWelcome: vi.fn().mockResolvedValue(undefined),
  updateVoice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/app/actions/google-schedule", () => ({
  pushStepsToGoogleTasks: vi
    .fn()
    .mockResolvedValue({ ok: true, scheduled: 1, listTitle: "Reclaim" }),
  scheduleSingleTask: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/app/actions/ics-schedule", () => ({
  scheduleViaIcs: vi
    .fn()
    .mockResolvedValue({ ok: true, ics: "", icsFilename: "x.ics" }),
}));
vi.mock("@/lib/download-ics", () => ({ downloadIcs: vi.fn() }));

vi.mock("@/app/actions/task-notes", () => ({
  updateTaskNotes: vi
    .fn()
    .mockImplementation(async (_id: string, notes: string | null) => ({
      ok: true,
      notes,
    })),
}));
vi.mock("@/app/actions/step-notes", () => ({
  updateStepNotes: vi
    .fn()
    .mockImplementation(async (_id: string, notes: string | null) => ({
      ok: true,
      notes,
    })),
}));

vi.mock("@/lib/notifications", () => ({
  notificationPermission: () => "default",
  subscribeNotificationPermission: () => () => {},
  requestNotificationPermission: vi.fn().mockResolvedValue("default"),
  registerServiceWorker: vi.fn().mockResolvedValue(null),
  showReminder: vi.fn().mockResolvedValue(undefined),
}));

import {
  completeItem,
  deleteBrainDumpItem,
  keepAsTask,
  renameItem,
} from "@/app/actions/braindump";
import { INBOX_ACTION_TIMEOUT_MS } from "@/components/inbox/inbox-view";

const settings: AgingSettings = {
  agingThresholdMinutes: 30,
  demoOverrideSeconds: null,
  agingHours: 24,
  overdueHours: 48,
  wayOverdueHours: 72,
};

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "item-1",
    text: "sample item",
    createdAt: new Date(),
    status: "inbox",
    triagedAt: null,
    remindedAt: null,
    snoozedUntil: null,
    taskId: null,
    freshenedAt: null,
    promptDismissedAt: null,
    breakdownRequestedAt: null,
    stepsTotal: 0,
    stepsDone: 0,
    taskStatus: null,
    completedAt: null,
    scheduledAt: null,
    estMinutes: null,
    steps: [],
    ...overrides,
  };
}

/** What Next 16's client throws when the action id came from another build. */
function staleActionError() {
  return Object.assign(
    new Error(
      'Server Action "40bef5efc6c80527f80d35d95a902c7e0bc4056eb0" was not found on the server.',
    ),
    { name: "UnrecognizedActionError" },
  );
}

function renderInbox(initialItems: Item[]) {
  const view = render(
    <InboxView
      now={Date.now()}
      initialItems={initialItems}
      settings={settings}
      welcomeVisible={false}
      resumeStep={null}
    />,
  );
  return view;
}

/**
 * `fireEvent` and a fixed microtask budget rather than `userEvent`, matching the
 * #210 specs in `inbox-view.test.tsx`: two of these drive fake timers, and
 * userEvent's own timer plumbing has to be wired to them separately.
 */
async function flushTicks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Press a control by accessible name and let the write settle. */
async function press(name: RegExp) {
  await act(async () => {
    screen.getByRole("button", { name }).click();
    await flushTicks();
  });
}

const COMPLETE = /complete/i;
const RETRY = /try again/i;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(completeItem).mockReset();
  vi.mocked(completeItem).mockResolvedValue(undefined);
  vi.mocked(deleteBrainDumpItem).mockReset();
  vi.mocked(deleteBrainDumpItem).mockResolvedValue(undefined);
  vi.mocked(keepAsTask).mockReset();
  vi.mocked(keepAsTask).mockResolvedValue(undefined);
  vi.mocked(renameItem).mockReset();
  vi.mocked(renameItem).mockResolvedValue(undefined);
  refresh.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("InboxView — a row write that does not land (#225)", () => {
  it("says so, and names the item, when the write rejects", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem({ text: "water the plants" })]);

    await press(COMPLETE);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn't save that/i);
    expect(alert).toHaveTextContent(/water the plants/);
  });

  it("does not refresh the list when the write failed — there is nothing new to fetch", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem()]);

    await press(COMPLETE);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("offers Retry, and Retry re-posts the same write", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem()]);
    await press(COMPLETE);

    await press(RETRY);

    expect(vi.mocked(completeItem).mock.calls).toEqual([
      ["item-1"],
      ["item-1"],
    ]);
  });

  it("a successful Retry clears the notice and refreshes", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem()]);
    await press(COMPLETE);

    await press(RETRY);

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(refresh).toHaveBeenCalled();
  });

  /**
   * !294's round-6 finding, which is the expensive one. The shopping list keyed
   * "this write has now succeeded" on the held closure's IDENTITY, and every
   * ordinary control builds a fresh closure on every render — so only the
   * notice's own Retry could ever match. Pressing the row's own button again
   * left the stale banner up beside the write that had just landed, and its
   * Retry then re-posted the OLD call with the OLD arguments.
   */
  it("a fresh press of the row's own control clears the notice — identity is the target, not the closure", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem()]);
    await press(COMPLETE);
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    // NOT the notice's Retry: the row's own button, which is a different closure.
    await press(COMPLETE);

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("a write to a DIFFERENT row does not answer this row's failure", async () => {
    vi.mocked(completeItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    renderInbox([
      makeItem({ id: "a", text: "alpha" }),
      makeItem({ id: "b", text: "bravo" }),
    ]);

    await act(async () => {
      screen.getAllByRole("button", { name: COMPLETE })[0].click();
      await flushTicks();
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/alpha/);

    await act(async () => {
      screen.getAllByRole("button", { name: COMPLETE })[1].click();
      await flushTicks();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/alpha/);
  });

  it("a stale bundle offers a reload, never a retry that cannot work", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(staleActionError());
    renderInbox([makeItem()]);

    await press(COMPLETE);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /the app updated while this was open/i,
    );
    expect(
      screen.getByRole("button", { name: /reload the page/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
  });

  it("a write that never answers says the outcome is unknown rather than claiming failure", async () => {
    vi.useFakeTimers();
    vi.mocked(completeItem).mockReturnValueOnce(new Promise<void>(() => {}));
    renderInbox([makeItem()]);

    await act(async () => {
      screen.getByRole("button", { name: COMPLETE }).click();
      await flushTicks();
    });
    await act(async () => {
      vi.advanceTimersByTime(INBOX_ACTION_TIMEOUT_MS);
      await flushTicks();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      /no answer from the server/i,
    );
  });

  /**
   * The failure names a row the rendered list no longer holds. `initialItems`
   * comes from the dynamic page, so its losing the row IS the server saying the
   * row has gone — and a Retry that can only ever be refused again is worse than
   * no button at all.
   */
  it("withdraws Retry when the failed row is no longer in the list", async () => {
    vi.mocked(deleteBrainDumpItem).mockRejectedValueOnce(new Error("offline"));
    const { rerender } = renderInbox([makeItem({ text: "water the plants" })]);

    await press(/^delete$/i);
    await press(/^delete$/i); // the inline confirm
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // The user is standing on the Retry that is about to be taken away.
    screen.getByRole("button", { name: RETRY }).focus();

    rerender(
      <InboxView
        now={Date.now()}
        initialItems={[]}
        settings={settings}
        welcomeVisible={false}
        resumeStep={null}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      /not in your inbox any more/i,
    );
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
    // …and does not leave the user on <body> when it does. Withdrawing the
    // control the user was standing on is a context change like any other
    // unmount (WCAG 2.4.3), so the message itself takes the hand-off.
    await waitFor(() =>
      expect(screen.getByRole("alert")).toContainElement(
        document.activeElement as HTMLElement,
      ),
    );
  });
});

describe("InboxView — the double-press guard (#225)", () => {
  /**
   * The harm this exists for is specific: a failed write is indistinguishable
   * from a press that did not register, so the natural response is to press
   * again. `keepAsTask` is the one where that costs data — it CREATES a Task and
   * then points the item at it, so two in flight leave an orphaned Task row that
   * nothing can reach.
   */
  it("absorbs a second press at the same target while the first is still in flight", async () => {
    let settle!: () => void;
    vi.mocked(keepAsTask).mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        settle = () => resolve(undefined);
      }),
    );
    renderInbox([makeItem()]);

    await act(async () => {
      screen.getByRole("button", { name: /add to-?do/i }).click();
      await flushTicks();
    });
    await act(async () => {
      screen.getByRole("button", { name: /add to-?do/i }).click();
      await flushTicks();
    });

    expect(vi.mocked(keepAsTask)).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle();
      await flushTicks();
    });
  });

  it("does not block a press on a different row", async () => {
    let settle!: () => void;
    vi.mocked(completeItem)
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      )
      .mockResolvedValue(undefined);
    renderInbox([makeItem({ id: "a" }), makeItem({ id: "b" })]);

    await act(async () => {
      screen.getAllByRole("button", { name: COMPLETE })[0].click();
      await flushTicks();
    });
    await act(async () => {
      screen.getAllByRole("button", { name: COMPLETE })[1].click();
      await flushTicks();
    });

    expect(vi.mocked(completeItem).mock.calls).toEqual([["a"], ["b"]]);
    await act(async () => {
      settle();
      await flushTicks();
    });
  });

  it("the notice's Retry cannot be double-fired either", async () => {
    let settle!: () => void;
    vi.mocked(completeItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );
    renderInbox([makeItem()]);
    await press(COMPLETE);

    await act(async () => {
      screen.getByRole("button", { name: RETRY }).click();
      await flushTicks();
    });
    await act(async () => {
      screen.getByRole("button", { name: RETRY }).click();
      await flushTicks();
    });

    expect(vi.mocked(completeItem)).toHaveBeenCalledTimes(2);
    await act(async () => {
      settle();
      await flushTicks();
    });
  });
});

/**
 * Every live region in a tree that has another live region as an ancestor.
 *
 * A polite live region nested inside an assertive one is not reliably handled:
 * the outer region's `aria-live` applies to the whole subtree, so whether the
 * inner text is announced politely, assertively, twice, or not at all is
 * implementation-dependent. The failure has no visual symptom, which is how it
 * reached `main` in the first place and why `!290` had to catch itself copying
 * the shape.
 *
 * Here as a constraint on the NEW notice this MR adds, not as a fix to anything:
 * a second notice modelled on the first is exactly how the shape spreads. A
 * detector rather than a handful of `querySelector` assertions, so it covers
 * whatever the inbox renders — including the note field, the schedule menu and
 * the step list, which are other components mounted inside these rows — instead
 * of only the nodes somebody remembered to look at.
 */
const LIVE_REGION =
  '[role="status"],[role="alert"],[role="log"],[aria-live]:not([aria-live="off"])';

function nestedLiveRegions(root: ParentNode): Element[] {
  return [...root.querySelectorAll(LIVE_REGION)].filter(
    (el) => el.parentElement?.closest(LIVE_REGION) != null,
  );
}

describe("nestedLiveRegions (the detector itself)", () => {
  /**
   * Built with DOM calls rather than `innerHTML`: the string form is a
   * hard-coded literal and could not carry untrusted input, but it trips the
   * scanners' XSS rule anyway, and a finding that has to be dismissed every
   * pipeline is a worse trade than four extra lines.
   */
  function node(
    tag: string,
    attrs: Record<string, string>,
    text?: string,
  ): HTMLElement {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text !== undefined) el.textContent = text;
    return el;
  }

  /**
   * A guard reporting zero is only worth something if the same query returns
   * non-zero somewhere. Two shapes, because the attribute form and the role form
   * are the two ways the repo writes a live region.
   */
  it("finds a polite region nested inside an assertive one", () => {
    const root = document.createElement("div");
    const outer = node("div", { role: "alert" });
    outer.append(
      node("p", {}, "reason"),
      node("p", { role: "status" }, "trying again"),
    );
    root.append(outer);

    expect(nestedLiveRegions(root).map((el) => el.textContent)).toEqual([
      "trying again",
    ]);
  });

  it("finds the aria-live spelling too, and passes genuine siblings", () => {
    const root = document.createElement("div");
    const outer = node("div", { "aria-live": "assertive" });
    outer.append(node("span", { "aria-live": "polite" }, "inner"));
    root.append(outer, node("div", { role: "status" }, "sibling"));

    expect(nestedLiveRegions(root).map((el) => el.textContent)).toEqual([
      "inner",
    ]);
  });
});

describe("InboxView — the write notice's accessibility (#225)", () => {
  /**
   * `!290` established the correct pattern for the capture notice and this MR
   * adds a second notice beside it, so the risk worth guarding is the shape
   * spreading rather than any existing instance. Asserted over the whole
   * rendered tree, in the state that has the most live regions mounted at once.
   */
  it("mounts no live region inside another, anywhere in the inbox", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(new Error("offline"));
    const { container } = renderInbox([
      makeItem({ id: "a", text: "water the plants" }),
      makeItem({
        id: "b",
        text: "plan trip",
        status: "triaged",
        taskId: "t1",
        stepsTotal: 2,
        stepsDone: 1,
      }),
      makeItem({ id: "c", text: "old thing", completedAt: new Date() }),
    ]);

    // The two notices, the "captured ✓" confirmation and the drag/move
    // announcement region can all be on screen at once; put the write notice up
    // and check the whole document, since the notice is rendered in place rather
    // than portalled.
    await act(async () => {
      screen.getAllByRole("button", { name: COMPLETE })[0].click();
      await flushTicks();
    });
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    // Assert the tree HAS live regions before asserting none of them nest —
    // otherwise a render that mounted none at all would report the same clean
    // zero as a render that got it right.
    expect(
      container.querySelectorAll(LIVE_REGION).length,
    ).toBeGreaterThanOrEqual(2);
    expect(nestedLiveRegions(container).map((el) => el.outerHTML)).toEqual([]);
  });

  it("carries the retry's wait on the button rather than nesting a live region", async () => {
    let settle!: () => void;
    vi.mocked(completeItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );
    renderInbox([makeItem()]);
    await press(COMPLETE);

    const notice = screen.getByRole("alert");
    await act(async () => {
      screen.getByRole("button", { name: RETRY }).click();
      await flushTicks();
    });

    expect(notice.querySelector('[role="status"]')).toBeNull();
    const retry = screen.getByRole("button", { name: RETRY });
    const described = (retry.getAttribute("aria-describedby") ?? "").split(" ");
    const waitText = described
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(waitText).toMatch(/saving/i);

    await act(async () => {
      settle();
      await flushTicks();
    });
  });

  it("keeps Retry in the tab order while it is busy (aria-disabled, not disabled)", async () => {
    let settle!: () => void;
    vi.mocked(completeItem)
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );
    renderInbox([makeItem()]);
    await press(COMPLETE);

    await act(async () => {
      screen.getByRole("button", { name: RETRY }).click();
      await flushTicks();
    });

    const retry = screen.getByRole("button", { name: RETRY });
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).not.toBeDisabled();

    await act(async () => {
      settle();
      await flushTicks();
    });
  });

  /**
   * The notice is one slot at the top of a list that scrolls, so a sighted user
   * standing on a row far down would otherwise never see it. Moving focus is what
   * puts the message AND the focused control on screen together — the browser
   * scrolls a focused element into view, and leaving focus on an off-screen
   * control would fail WCAG 2.4.7 as well as hiding the error.
   */
  it("moves focus to the notice so the message and the focus ring are on screen together", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem()]);

    const trigger = screen.getByRole("button", { name: COMPLETE });
    trigger.focus();
    await act(async () => {
      trigger.click();
      await flushTicks();
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: RETRY })).toHaveFocus(),
    );
  });

  it("hands focus back to the control that started the write once it lands", async () => {
    vi.mocked(completeItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem()]);

    const trigger = screen.getByRole("button", { name: COMPLETE });
    trigger.focus();
    await act(async () => {
      trigger.click();
      await flushTicks();
    });
    await press(RETRY);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: COMPLETE })).toHaveFocus(),
    );
  });

  /**
   * The capture field is where the user is typing, and #210 argues at length that
   * the capture notice must not steal focus from it. A row write is the opposite
   * case — the press came from a button — but the guard has to hold when the two
   * overlap: if the user has moved focus since pressing, the notice does not take it.
   */
  it("does not steal focus from wherever the user moved it while the write was in flight", async () => {
    let reject!: (reason: unknown) => void;
    vi.mocked(completeItem).mockReturnValueOnce(
      new Promise<void>((_, r) => {
        reject = r;
      }),
    );
    renderInbox([makeItem()]);

    const trigger = screen.getByRole("button", { name: COMPLETE });
    trigger.focus();
    await act(async () => {
      trigger.click();
      await flushTicks();
    });

    const capture = screen.getByPlaceholderText(/Brain dump/i);
    capture.focus();
    await act(async () => {
      reject(new Error("offline"));
      await flushTicks();
    });

    expect(capture).toHaveFocus();
  });
});

describe("InboxView — a failed rename (#225)", () => {
  it("quotes the NEW words, which are the ones at stake", async () => {
    vi.mocked(renameItem).mockRejectedValueOnce(new Error("offline"));
    renderInbox([makeItem({ text: "old title" })]);

    await act(async () => {
      screen.getByRole("button", { name: /edit old title/i }).click();
      await flushTicks();
    });
    const editor = screen.getByDisplayValue("old title");
    fireEvent.change(editor, { target: { value: "new title" } });
    await act(async () => {
      fireEvent.keyDown(editor, { key: "Enter" });
      await flushTicks();
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/new title/);
  });
});
